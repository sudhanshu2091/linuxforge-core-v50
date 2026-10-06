import importlib.util
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
        self.image = "kali-linux@sha256:" + "a" * 64

    def test_health_is_truthful_and_not_ready(self):
        health = self.manager.health()
        self.assertEqual(health["runtimeClass"], "microvm")
        self.assertTrue(health["healthy"])
        self.assertFalse(health["ready"])
        self.assertFalse(health["available"])
        self.assertFalse(health["configured"])
        self.assertFalse(health["executable"])
        self.assertFalse(health["capabilities"]["providerExecutable"])
        self.assertFalse(health["capabilities"]["guestRunning"])
        self.assertFalse(health["capabilities"]["commandExecution"])
        self.assertFalse(health["capabilities"]["interactivePty"])
        self.assertIn("implemented-microvm-guest-data-plane", health["missingPrerequisites"])

    def test_create_fails_closed_instead_of_claiming_ready(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.manager.create({
                "environmentId": "env-create",
                "userId": "user1",
                "labId": "lab1",
                "imageRef": self.image,
            })
        self.assertIn("not implemented", str(ctx.exception).lower())

    def test_invalid_image_is_rejected_before_unavailable_provider(self):
        with self.assertRaises(ValueError) as ctx:
            self.manager.create({
                "environmentId": "env-bad-tag",
                "userId": "user1",
                "labId": "lab1",
                "imageRef": "kali-linux:latest",
            })
        self.assertIn("must be pinned by sha256", str(ctx.exception))

    def test_lifecycle_cannot_claim_running(self):
        env = module.ProductionEnvironment(
            environmentId="env-lifecycle",
            userId="u1",
            labId="l1",
            imageRef=self.image,
        )
        self.manager.environments[env.environmentId] = env

        with self.assertRaises(RuntimeError):
            self.manager.start(env.environmentId)
        self.assertNotEqual(env.status, "RUNNING")
        self.assertNotEqual(env.lifecycleState, "RUNNING")

        with self.assertRaises(RuntimeError):
            self.manager.resume(env.environmentId)
        self.assertNotEqual(env.status, "RUNNING")

    def test_execute_fails_without_guest(self):
        env = module.ProductionEnvironment(
            environmentId="env-exec",
            userId="u1",
            labId="l1",
            imageRef=self.image,
        )
        self.manager.environments[env.environmentId] = env

        with self.assertRaises(RuntimeError):
            self.manager.execute(env.environmentId, {"input": {"data": "printf hello"}})

    def test_pty_fails_without_guest(self):
        env = module.ProductionEnvironment(
            environmentId="env-pty",
            userId="u1",
            labId="l1",
            imageRef=self.image,
        )
        self.manager.environments[env.environmentId] = env

        with self.assertRaises(RuntimeError):
            self.manager.pty_open(env.environmentId, {"sessionId": "s-1"})

        with self.assertRaises(RuntimeError):
            self.manager.pty_read("s-1")
        with self.assertRaises(RuntimeError):
            self.manager.pty_input("s-1", "id\n")
        with self.assertRaises(RuntimeError):
            self.manager.pty_resize("s-1", {"cols": 80, "rows": 24})
        with self.assertRaises(RuntimeError):
            self.manager.pty_signal("s-1", "SIGINT")

    def test_descriptor_never_advertises_guest_capabilities(self):
        env = module.ProductionEnvironment(
            environmentId="env-desc",
            userId="u1",
            labId="l1",
            imageRef=self.image,
        )
        descriptor = self.manager.descriptor(env)
        caps = descriptor["capabilities"]
        self.assertFalse(caps["realLinux"])
        self.assertFalse(caps["interactiveShell"])
        self.assertFalse(caps["processes"])
        self.assertFalse(caps["services"])
        self.assertFalse(caps["network"])
        self.assertFalse(caps["packages"])
        self.assertFalse(caps["snapshots"])
        self.assertFalse(caps["pauseResume"])

    def test_no_successful_execution_shape_exists(self):
        source = MODULE_PATH.read_text()
        self.assertNotIn('"exitCode": 0', source)
        self.assertNotIn('"stdout": ""', source)
        self.assertNotIn('"stderr": ""', source)
        self.assertNotIn('"durationMs": 10', source)


if __name__ == "__main__":
    unittest.main()
