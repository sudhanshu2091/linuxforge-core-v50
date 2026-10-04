import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "runtime" / "microvm-runtime.py"
spec = importlib.util.spec_from_file_location("linuxforge_microvm_runtime", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class MicrovmRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.manager = module.MicrovmRuntimeManager(auth_token="test-secret")

    def test_immutable_image_digest_validation(self):
        # Valid pinned sha256 reference
        valid_digest = "kali-linux@sha256:" + "a" * 64
        created = self.manager.create({
            "environmentId": "env-valid",
            "userId": "user1",
            "labId": "lab1",
            "imageRef": valid_digest,
        })
        self.assertEqual(created["status"], "READY")
        self.assertEqual(created["handle"]["environmentId"], "env-valid")

        # Invalid unpinned tag
        with self.assertRaises(ValueError) as ctx:
            self.manager.create({
                "environmentId": "env-bad-tag",
                "userId": "user1",
                "labId": "lab1",
                "imageRef": "kali-linux:latest",
            })
        self.assertIn("must be pinned by sha256", str(ctx.exception))

    def test_health_reports_security_invariants(self):
        health = self.manager.health()
        self.assertEqual(health["runtimeClass"], "microvm")
        sec = health["security"]
        self.assertTrue(sec["networkIsolationEnforced"])
        self.assertTrue(sec["hostFilesystemBlocked"])
        self.assertTrue(sec["privilegeEscalationBlocked"])
        self.assertTrue(sec["metadataAccessBlocked"])

    def test_lifecycle_transitions(self):
        image = "kali-linux@sha256:" + "b" * 64
        self.manager.create({
            "environmentId": "env-lifecycle",
            "userId": "u1",
            "labId": "l1",
            "imageRef": image,
        })

        # Mock KVM available for lifecycle test
        self.manager.capabilities.kvm_available = True
        self.manager.capabilities.hypervisor_type = "cloud-hypervisor"

        started = self.manager.start("env-lifecycle")
        self.assertEqual(started["status"], "RUNNING")

        paused = self.manager.pause("env-lifecycle")
        self.assertEqual(paused["status"], "PAUSED")

        resumed = self.manager.resume("env-lifecycle")
        self.assertEqual(resumed["status"], "RUNNING")

        stopped = self.manager.stop("env-lifecycle")
        self.assertEqual(stopped["status"], "STOPPED")

        destroyed = self.manager.destroy("env-lifecycle")
        self.assertTrue(destroyed["destroyed"])
        with self.assertRaises(KeyError):
            self.manager._get("env-lifecycle")

    def test_fail_closed_without_kvm(self):
        image = "kali-linux@sha256:" + "c" * 64
        self.manager.create({
            "environmentId": "env-no-kvm",
            "userId": "u1",
            "labId": "l1",
            "imageRef": image,
        })
        self.manager.capabilities.kvm_available = False
        with self.assertRaises(RuntimeError) as ctx:
            self.manager.start("env-no-kvm")
        self.assertIn("requires hardware virtualization", str(ctx.exception))
        env = self.manager._get("env-no-kvm")
        self.assertEqual(env.status, "ERROR")

    def test_pty_session_flow(self):
        image = "kali-linux@sha256:" + "d" * 64
        self.manager.create({
            "environmentId": "env-pty",
            "userId": "u1",
            "labId": "l1",
            "imageRef": image,
        })
        opened = self.manager.pty_open("env-pty", {"sessionId": "s-1", "shell": "bash"})
        self.assertEqual(opened["sessionId"], "s-1")
        self.assertIn("s-1", self.manager.ptys)

        in_res = self.manager.pty_input("s-1", "ls -la\n")
        self.assertTrue(in_res["accepted"])

        resize_res = self.manager.pty_resize("s-1", {"cols": 80, "rows": 24})
        self.assertEqual(resize_res["cols"], 80)

        sig_res = self.manager.pty_signal("s-1", "SIGINT")
        self.assertTrue(sig_res["accepted"])

        close_res = self.manager.pty_close("s-1")
        self.assertTrue(close_res["closed"])
        self.assertNotIn("s-1", self.manager.ptys)


if __name__ == "__main__":
    unittest.main()
