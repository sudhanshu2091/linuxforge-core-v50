import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "runtime" / "qemu-runtime.py"
spec = importlib.util.spec_from_file_location("linuxforge_qemu_runtime", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class V49RuntimeTests(unittest.TestCase):
    def test_safe_id_rejects_paths(self):
        with self.assertRaises(ValueError):
            module.safe_id("../../host")

    def test_shell_quote(self):
        value = "a'b"
        self.assertEqual(module.shell_quote(value), "'a'\\''b'")

    def test_execution_record_is_real_provider(self):
        env = module.Environment(
            environmentId="env1", userId="user1", labId="lab1", status="RUNNING", imageRef="kali@sha256:" + "a" * 64,
            diskPath="/tmp/disk", seedPath="/tmp/seed", sshKeyPath="/tmp/key", sshPublicKeyPath="/tmp/key.pub",
            qemuPid=None, sshPort=2222, createdAt=module.now_iso(), updatedAt=module.now_iso(), snapshotId=None,
            cpus=2, memoryMiB=2048, storageMiB=20480, network="none",
        )
        record = module.execution_record(env, "bash", "pwd", "/home/linuxforge", "/home/linuxforge", "/home/linuxforge\n", "", 0, 12, {"processes": [], "listeners": []})
        self.assertEqual(record["provider"], "real-linux-isolated-v1")
        self.assertFalse(record["metadata"]["modelled"] == "true")

    def test_disk_resize_never_shrinks_existing_backing_image(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = module.RuntimeManager()
            disk = Path(directory) / "root.qcow2"
            calls = []

            def fake_run(cmd, *args, **kwargs):
                calls.append(cmd)
                if cmd[:3] == ["qemu-img", "info", "--output=json"]:
                    return mock.Mock(stdout=json.dumps({"virtual-size": 25 * 1024 * 1024 * 1024}))
                raise AssertionError(f"unexpected command: {cmd}")

            with mock.patch.object(module, "run", side_effect=fake_run):
                effective = manager._ensure_disk_size(disk, 20 * 1024)

            self.assertEqual(effective, 25 * 1024)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][:3], ["qemu-img", "info", "--output=json"])

    def test_disk_resize_grows_when_requested_size_is_larger(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = module.RuntimeManager()
            disk = Path(directory) / "root.qcow2"
            calls = []

            def fake_run(cmd, *args, **kwargs):
                calls.append(cmd)
                if cmd[:3] == ["qemu-img", "info", "--output=json"]:
                    return mock.Mock(stdout=json.dumps({"virtual-size": 25 * 1024 * 1024 * 1024}))
                if cmd[:2] == ["qemu-img", "resize"]:
                    return mock.Mock(stdout="")
                raise AssertionError(f"unexpected command: {cmd}")

            with mock.patch.object(module, "run", side_effect=fake_run):
                effective = manager._ensure_disk_size(disk, 30 * 1024)

            self.assertEqual(effective, 30 * 1024)
            self.assertEqual(calls[1], ["qemu-img", "resize", str(disk), "30720M"])

    def test_aarch64_uses_uefi_code_without_persistent_nvram(self):
        source = MODULE_PATH.read_text()
        self.assertIn("FORGE_QEMU_UEFI_CODE", source)
        self.assertIn('cmd += ["-bios", uefi_code]', source)
        self.assertNotIn("FORGE_QEMU_UEFI_VARS_TEMPLATE", source)
        self.assertNotIn('if=pflash,format=raw,unit=1', source)
        self.assertNotIn('edk2-arm-vars.fd', source)
        self.assertIn('cmd += ["-boot", "order=c,menu=off"]', source)
        self.assertIn('if=virtio,format=qcow2,cache=none,aio=threads', source)
        self.assertNotIn('boot=on', source)
        self.assertNotIn('virtio-blk-pci,drive=lfdisk,bootindex=1', source)
        self.assertIn('media=cdrom,readonly=on,format=raw', source)
        self.assertIn('shutil.copy2(self.base_image, disk)', source)

    def test_cloud_init_grants_guest_sudo_while_preserving_host_isolation(self):
        source = MODULE_PATH.read_text()
        self.assertIn("groups: [sudo, users]", source)
        self.assertIn("NOPASSWD:ALL", source)
        self.assertIn("lock_passwd: true", source)
        # Verify host isolation invariants are preserved
        self.assertNotIn("-virtfs", source)
        self.assertIn("restrict=on", source)

    def test_data_directory_can_be_created(self):
        with tempfile.TemporaryDirectory() as directory:
            old = os.environ.get("FORGE_RUNTIME_DATA_DIR")
            try:
                os.environ["FORGE_RUNTIME_DATA_DIR"] = directory
                manager = module.RuntimeManager()
                self.assertTrue(Path(directory).exists())
                self.assertEqual(manager.max_environments, 8)
            finally:
                if old is None:
                    os.environ.pop("FORGE_RUNTIME_DATA_DIR", None)
                else:
                    os.environ["FORGE_RUNTIME_DATA_DIR"] = old

    def test_stale_running_pid_is_reconciled_to_error(self):
        with tempfile.TemporaryDirectory() as directory:
            old = os.environ.get("FORGE_RUNTIME_DATA_DIR")
            try:
                os.environ["FORGE_RUNTIME_DATA_DIR"] = directory
                manager = module.RuntimeManager()
                env = module.Environment(
                    environmentId="stale", userId="user1", labId="lab1", status="RUNNING", imageRef="kali-2026.2-arm64",
                    diskPath="/tmp/disk", seedPath="/tmp/seed", sshKeyPath="/tmp/key", sshPublicKeyPath="/tmp/key.pub",
                    qemuPid=987654, sshPort=2222, createdAt=module.now_iso(), updatedAt=module.now_iso(), snapshotId=None,
                    cpus=2, memoryMiB=2048, storageMiB=20480, network="none", qemuLogPath=str(Path(directory) / "stale" / "qemu.log"),
                )
                manager._envs["stale"] = env
                manager._persist(env)
                with mock.patch.object(module.RuntimeManager, "_pid_is_expected_qemu", return_value=False):
                    manager._reconcile_processes_once()
                self.assertEqual(env.status, "ERROR")
                self.assertIsNone(env.qemuPid)
                self.assertIn("stale RUNNING state", env.error or "")
                saved = json.loads((Path(directory) / "stale" / "state.json").read_text())
                self.assertEqual(saved["status"], "ERROR")
            finally:
                if old is None:
                    os.environ.pop("FORGE_RUNTIME_DATA_DIR", None)
                else:
                    os.environ["FORGE_RUNTIME_DATA_DIR"] = old

    def test_qemu_exit_is_persisted_and_not_left_running(self):
        class DeadProcess:
            pid = 4321
            def poll(self):
                return 17

        with tempfile.TemporaryDirectory() as directory:
            old = os.environ.get("FORGE_RUNTIME_DATA_DIR")
            try:
                os.environ["FORGE_RUNTIME_DATA_DIR"] = directory
                manager = module.RuntimeManager()
                env = module.Environment(
                    environmentId="dead", userId="user1", labId="lab1", status="RUNNING", imageRef="kali-2026.2-arm64",
                    diskPath="/tmp/disk", seedPath="/tmp/seed", sshKeyPath="/tmp/key", sshPublicKeyPath="/tmp/key.pub",
                    qemuPid=4321, sshPort=2223, createdAt=module.now_iso(), updatedAt=module.now_iso(), snapshotId=None,
                    cpus=2, memoryMiB=2048, storageMiB=20480, network="none", qemuLogPath=str(Path(directory) / "dead" / "qemu.log"),
                )
                manager._envs["dead"] = env
                manager._processes["dead"] = DeadProcess()
                manager._reconcile_processes_once()
                self.assertEqual(env.status, "ERROR")
                self.assertEqual(env.qemuExitCode, 17)
                self.assertIsNone(env.qemuPid)
                self.assertIn("exited unexpectedly", env.error or "")
                saved = json.loads((Path(directory) / "dead" / "state.json").read_text())
                self.assertEqual(saved["qemuExitCode"], 17)
            finally:
                if old is None:
                    os.environ.pop("FORGE_RUNTIME_DATA_DIR", None)
                else:
                    os.environ["FORGE_RUNTIME_DATA_DIR"] = old

    def test_qemu_output_is_not_discarded(self):
        source = MODULE_PATH.read_text()
        self.assertNotIn("stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL", source)
        self.assertIn("qemu.log", source)
        self.assertIn("stderr=subprocess.STDOUT", source)

    def test_pid_identity_requires_the_environment_disk(self):
        env = module.Environment(
            environmentId="env1", userId="user1", labId="lab1", status="RUNNING", imageRef="kali-2026.2-arm64",
            diskPath="/tmp/linuxforge/env1/root.qcow2", seedPath="/tmp/seed", sshKeyPath="/tmp/key", sshPublicKeyPath="/tmp/key.pub",
            qemuPid=1234, sshPort=2222, createdAt=module.now_iso(), updatedAt=module.now_iso(), snapshotId=None,
            cpus=2, memoryMiB=2048, storageMiB=20480, network="none",
        )
        with mock.patch.object(module.RuntimeManager, "_pid_alive", return_value=True), \
             mock.patch.object(module.subprocess, "run", return_value=mock.Mock(stdout="qemu-system-aarch64 -drive file=/tmp/other/root.qcow2\n")):
            self.assertFalse(module.RuntimeManager._pid_is_expected_qemu(1234, env))


    def test_guest_packages_endpoint(self) -> None:
        mgr = module.RuntimeManager()
        with mock.patch.object(mgr, "_get", return_value=mock.Mock()), \
             mock.patch.object(mgr, "ssh", return_value=(0, "bash\t5.2.15-2+b7\tinstall ok installed\ncoreutils\t9.1-1\tinstall ok installed\n", "")):
            res = mgr.packages("mock-env-id", ["bash", "coreutils"])
            self.assertTrue(res.get("supported"))
            self.assertEqual(res.get("packageManager"), "dpkg")
            self.assertEqual(len(res.get("packages")), 2)
            self.assertEqual(res["packages"][0]["name"], "bash")

if __name__ == "__main__":
    unittest.main()
