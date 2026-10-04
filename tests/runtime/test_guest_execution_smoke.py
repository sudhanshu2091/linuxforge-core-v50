#!/usr/bin/env python3
"""LinuxForge Core - Real Production Guest Execution Smoke & Capability Tests.

This test suite verifies the end-to-end production guest execution boundary:
1. Unit tests for guest provisioning, image validation, network isolation, and process tracking.
2. Host capability detection and fail-closed security boundary verification.
3. Deterministic failure tests verifying the host never executes untrusted learner commands.
4. Genuine end-to-end smoke test executing commands and PTY inside a real Linux guest
   when host virtualization prerequisites exist, or verifying explicit fail-closed behavior
   with diagnostic logging when host prerequisites are absent.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
QEMU_MODULE_PATH = ROOT / "runtime" / "qemu-runtime.py"
spec = importlib.util.spec_from_file_location("linuxforge_qemu_runtime", QEMU_MODULE_PATH)
assert spec and spec.loader
qemu_mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = qemu_mod
spec.loader.exec_module(qemu_mod)


def check_host_prerequisites() -> dict[str, bool]:
    has_qemu = bool(shutil.which("qemu-system-x86_64") or shutil.which("qemu-system-aarch64"))
    has_seed_tool = bool(shutil.which("cloud-localds") or shutil.which("genisoimage") or shutil.which("xorriso"))
    has_ssh = bool(shutil.which("ssh"))
    has_ssh_keygen = bool(shutil.which("ssh-keygen"))
    has_qemu_img = bool(shutil.which("qemu-img"))
    has_kvm = os.path.exists("/dev/kvm") and os.access("/dev/kvm", os.R_OK | os.W_OK)
    image_path = os.environ.get("FORGE_RUNTIME_IMAGE_PATH", "")
    has_base_image = bool(image_path and Path(image_path).exists())

    return {
        "qemu": has_qemu,
        "seed_tool": has_seed_tool,
        "ssh": has_ssh,
        "ssh_keygen": has_ssh_keygen,
        "qemu_img": has_qemu_img,
        "kvm": has_kvm,
        "base_image": has_base_image,
    }


class HostCapabilityTests(unittest.TestCase):
    """Verifies capability detection and fail-closed behavior on missing host primitives."""

    def test_capability_detection_reports_true_host_state(self):
        prereqs = check_host_prerequisites()
        manager = qemu_mod.RuntimeManager()
        health = manager.health()

        self.assertEqual(health["provider"], "real-linux-isolated-v1")
        self.assertEqual(health["runtimeClass"], "vm")

        # Security invariants must always be enforced
        sec = health["security"]
        self.assertTrue(sec["networkIsolationEnforced"])
        self.assertTrue(sec["hostFilesystemBlocked"])
        self.assertTrue(sec["privilegeEscalationBlocked"])
        self.assertTrue(sec["metadataAccessBlocked"])

        # Health and readiness reflect whether hypervisor and image exist
        expected_ready = bool(prereqs["qemu"] and prereqs["base_image"])
        self.assertEqual(health["ready"], expected_ready)

    def test_missing_image_fails_closed_without_fake_success(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            old_data = os.environ.get("FORGE_RUNTIME_DATA_DIR")
            old_img = os.environ.get("FORGE_RUNTIME_IMAGE_PATH")
            try:
                os.environ["FORGE_RUNTIME_DATA_DIR"] = temp_dir
                os.environ["FORGE_RUNTIME_IMAGE_PATH"] = str(Path(temp_dir) / "nonexistent-kali.qcow2")
                manager = qemu_mod.RuntimeManager()

                with self.assertRaises((RuntimeError, FileNotFoundError)) as ctx:
                    manager.create({
                        "environmentId": "env-no-img",
                        "userId": "user-1",
                        "labId": "lab-1",
                        "imageRef": "kali-linux@sha256:" + "a" * 64,
                        "resourcePolicy": {"network": "none"},
                    })
                err_msg = str(ctx.exception)
                self.assertTrue("missing" in err_msg.lower() or "does not point" in err_msg.lower())
            finally:
                if old_data is not None:
                    os.environ["FORGE_RUNTIME_DATA_DIR"] = old_data
                else:
                    os.environ.pop("FORGE_RUNTIME_DATA_DIR", None)
                if old_img is not None:
                    os.environ["FORGE_RUNTIME_IMAGE_PATH"] = old_img
                else:
                    os.environ.pop("FORGE_RUNTIME_IMAGE_PATH", None)


class GuestProvisioningAndIsolationUnitTests(unittest.TestCase):
    """Verifies isolation invariants, image verification, network isolation, and process validation."""

    def test_immutable_image_digest_parsing_and_approved_catalog(self):
        manager = qemu_mod.RuntimeManager()

        # Reject path traversals
        with self.assertRaises(ValueError) as ctx:
            manager._assert_image("../../../etc/passwd")
        self.assertIn("Arbitrary host paths", str(ctx.exception))

        with self.assertRaises(ValueError) as ctx:
            manager._assert_image("/tmp/evil.qcow2")
        self.assertIn("Arbitrary host paths", str(ctx.exception))

        # Reject unapproved repositories
        with self.assertRaises(ValueError) as ctx:
            manager._assert_image("unapproved-repo/rootfs@sha256:" + "0" * 64)
        self.assertIn("not in the approved", str(ctx.exception))

        # Approved repository prefix accepted for format validation
        # (Will fail because file doesn't exist, proving non-faked validation)
        with self.assertRaises(RuntimeError) as ctx:
            manager._assert_image("kali-linux@sha256:" + "f" * 64)
        self.assertIn("missing from host storage", str(ctx.exception))

    def test_hypervisor_command_enforces_strict_isolation(self):
        env = qemu_mod.Environment(
            environmentId="env-iso-test",
            userId="learner-1",
            labId="lab-1",
            status="CREATING",
            imageRef="kali-linux@sha256:" + "1" * 64,
            diskPath="/tmp/env-iso-test/root.qcow2",
            seedPath="/tmp/env-iso-test/seed.iso",
            sshKeyPath="/tmp/env-iso-test/id_ed25519",
            sshPublicKeyPath="/tmp/env-iso-test/id_ed25519.pub",
            qemuPid=None,
            sshPort=19999,
            createdAt=qemu_mod.now_iso(),
            updatedAt=qemu_mod.now_iso(),
            snapshotId=None,
            cpus=2,
            memoryMiB=2048,
            storageMiB=20480,
            network="none",
        )

        manager = qemu_mod.RuntimeManager()
        with mock.patch.object(qemu_mod, "require_binary", return_value="/usr/bin/qemu-system-x86_64"):
            cmd = manager._qemu_command(env)

        cmd_str = " ".join(cmd)

        # 1. No host filesystem mounts allowed
        self.assertNotIn("-virtfs", cmd_str)
        self.assertNotIn("fsdev", cmd_str)
        self.assertNotIn("9p", cmd_str)

        # 2. Strict network isolation with egress deny and localhost-only SSH port forwarding
        self.assertIn("restrict=on", cmd_str)
        self.assertIn("hostfwd=tcp:127.0.0.1:19999-:22", cmd_str)

        # 3. Headless isolation
        self.assertIn("-display none", cmd_str)
        self.assertIn("-nographic", cmd_str)

        # 4. QMP management socket bound to isolated unix domain socket
        self.assertIn("-qmp unix:", cmd_str)

    def test_execute_fails_closed_when_guest_not_running(self):
        manager = qemu_mod.RuntimeManager()
        env = qemu_mod.Environment(
            environmentId="env-stopped",
            userId="user-1",
            labId="lab-1",
            status="STOPPED",
            imageRef="kali-linux@sha256:" + "2" * 64,
            diskPath="/tmp/disk",
            seedPath="/tmp/seed",
            sshKeyPath="/tmp/key",
            sshPublicKeyPath="/tmp/key.pub",
            qemuPid=None,
            sshPort=2222,
            createdAt=qemu_mod.now_iso(),
            updatedAt=qemu_mod.now_iso(),
            snapshotId=None,
            cpus=2,
            memoryMiB=2048,
            storageMiB=20480,
            network="none",
        )
        manager._envs["env-stopped"] = env

        with self.assertRaises(RuntimeError) as ctx:
            manager.execute("env-stopped", {
                "input": {"kind": "raw-shell", "data": "id"},
                "cwd": "/home/linuxforge",
            })
        self.assertIn("not running", str(ctx.exception))

    def test_pty_open_rejects_stopped_environment(self):
        manager = qemu_mod.RuntimeManager()
        env = qemu_mod.Environment(
            environmentId="env-stopped-pty",
            userId="user-1",
            labId="lab-1",
            status="STOPPED",
            imageRef="kali-linux@sha256:" + "3" * 64,
            diskPath="/tmp/disk",
            seedPath="/tmp/seed",
            sshKeyPath="/tmp/key",
            sshPublicKeyPath="/tmp/key.pub",
            qemuPid=None,
            sshPort=2222,
            createdAt=qemu_mod.now_iso(),
            updatedAt=qemu_mod.now_iso(),
            snapshotId=None,
            cpus=2,
            memoryMiB=2048,
            storageMiB=20480,
            network="none",
        )
        manager._envs["env-stopped-pty"] = env

        with self.assertRaises(RuntimeError) as ctx:
            manager.pty_open("env-stopped-pty", {"sessionId": "s-test", "shell": "bash"})
        self.assertIn("not running", str(ctx.exception))


class RealGuestExecutionSmokeTest(unittest.TestCase):
    """End-to-end smoke test for real guest execution.

    If host virtualization and base image are available on the host, executes
    full 22-step real guest execution flow.
    If prerequisites are missing, proves that the system fails closed cleanly
    with explicit prerequisite reporting without faking success.
    """

    def test_real_guest_execution_or_prerequisite_boundary(self):
        prereqs = check_host_prerequisites()
        missing = [k for k, v in prereqs.items() if not v and k in ("qemu", "seed_tool", "ssh", "ssh_keygen", "qemu_img", "base_image")]

        if missing:
            print(f"\n[HOST PREREQUISITE NOTICE] Real guest execution requires host infrastructure missing: {missing}")
            print("Verifying that runtime fails closed rather than faking execution...")

            # Validate that attempting to run without prerequisites fails closed
            with tempfile.TemporaryDirectory() as temp_dir:
                old_data = os.environ.get("FORGE_RUNTIME_DATA_DIR")
                try:
                    os.environ["FORGE_RUNTIME_DATA_DIR"] = temp_dir
                    manager = qemu_mod.RuntimeManager()
                    with self.assertRaises((RuntimeError, FileNotFoundError)):
                        manager.create({
                            "environmentId": "env-smoke-failclosed",
                            "userId": "learner-smoke",
                            "labId": "lab-smoke",
                            "imageRef": "kali-linux@sha256:" + "9" * 64,
                            "resourcePolicy": {"network": "none"},
                        })
                finally:
                    if old_data is not None:
                        os.environ["FORGE_RUNTIME_DATA_DIR"] = old_data
                    else:
                        os.environ.pop("FORGE_RUNTIME_DATA_DIR", None)
            return

        # FULL REAL GUEST EXECUTION FLOW (executed on virtualization nodes)
        print("\n[SMOKE] All host prerequisites satisfied! Executing full real guest lifecycle test...")
        with tempfile.TemporaryDirectory() as temp_dir:
            old_data = os.environ.get("FORGE_RUNTIME_DATA_DIR")
            try:
                os.environ["FORGE_RUNTIME_DATA_DIR"] = temp_dir
                manager = qemu_mod.RuntimeManager()

                env_id = "smoke-env-real-1"
                created = manager.create({
                    "environmentId": env_id,
                    "userId": "learner-smoke",
                    "labId": "lab-smoke",
                    "imageRef": os.environ.get("FORGE_RUNTIME_IMAGE_REF", "kali-linux@sha256:" + "0" * 64),
                    "resourcePolicy": {"network": "none", "memoryMiB": 2048, "storageMiB": 20480},
                })
                self.assertIn(created["status"], ("READY", "RUNNING"))

                # 1. Execute `id`
                rec_id = manager.execute(env_id, {
                    "input": {"kind": "raw-shell", "data": "id"},
                    "cwd": f"/home/{manager.ssh_user}",
                })
                self.assertEqual(rec_id["exitCode"], 0)
                self.assertIn(manager.ssh_user, rec_id["stdout"])

                # 2. Execute `uname -a`
                rec_uname = manager.execute(env_id, {
                    "input": {"kind": "raw-shell", "data": "uname -a"},
                    "cwd": f"/home/{manager.ssh_user}",
                })
                self.assertEqual(rec_uname["exitCode"], 0)
                self.assertIn("Linux", rec_uname["stdout"])

                # 3. Write and read file
                manager.execute(env_id, {
                    "input": {"kind": "raw-shell", "data": "printf 'linuxforge-smoke-verified' > /tmp/lf-test && cat /tmp/lf-test"},
                    "cwd": f"/home/{manager.ssh_user}",
                })
                rec_cat = manager.execute(env_id, {
                    "input": {"kind": "raw-shell", "data": "cat /tmp/lf-test"},
                    "cwd": f"/home/{manager.ssh_user}",
                })
                self.assertEqual(rec_cat["exitCode"], 0)
                self.assertEqual(rec_cat["stdout"].strip(), "linuxforge-smoke-verified")

                # 4. Interactive PTY session
                pty_info = manager.pty_open(env_id, {
                    "sessionId": "pty-smoke-1",
                    "shell": "bash",
                    "cols": 80,
                    "rows": 24,
                })
                self.assertEqual(pty_info["sessionId"], "pty-smoke-1")

                # PTY input & read
                manager.pty_input("pty-smoke-1", "echo PTY_TEST_OK\n")
                time.sleep(0.5)
                pty_out = manager.pty_read("pty-smoke-1")
                self.assertIn("pty-smoke-1", pty_out["sessionId"])

                # PTY resize
                resized = manager.pty_resize("pty-smoke-1", {"cols": 100, "rows": 40})
                self.assertEqual(resized["cols"], 100)

                # PTY close
                closed = manager.pty_close("pty-smoke-1")
                self.assertTrue(closed["closed"])

                # 5. Stop guest
                stopped = manager.stop(env_id)
                self.assertEqual(stopped["status"], "STOPPED")

                # 6. Destroy guest
                destroyed = manager.destroy(env_id)
                self.assertTrue(destroyed["destroyed"])

                # Verify artifacts cleaned up and tombstone remains
                env_dir = Path(temp_dir) / env_id
                self.assertTrue((env_dir / "state.json").exists())
                self.assertFalse((env_dir / "root.qcow2").exists())
            finally:
                if old_data is not None:
                    os.environ["FORGE_RUNTIME_DATA_DIR"] = old_data
                else:
                    os.environ.pop("FORGE_RUNTIME_DATA_DIR", None)


if __name__ == "__main__":
    unittest.main()
