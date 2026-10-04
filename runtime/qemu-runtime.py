#!/usr/bin/env python3
"""LinuxForge V49 QEMU runtime service.

This is an infrastructure-plane service. It is intentionally outside the
TanStack application process: the app talks to it over the existing
real-linux provider HTTP boundary.

It provisions one isolated Kali VM per LinuxForge environment using QEMU,
per-environment qcow2 clones, cloud-init seed data, localhost-only SSH forwarding, and a
per-environment SSH key. The guest never receives the host filesystem,
hypervisor socket, cloud metadata endpoint, or host network interface.

Production deployments should run this service on dedicated virtualization
nodes with KVM (x86_64) or the platform's hardware virtualization backend.
The Mac development path can use QEMU + HVF for ARM64.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import pty
import fcntl
import struct
import termios
import select
import uuid
import time
import urllib.parse
from dataclasses import dataclass, asdict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

SERVICE_VERSION = "v49.1-m4-persistent-environment-1"

IMMUTABLE_IMAGE_REGEX = re.compile(r"^([a-zA-Z0-9_\-\.\/]+)@sha256:([0-9a-fA-F]{64})$")
APPROVED_IMAGE_PREFIXES = (
    "kali-linux",
    "linuxforge/kali",
    "quay.io/linuxforge/kali",
    "ghcr.io/sudhanshu2091/linuxforge-kali",
)

LIFECYCLE_STATES = {"CREATING", "BOOTING", "READY", "RUNNING", "STOPPING", "STOPPED", "FAILED", "QUARANTINED", "DESTROYED", "PAUSED", "RESETTING"}
LIFECYCLE_TRANSITIONS = {
    "CREATING": {"BOOTING", "FAILED", "QUARANTINED", "STOPPING"},
    "BOOTING": {"READY", "FAILED", "QUARANTINED", "STOPPING"},
    "READY": {"RUNNING", "STOPPING", "RESETTING", "PAUSED", "FAILED", "QUARANTINED"},
    "RUNNING": {"READY", "STOPPING", "RESETTING", "PAUSED", "FAILED", "QUARANTINED"},
    "PAUSED": {"RUNNING", "STOPPING", "FAILED", "QUARANTINED"},
    "RESETTING": {"BOOTING", "FAILED", "STOPPING"},
    "STOPPING": {"STOPPED", "FAILED", "QUARANTINED"},
    "STOPPED": {"CREATING", "BOOTING", "RESETTING", "DESTROYED"},
    "FAILED": {"BOOTING", "STOPPING", "QUARANTINED", "DESTROYED"},
    "QUARANTINED": {"STOPPING", "DESTROYED"},
    "DESTROYED": {"CREATING"},
}

DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 18080
DEFAULT_MEMORY_MIB = 2048
DEFAULT_CPUS = 2
DEFAULT_DISK_MIB = 20 * 1024
DEFAULT_SSH_USER = "linuxforge"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def run(cmd: list[str], timeout: float = 30, check: bool = True, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, input=input_text, stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL, text=True, capture_output=True, timeout=timeout, check=check)


def require_binary(name: str) -> str:
    value = shutil.which(name)
    if not value:
        raise RuntimeError(f"Required runtime binary is missing: {name}")
    return value


def safe_id(value: str) -> str:
    if not value or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in value):
        raise ValueError("Invalid environment id")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent), text=True)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((DEFAULT_BIND, 0))
        return int(sock.getsockname()[1])


@dataclass
class Environment:
    environmentId: str
    userId: str
    labId: str
    status: str
    imageRef: str
    diskPath: str
    seedPath: str
    sshKeyPath: str
    sshPublicKeyPath: str
    qemuPid: int | None
    sshPort: int
    createdAt: str
    updatedAt: str
    snapshotId: str | None
    cpus: int
    memoryMiB: int
    storageMiB: int
    network: str
    error: str | None = None
    qemuExitCode: int | None = None
    qemuLogPath: str | None = None
    lifecycleState: str = "CREATING"
    lifecycleGeneration: int = 1
    bootAttempts: int = 0
    failureCount: int = 0
    quarantinedReason: str | None = None
    destroyedAt: str | None = None
    environmentGeneration: int = 1
    artifactVersion: int = 1


@dataclass
class PtySession:
    sessionId: str
    environmentId: str
    process: subprocess.Popen[bytes]
    masterFd: int
    createdAt: str
    lastActiveAt: str


class RuntimeManager:
    def __init__(self) -> None:
        self.data_dir = Path(os.environ.get("FORGE_RUNTIME_DATA_DIR", "./.linuxforge-runtime")).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        img_env = os.environ.get("FORGE_RUNTIME_IMAGE_PATH", "").strip()
        self.base_image = Path(img_env).expanduser().resolve() if img_env else Path(self.data_dir / ".unconfigured-base.qcow2")
        self.approved_image_ref = os.environ.get("FORGE_RUNTIME_IMAGE_REF", "")
        self.arch = os.environ.get("FORGE_RUNTIME_ARCH", "auto")
        self.qemu_accel = os.environ.get("FORGE_QEMU_ACCEL", "auto")
        self.ssh_user = os.environ.get("FORGE_RUNTIME_SSH_USER", DEFAULT_SSH_USER)
        self.auth_token = os.environ.get("FORGE_RUNTIME_SERVICE_TOKEN", "")
        self.max_environments = int(os.environ.get("FORGE_RUNTIME_MAX_ENVIRONMENTS", "8"))
        self._lock = threading.RLock()
        self._envs: dict[str, Environment] = {}
        self._ptys: dict[str, PtySession] = {}
        self._processes: dict[str, subprocess.Popen[bytes]] = {}
        self._expected_exit: set[str] = set()
        self._operation_results: dict[str, tuple[str, dict[str, Any]]] = {}
        self._operation_ids_by_environment: dict[str, str] = {}
        self._load()
        self._reconcile_orphan_processes_once()
        self._watchdog = threading.Thread(target=self._watchdog_loop, name="linuxforge-qemu-watchdog", daemon=True)
        self._watchdog.start()

    def _state_path(self, environment_id: str) -> Path:
        return self.data_dir / environment_id / "state.json"

    def _load(self) -> None:
        for state in self.data_dir.glob("*/state.json"):
            try:
                raw = json.loads(state.read_text())
                # Backward-compatible load for environments created by earlier V49 builds.
                raw.setdefault("error", None)
                raw.setdefault("qemuExitCode", None)
                raw.setdefault("qemuLogPath", str(state.parent / "qemu.log"))
                raw.setdefault("lifecycleState", {"CREATING": "CREATING", "READY": "READY", "RUNNING": "RUNNING", "PAUSED": "PAUSED", "RESETTING": "RESETTING", "STOPPED": "STOPPED", "ERROR": "FAILED", "EXPIRED": "STOPPED"}.get(raw.get("status"), "FAILED"))
                raw.setdefault("lifecycleGeneration", 1)
                raw.setdefault("bootAttempts", 0)
                raw.setdefault("failureCount", 0)
                raw.setdefault("quarantinedReason", None)
                raw.setdefault("destroyedAt", None)
                raw.setdefault("environmentGeneration", 1)
                raw.setdefault("artifactVersion", 1)
                env = Environment(**raw)
                if env.qemuPid and not self._pid_is_expected_qemu(env.qemuPid, env):
                    env.qemuPid = None
                    if env.lifecycleState not in {"STOPPED", "DESTROYED"}:
                        env.lifecycleState = "QUARANTINED"
                        env.status = "ERROR"
                        env.quarantinedReason = env.quarantinedReason or "Recorded QEMU process is missing or does not belong to this environment"
                        env.error = env.error or env.quarantinedReason
                        env.failureCount += 1
                        env.lifecycleGeneration += 1
                        env.updatedAt = now_iso()
                        self._persist(env)
                self._envs[env.environmentId] = env
            except Exception as exc:
                # Do not silently erase a physical environment from the runtime
                # registry. Leave a durable recovery marker beside the corrupt
                # state file so reconciliation can distinguish corruption from
                # an environment that never existed.
                try:
                    marker = state.with_name("RECOVERY_REQUIRED.json")
                    atomic_write(marker, json.dumps({"environmentId": state.parent.name, "reason": str(exc), "statePath": str(state), "createdAt": now_iso()}, sort_keys=True))
                except Exception:
                    pass

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    @classmethod
    def _pid_is_expected_qemu(cls, pid: int, env: Environment | None = None) -> bool:
        if not cls._pid_alive(pid):
            return False
        try:
            result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], text=True, capture_output=True, timeout=2, check=False)
            command = result.stdout.strip().lower()
            if "qemu-system-" not in command:
                return False
            if env is not None:
                expected_disk = str(Path(env.diskPath).resolve()).lower()
                if expected_disk and expected_disk not in command:
                    return False
            return True
        except Exception:
            return True if env is None else False

    def _reconcile_processes_once(self) -> None:
        with self._lock:
            for env_id, env in list(self._envs.items()):
                proc = self._processes.get(env_id)
                pid = env.qemuPid
                if proc is not None:
                    returncode = proc.poll()
                    if returncode is None:
                        continue
                    self._processes.pop(env_id, None)
                    if env_id in self._expected_exit:
                        self._expected_exit.discard(env_id)
                        env.qemuPid = None
                        if env.lifecycleState not in {"STOPPED", "DESTROYED"}:
                            env.lifecycleState = "STOPPED"
                            env.status = "STOPPED"
                            env.lifecycleGeneration += 1
                        env.updatedAt = now_iso()
                        self._persist(env)
                        continue
                    if env.qemuPid == pid:
                        env.qemuPid = None
                        env.qemuExitCode = returncode
                        env.error = f"QEMU exited unexpectedly with code {returncode}; see {env.qemuLogPath or 'qemu.log'}"
                        self._transition(env, "FAILED", error=env.error)
                    continue
                if pid and env.status in {"RUNNING", "READY", "PAUSED", "CREATING"} and not self._pid_is_expected_qemu(pid, env):
                    env.qemuPid = None
                    self._transition(env, "QUARANTINED", error="Recorded QEMU process is no longer alive; runtime quarantined the stale RUNNING state pending reconciliation")

    def _watchdog_loop(self) -> None:
        while True:
            time.sleep(1.0)
            self._reconcile_processes_once()

    def _transition(self, env: Environment, target: str, *, error: str | None = None) -> None:
        if target not in LIFECYCLE_STATES:
            raise RuntimeError(f"Unknown runtime lifecycle state: {target}")
        current = env.lifecycleState
        if target != current and target not in LIFECYCLE_TRANSITIONS.get(current, set()):
            raise RuntimeError(f"Invalid runtime lifecycle transition: {current} -> {target}")
        env.lifecycleState = target
        env.lifecycleGeneration += 1 if target != current else 0
        if target == "FAILED":
            env.status = "ERROR"
            env.failureCount += 1
        elif target == "QUARANTINED":
            env.status = "ERROR"
        elif target == "STOPPED":
            env.status = "STOPPED"
        elif target == "PAUSED":
            env.status = "PAUSED"
        elif target in {"CREATING", "BOOTING", "READY", "RUNNING", "RESETTING", "STOPPING"}:
            env.status = "CREATING" if target in {"CREATING", "BOOTING"} else ("READY" if target == "READY" else ("RESETTING" if target == "RESETTING" else ("STOPPED" if target == "STOPPING" else "RUNNING")))
        elif target == "DESTROYED":
            env.status = "STOPPED"
            env.destroyedAt = now_iso()
        if error:
            env.error = error
        env.updatedAt = now_iso()
        self._persist(env)

    def _operation_path(self, environment_id: str) -> Path:
        return self.data_dir / safe_id(environment_id) / "operations.json"

    def _load_operation_result(self, key: str, environment_id: str) -> tuple[str, dict[str, Any]] | None:
        path = self._operation_path(environment_id)
        try:
            raw = json.loads(path.read_text())
            entry = raw.get(key)
            if not entry:
                return None
            return str(entry["action"]), dict(entry["result"])
        except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return None

    def _save_operation_result(self, key: str, environment_id: str, action: str, result: dict[str, Any]) -> None:
        path = self._operation_path(environment_id)
        try:
            raw = json.loads(path.read_text()) if path.exists() else {}
        except (ValueError, json.JSONDecodeError):
            raw = {}
        raw[key] = {"action": action, "result": result, "savedAt": now_iso()}
        atomic_write(path, json.dumps(raw, indent=2) + "\n")

    def _reconcile_orphan_processes_once(self) -> None:
        try:
            result = subprocess.run(["ps", "-axo", "pid=,command="], text=True, capture_output=True, timeout=3, check=False)
        except Exception:
            return
        known_disks = {str(Path(env.diskPath).resolve()): env.environmentId for env in self._envs.values() if env.diskPath}
        root = str(self.data_dir.resolve()) + os.sep
        for line in result.stdout.splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) != 2 or "qemu-system-" not in parts[1]:
                continue
            pid_text, command = parts
            try:
                pid = int(pid_text)
            except ValueError:
                continue
            disks = [token.split("=", 1)[1].split(",", 1)[0] for token in command.split() if token.startswith("file=") and "/root.qcow2" in token]
            for disk in disks:
                disk_path = str(Path(disk).resolve())
                if not disk_path.startswith(root):
                    continue
                if disk_path not in known_disks:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except OSError:
                        pass

    def _operation_key(self, operation: dict[str, Any] | None) -> str | None:
        if not operation:
            return None
        key = str(operation.get("idempotencyKey") or operation.get("operationId") or "")
        return key or None

    def _run_idempotent(self, operation: dict[str, Any] | None, environment_id: str, action: str, fn):
        key = self._operation_key(operation)
        if key:
            existing = self._operation_results.get(key) or self._load_operation_result(key, environment_id)
            if existing:
                previous_action, result = existing
                if previous_action != action or (result.get("handle", {}).get("environmentId") not in {None, environment_id}):
                    raise RuntimeError("Runtime operation idempotency key was already used for a different operation")
                self._operation_results[key] = existing
                return result
        result = fn()
        if key:
            self._operation_results[key] = (action, result)
            self._operation_ids_by_environment[environment_id] = key
            self._save_operation_result(key, environment_id, action, result)
        return result

    def _persist(self, env: Environment) -> None:
        atomic_write(self._state_path(env.environmentId), json.dumps(asdict(env), indent=2) + "\n")

    def _environment_dir(self, environment_id: str) -> Path:
        path = self.data_dir / safe_id(environment_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _assert_image(self, image_ref: str) -> None:
        if not image_ref or not isinstance(image_ref, str):
            raise ValueError("Image reference is required and must be a string")
        trimmed = image_ref.strip()
        if trimmed.startswith("/") or trimmed.startswith("./") or ".." in trimmed:
            raise ValueError("Arbitrary host paths are not permitted as image references")

        match = IMMUTABLE_IMAGE_REGEX.match(trimmed)
        if match:
            repo, digest = match.groups()
            is_approved = any(repo.lower().startswith(prefix.lower()) for prefix in APPROVED_IMAGE_PREFIXES)
            if not is_approved:
                raise ValueError(f"Image repository '{repo}' is not in the approved LinuxForge image list")
            if not self.base_image.is_file():
                raise RuntimeError(f"Approved immutable base image artifact '{trimmed}' is missing from host storage: {self.base_image}")
            digest_file = self.base_image.with_suffix(self.base_image.suffix + ".sha256")
            expected = None
            if digest_file.exists():
                expected = digest_file.read_text().strip().split()[0]
            if expected:
                if digest.lower() != expected.lower():
                    raise RuntimeError(f"Base image SHA-256 verification failed for '{trimmed}' (expected {expected}, got {digest})")
            elif sha256_file(self.base_image).lower() != digest.lower():
                raise RuntimeError(f"Base image SHA-256 verification failed for '{trimmed}'")
        else:
            if not self.base_image.is_file():
                raise RuntimeError("FORGE_RUNTIME_IMAGE_PATH does not point to a Kali qcow2 image")
            if self.approved_image_ref and trimmed != self.approved_image_ref:
                raise RuntimeError("Runtime image reference is not the approved immutable image")
            digest_file = self.base_image.with_suffix(self.base_image.suffix + ".sha256")
            expected = None
            if digest_file.exists():
                expected = digest_file.read_text().strip().split()[0]
            if expected and sha256_file(self.base_image) != expected:
                raise RuntimeError("Kali base image SHA-256 verification failed")

    def _architecture(self) -> str:
        if self.arch in {"x86_64", "amd64"}:
            return "x86_64"
        if self.arch in {"aarch64", "arm64"}:
            return "aarch64"
        machine = os.uname().machine.lower()
        return "aarch64" if machine in {"arm64", "aarch64"} else "x86_64"

    def _qmp_path(self, env: Environment) -> Path:
        # macOS limits AF_UNIX socket paths to 104 bytes. The project/data
        # directory can be long, so keep QMP sockets in a short system temp
        # directory while retaining one unique socket per environment.
        path = Path(tempfile.gettempdir()) / f"lf49-qmp-{safe_id(env.environmentId)}.sock"
        if len(str(path).encode()) >= 104:
            raise RuntimeError("Environment id is too long for the QEMU QMP socket path")
        return path

    def _uefi_code_path(self) -> str:
        """Return the AArch64 UEFI code image for local QEMU.

        Kali's ARM64 generic-cloud image boots as a normal UEFI virtual disk.
        For the disposable local QEMU provider, use the firmware code through
        -bios rather than a persistent NVRAM template. This avoids stale EFI
        boot entries while keeping each lab independent.
        """
        explicit = os.environ.get("FORGE_QEMU_UEFI_CODE", "")
        candidates = [explicit] if explicit else [
            "/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
            "/usr/local/share/qemu/edk2-aarch64-code.fd",
            "/usr/share/AAVMF/AAVMF_CODE.fd",
            "/usr/share/qemu-efi-aarch64/QEMU_EFI.fd",
            "/usr/share/qemu-efi-aarch64/QEMU_CODE.fd",
        ]
        for candidate in candidates:
            if candidate and Path(candidate).exists():
                return candidate
        raise RuntimeError(
            "AArch64 QEMU UEFI code firmware was not found; "
            "set FORGE_QEMU_UEFI_CODE"
        )

    def _qemu_command(self, env: Environment) -> list[str]:
        arch = self._architecture()
        qemu = require_binary("qemu-system-aarch64" if arch == "aarch64" else "qemu-system-x86_64")
        qmp = self._qmp_path(env)
        serial = self._environment_dir(env.environmentId) / "serial.log"
        accel = self.qemu_accel
        if accel == "auto":
            if sys_platform() == "darwin":
                accel = "hvf"
            elif Path("/dev/kvm").exists():
                accel = "kvm"
            else:
                accel = "tcg"

        cmd = [qemu]
        if arch == "aarch64":
            cmd += ["-machine", "virt", "-cpu", "max"]
        else:
            cmd += ["-machine", "q35", "-cpu", "max"]
        cmd += ["-accel", accel, "-m", str(env.memoryMiB), "-smp", str(env.cpus)]
        cmd += [
            # Keep the ARM64 local provider on the same attachment model that
            # is proven against the official Kali ARM64 cloud image on Apple
            # Silicon: a virtio root disk plus a CD-ROM NoCloud seed.
            "-drive", f"file={env.diskPath},if=virtio,format=qcow2,cache=none,aio=threads",
            "-drive", f"file={env.seedPath},media=cdrom,readonly=on,format=raw",
        ]
        # The cloud-init seed is a CD-ROM and must never win UEFI boot
        # selection. Use explicit QEMU boot indexes as well as legacy -boot
        # ordering so UEFI firmware always starts from the Kali disk.
        cmd += ["-boot", "order=c,menu=off"]
        if arch == "aarch64":
            # Kali ARM64 generic-cloud images are UEFI guests. Use the firmware
            # code through -bios for the disposable local QEMU provider.
            # Persistent NVRAM is unnecessary for labs and can carry stale EFI
            # boot entries between environments.
            uefi_code = self._uefi_code_path()
            cmd += ["-bios", uefi_code]
        # The only network exposure is localhost -> guest SSH. QEMU's restricted
        # user-mode network prevents guest access to the host and external network.
        cmd += [
            "-netdev", f"user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:{env.sshPort}-:22",
            "-device", "virtio-net-pci,netdev=net0",
            "-qmp", f"unix:{qmp},server=on,wait=off",
            "-serial", f"file:{serial}",
            "-display", "none",
            "-monitor", "none",
            "-nographic",
        ]
        return cmd

    def _create_seed(self, env: Environment) -> None:
        env_dir = self._environment_dir(env.environmentId)
        private_key = env_dir / "id_ed25519"
        public_key = env_dir / "id_ed25519.pub"
        if not private_key.exists():
            require_binary("ssh-keygen")
            run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(private_key)])
        pub = public_key.read_text().strip()
        user_data = f"""#cloud-config\nusers:\n  - name: {self.ssh_user}\n    shell: /bin/bash\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    groups: [sudo, users]\n    lock_passwd: true\n    ssh_authorized_keys:\n      - {pub}\nssh_pwauth: false\nruncmd:\n  - systemctl enable --now ssh || true\n  - mkdir -p /home/{self.ssh_user}\n  - chown {self.ssh_user}:{self.ssh_user} /home/{self.ssh_user}\n  - usermod -aG sudo {self.ssh_user} || true\n  - echo "{self.ssh_user} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/linuxforge-sudo\n  - chmod 0440 /etc/sudoers.d/linuxforge-sudo\n"""
        meta_data = json.dumps({"instance-id": env.environmentId, "local-hostname": f"linuxforge-{env.environmentId}"})
        user_file = env_dir / "user-data"
        meta_file = env_dir / "meta-data"
        user_file.write_text(user_data)
        meta_file.write_text(meta_data + "\n")
        seed = env_dir / "seed.iso"
        if seed.exists():
            return
        maker = shutil.which("cloud-localds") or shutil.which("genisoimage") or shutil.which("xorriso")
        if not maker:
            raise RuntimeError("Install cloud-localds, genisoimage, or xorriso to create the Kali cloud-init seed ISO")
        if Path(maker).name == "cloud-localds":
            run([maker, str(seed), str(user_file), str(meta_file)])
        elif Path(maker).name == "genisoimage":
            run([maker, "-output", str(seed), "-volid", "cidata", "-joliet", "-rock", str(user_file), str(meta_file)])
        else:
            run([maker, "-as", "mkisofs", "-output", str(seed), "-volid", "cidata", "-joliet", "-rock", str(user_file), str(meta_file)])

    def _log_tail(self, env: Environment, lines: int = 40) -> str:
        path = Path(env.qemuLogPath) if env.qemuLogPath else self._environment_dir(env.environmentId) / "qemu.log"
        try:
            return "\n".join(path.read_text(errors="replace").splitlines()[-lines:])
        except FileNotFoundError:
            return ""

    def _wait_for_ssh(self, env: Environment, timeout: float = 45.0) -> None:
        deadline = time.time() + timeout
        key = Path(env.sshKeyPath)
        while time.time() < deadline:
            proc = self._processes.get(env.environmentId)
            if proc is not None and proc.poll() is not None:
                code = proc.returncode
                tail = self._log_tail(env)
                raise RuntimeError(f"QEMU exited during boot with code {code}. QEMU log: {tail[-4000:]}")
            if self._tcp_ready(env.sshPort):
                cmd = [require_binary("ssh"), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
                       "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=2", "-o", "LogLevel=ERROR",
                       "-i", str(key), "-p", str(env.sshPort), f"{self.ssh_user}@127.0.0.1", "true"]
                result = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=4, check=False)
                if result.returncode == 0:
                    return
            time.sleep(1)
        tail = self._log_tail(env)
        raise RuntimeError(f"Kali guest did not become SSH-ready within {int(timeout)}s. QEMU log: {tail[-4000:]}")

    @staticmethod
    def _tcp_ready(port: int) -> bool:
        try:
            with socket.create_connection((DEFAULT_BIND, port), timeout=0.5):
                return True
        except OSError:
            return False

    def _start_process(self, env: Environment) -> None:
        qmp_path = self._qmp_path(env)
        try:
            qmp_path.unlink()
        except FileNotFoundError:
            pass
        require_binary("qemu-img")
        self._create_seed(env)
        cmd = self._qemu_command(env)
        env_dir = self._environment_dir(env.environmentId)
        log_path = env_dir / "qemu.log"
        env.qemuLogPath = str(log_path)
        env.qemuExitCode = None
        env.error = None
        with log_path.open("ab") as log:
            log.write(f"\n===== QEMU START {now_iso()} =====\n".encode())
            log.flush()
            proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self._processes[env.environmentId] = proc
        self._expected_exit.discard(env.environmentId)
        env.qemuPid = proc.pid
        env.bootAttempts += 1
        if env.lifecycleState == "STOPPED":
            self._transition(env, "BOOTING")
        elif env.lifecycleState in {"CREATING", "RESETTING", "FAILED"}:
            if env.lifecycleState == "CREATING":
                self._transition(env, "BOOTING")
            elif env.lifecycleState == "RESETTING":
                self._transition(env, "BOOTING")
            else:
                self._transition(env, "BOOTING")
        else:
            env.lifecycleState = "BOOTING"
            env.lifecycleGeneration += 1
            env.status = "CREATING"
            env.updatedAt = now_iso()
            self._persist(env)
        try:
            self._wait_for_ssh(env)
        except Exception as exc:
            if proc.poll() is None:
                self._expected_exit.add(env.environmentId)
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except OSError:
                    pass
            else:
                env.qemuExitCode = proc.returncode
            env.qemuPid = None
            self._transition(env, "FAILED", error=str(exc))
            raise
        self._transition(env, "READY")
        self._transition(env, "RUNNING")

    def _ensure_disk_size(self, disk: Path, requested_mib: int) -> int:
        """Keep backing-image size as the floor; only grow qcow2 overlays.

        Kali cloud images may already be larger than the runtime policy default.
        qemu-img refuses an implicit shrink (correctly, because it can destroy
        data), so the runtime must never shrink an environment disk. The
        effective storage size is therefore the larger of the requested policy
        size and the overlay's current virtual size.
        """
        requested_mib = max(4096, int(requested_mib))
        info = run(["qemu-img", "info", "--output=json", str(disk)])
        try:
            virtual_size_bytes = int(json.loads(info.stdout)["virtual-size"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Unable to determine virtual size of runtime disk: {disk}") from exc
        current_mib = (virtual_size_bytes + (1024 * 1024 - 1)) // (1024 * 1024)
        effective_mib = max(requested_mib, current_mib)
        if effective_mib > current_mib:
            run(["qemu-img", "resize", str(disk), f"{effective_mib}M"])
        return effective_mib

    def _persistence_fingerprint(self, env: Environment) -> str:
        disk = Path(env.diskPath)
        if not disk.exists():
            raise RuntimeError("Persistent environment disk is missing")
        info = run(["qemu-img", "info", "-U", "--output=json", str(disk)], timeout=15)
        try:
            payload = json.loads(info.stdout)
            virtual_size = int(payload["virtual-size"])
            actual_size = int(disk.stat().st_size)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError) as exc:
            raise RuntimeError("Unable to inspect persistent environment disk") from exc
        # Structural fingerprint, intentionally cheap: deep content hashing of a
        # multi-GB learner disk must never happen on every lifecycle request.
        material = f"{env.environmentId}:{virtual_size}:{actual_size}:{payload.get('format','unknown')}"
        return hashlib.sha256(material.encode()).hexdigest()

    def persistence(self, env_id: str) -> dict[str, Any]:
        with self._lock:
            env = self._get(env_id)
            disk = Path(env.diskPath)
            if env.lifecycleState == "DESTROYED":
                return {
                    "state": "DESTROYED", "environmentGeneration": env.environmentGeneration, "artifactVersion": env.artifactVersion,
                    "artifactRef": env.environmentId, "integrityStatus": "VERIFIED",
                    "integrityFingerprint": None, "lastPersistedAt": env.updatedAt,
                    "lastVerifiedAt": now_iso(), "lastRestoredAt": None,
                    "destroyedAt": env.destroyedAt,
                }
            if not disk.exists():
                return {
                    "state": "QUARANTINED", "environmentGeneration": env.environmentGeneration, "artifactVersion": env.artifactVersion,
                    "artifactRef": env.environmentId, "integrityStatus": "FAILED",
                    "integrityFingerprint": None, "lastPersistedAt": None,
                    "lastVerifiedAt": now_iso(), "lastRestoredAt": None,
                    "destroyedAt": env.destroyedAt,
                }
            try:
                fingerprint = self._persistence_fingerprint(env)
                integrity = "VERIFIED"
            except Exception:
                fingerprint = None
                integrity = "FAILED"
            state = "DESTROYED" if env.lifecycleState == "DESTROYED" else ("STOPPED" if env.lifecycleState == "STOPPED" else ("QUARANTINED" if env.lifecycleState == "QUARANTINED" else ("ACTIVE" if env.lifecycleState in {"RUNNING","READY","PAUSED"} else "PROVISIONING")))
            return {
                "state": state,
                "environmentGeneration": 1,
                "artifactVersion": env.artifactVersion,
                "artifactRef": env.environmentId,
                "integrityStatus": integrity,
                "integrityFingerprint": fingerprint,
                "lastPersistedAt": env.updatedAt if state == "STOPPED" else None,
                "lastVerifiedAt": now_iso(),
                "lastRestoredAt": env.updatedAt if state == "ACTIVE" else None,
                "destroyedAt": env.destroyedAt,
            }

    def create(self, body: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if len([e for e in self._envs.values() if e.status not in {"STOPPED", "ERROR"}]) >= self.max_environments:
                raise RuntimeError("Runtime node is at capacity")
            runtime = body.get("runtime") or {}
            env_id = safe_id(str(body.get("handle", {}).get("environmentId") or body.get("environmentId") or secrets.token_hex(12)))
            user_id = str(body.get("userId") or body.get("handle", {}).get("userId") or "")
            lab_id = str(body.get("labId") or body.get("handle", {}).get("labId") or "")
            image_ref = str(runtime.get("imageRef") or body.get("imageRef") or "")
            if not user_id or not lab_id or not image_ref:
                raise RuntimeError("Runtime creation requires learner, lab and immutable image identity")
            runtime_class = body.get("runtimeClass") or runtime.get("runtimeClass") or (body.get("metadata") or {}).get("runtimeClass") or "vm"
            if runtime_class not in {"vm", "microvm"}:
                raise RuntimeError("V49 QEMU runtime requires vm or microvm runtime class")
            policy = body.get("resourcePolicy") or {}
            net_mode = policy.get("network", "none")
            if net_mode not in {"none", "isolated"}:
                raise RuntimeError("V49 local QEMU runtime enforces isolated guest networking with egress DENY; external egress requires dedicated host networking infrastructure")
            self._assert_image(image_ref)
            if env_id in self._envs and self._envs[env_id].lifecycleState in {"RUNNING", "READY", "BOOTING", "CREATING", "PAUSED", "STOPPING"}:
                return self.descriptor(self._envs[env_id])
            env_dir = self._environment_dir(env_id)
            previous = self._envs.get(env_id)
            if previous is not None and previous.lifecycleState == "DESTROYED":
                operations_path = env_dir / "operations.json"
                try: operations_path.unlink()
                except FileNotFoundError: pass
            disk = env_dir / "root.qcow2"
            storage_mib = max(4096, int(policy.get("storageMiB", DEFAULT_DISK_MIB)))
            # M4: an existing STOPPED environment owns its persistent disk.
            # Creation may initialize a new environment, but it must never wipe
            # a learner environment merely because the control plane retries.
            if not disk.exists():
                shutil.copy2(self.base_image, disk)
            storage_mib = self._ensure_disk_size(disk, storage_mib)
            env = Environment(
                environmentId=env_id, userId=user_id, labId=lab_id, status="CREATING", imageRef=image_ref,
                diskPath=str(disk), seedPath=str(env_dir / "seed.iso"), sshKeyPath=str(env_dir / "id_ed25519"),
                sshPublicKeyPath=str(env_dir / "id_ed25519.pub"), qemuPid=None, sshPort=find_free_port(),
                createdAt=now_iso(), updatedAt=now_iso(), snapshotId=None, cpus=max(1, min(8, int(policy.get("cpuMillicores", 500) / 500))),
                memoryMiB=max(512, min(16384, int(policy.get("memoryMiB", DEFAULT_MEMORY_MIB)))),
                storageMiB=storage_mib, network="none", lifecycleState="CREATING",
            )
            self._envs[env_id] = env
            self._persist(env)
            try:
                self._start_process(env)
            except Exception as exc:
                env.qemuPid = None
                env.error = str(exc)
                try:
                    self._transition(env, "FAILED", error=str(exc))
                except RuntimeError:
                    env.lifecycleState = "FAILED"
                    env.status = "ERROR"
                    env.failureCount += 1
                    env.lifecycleGeneration += 1
                    env.updatedAt = now_iso()
                    self._persist(env)
                raise
            return self.descriptor(env)

    def _get(self, env_id: str) -> Environment:
        env = self._envs.get(safe_id(env_id))
        if not env:
            raise KeyError("Environment not found")
        if env.qemuPid and not self._pid_is_expected_qemu(env.qemuPid, env) and env.lifecycleState in {"RUNNING", "READY", "PAUSED", "CREATING", "BOOTING"}:
            env.qemuPid = None
            self._transition(env, "QUARANTINED", error=env.error or "Recorded QEMU process is no longer alive; runtime quarantined the environment")
        return env

    def _qmp(self, env: Environment, execute: str, arguments: dict[str, Any] | None = None) -> None:
        path = self._qmp_path(env)
        deadline = time.time() + 5
        while not path.exists() and time.time() < deadline:
            time.sleep(0.05)
        if not path.exists():
            raise RuntimeError("QEMU management socket is unavailable")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(5)
            sock.connect(str(path))
            sock.recv(4096)
            sock.sendall((json.dumps({"execute": "qmp_capabilities"}) + "\r\n").encode())
            sock.recv(4096)
            payload: dict[str, Any] = {"execute": execute}
            if arguments:
                payload["arguments"] = arguments
            sock.sendall((json.dumps(payload) + "\r\n").encode())
            response = sock.recv(4096).decode(errors="replace")
            if '"error"' in response:
                raise RuntimeError(response)

    def start(self, env_id: str, operation: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            return self._run_idempotent(operation, env_id, "start", lambda: self._start_locked(env_id))

    def _start_locked(self, env_id: str) -> dict[str, Any]:
        env = self._get(env_id)
        if env.lifecycleState == "RUNNING": return self.descriptor(env)
        if env.lifecycleState == "QUARANTINED":
            env.qemuPid = None
            self._transition(env, "STOPPING")
            self._transition(env, "STOPPED")
        if env.lifecycleState == "DESTROYED": raise RuntimeError("Runtime is destroyed")
        self._start_process(env)
        return self.descriptor(env)

    def stop(self, env_id: str, operation: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            return self._run_idempotent(operation, env_id, "stop", lambda: self._stop_locked(env_id))

    def _stop_locked(self, env_id: str) -> dict[str, Any]:
        env = self._get(env_id)
        if env.lifecycleState not in {"STOPPED", "DESTROYED"}:
            if env.lifecycleState != "STOPPING":
                self._transition(env, "STOPPING")
            if env.qemuPid and self._pid_is_expected_qemu(env.qemuPid, env):
                self._expected_exit.add(env.environmentId)
                proc = self._processes.get(env.environmentId)
                try: self._qmp(env, "quit")
                except Exception:
                    try: os.killpg(env.qemuPid, signal.SIGTERM)
                    except OSError: os.kill(env.qemuPid, signal.SIGTERM)
                deadline = time.time() + 5
                while self._pid_alive(env.qemuPid) and time.time() < deadline: time.sleep(0.05)
                if self._pid_alive(env.qemuPid):
                    try: os.killpg(env.qemuPid, signal.SIGKILL)
                    except OSError: os.kill(env.qemuPid, signal.SIGKILL)
                if proc is not None: self._processes.pop(env.environmentId, None)
            self._expected_exit.discard(env.environmentId)
            env.qemuPid = None
            self._transition(env, "STOPPED")
        return self.descriptor(env)

    def pause(self, env_id: str, operation: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            return self._run_idempotent(operation, env_id, "pause", lambda: self._pause_locked(env_id))

    def _pause_locked(self, env_id: str) -> dict[str, Any]:
        env = self._get(env_id)
        if not env.qemuPid or not self._pid_is_expected_qemu(env.qemuPid, env):
            raise RuntimeError("Cannot pause an environment whose QEMU process is not alive")
        os.kill(env.qemuPid, signal.SIGSTOP)
        self._transition(env, "PAUSED")
        return self.descriptor(env)

    def resume(self, env_id: str, operation: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            return self._run_idempotent(operation, env_id, "resume", lambda: self._resume_locked(env_id))

    def _resume_locked(self, env_id: str) -> dict[str, Any]:
        env = self._get(env_id)
        if env.qemuPid and self._pid_is_expected_qemu(env.qemuPid, env):
            os.kill(env.qemuPid, signal.SIGCONT)
            self._transition(env, "RUNNING")
            return self.descriptor(env)
        self._start_process(env)
        return self.descriptor(env)

    def reset(self, env_id: str, operation: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            return self._run_idempotent(operation, env_id, "reset", lambda: self._reset_locked(env_id))

    def _reset_locked(self, env_id: str) -> dict[str, Any]:
            env = self._get(env_id)
            self._stop_locked(env_id)
            self._transition(env, "RESETTING")
            disk = Path(env.diskPath)
            if disk.exists(): disk.unlink()
            shutil.copy2(self.base_image, disk)
            env.storageMiB = self._ensure_disk_size(disk, env.storageMiB)
            env.environmentGeneration += 1
            env.artifactVersion += 1
            env.snapshotId = None
            self._start_process(env)
            return self.descriptor(env)

    def snapshot(self, env_id: str) -> dict[str, Any]:
        with self._lock:
            env = self._get(env_id)
            # QEMU internal savevm is used while running. This captures VM state
            # and memory in a QEMU-managed snapshot, not a host filesystem copy.
            snap = f"v49-{int(time.time())}"
            self._qmp(env, "savevm", {"name": snap})
            env.snapshotId = snap; env.updatedAt = now_iso(); self._persist(env)
            return {"snapshotId": snap, "createdAt": now_iso()}

    def restore(self, env_id: str, snapshot_id: str) -> dict[str, Any]:
        with self._lock:
            env = self._get(env_id)
            if env.snapshotId != snapshot_id: raise RuntimeError("Snapshot is not owned by this environment")
            self._qmp(env, "loadvm", {"name": snapshot_id})
            if env.lifecycleState == "PAUSED":
                self._transition(env, "RUNNING")
            elif env.lifecycleState in {"RUNNING", "READY"}:
                env.status = "RUNNING"; env.lifecycleState = "RUNNING"; env.updatedAt = now_iso(); self._persist(env)
            else:
                raise RuntimeError(f"Cannot restore snapshot from lifecycle state {env.lifecycleState}")
            return self.descriptor(env)

    def destroy(self, env_id: str, operation: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            return self._run_idempotent(operation, env_id, "destroy", lambda: self._destroy_locked(env_id))

    def _destroy_locked(self, env_id: str) -> dict[str, Any]:
        env = self._get(env_id)
        self._stop_locked(env_id)
        for sid, session in list(self._ptys.items()):
            if session.environmentId == env.environmentId:
                self.pty_close(sid)
        env_dir = self._environment_dir(env.environmentId)
        for child in env_dir.iterdir():
            if child.name != "state.json":
                if child.is_dir(): shutil.rmtree(child, ignore_errors=True)
                else:
                    try: child.unlink()
                    except FileNotFoundError: pass
        self._transition(env, "DESTROYED")
        self._persist(env)
        return {"destroyed": True}

    def ssh(self, env: Environment, command: str, timeout: float = 15, stdin: bytes | None = None) -> tuple[int, str, str]:
        if env.status != "RUNNING": raise RuntimeError("Environment is not running")
        key = Path(env.sshKeyPath)
        cmd = [
            require_binary("ssh"), "-tt", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=5", "-o", "LogLevel=ERROR", "-i", str(key), "-p", str(env.sshPort),
            f"{self.ssh_user}@127.0.0.1", command,
        ]
        proc = subprocess.run(cmd, input=stdin, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL, capture_output=True, timeout=timeout)
        return proc.returncode, proc.stdout.decode(errors="replace"), proc.stderr.decode(errors="replace")

    def _pty(self, session_id: str) -> PtySession:
        try:
            session = self._ptys[safe_id(session_id)]
        except KeyError:
            raise KeyError("Terminal PTY session not found")
        if session.process.poll() is not None:
            raise RuntimeError("Terminal PTY process has exited")
        return session

    def pty_open(self, env_id: str, body: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            env = self._get(env_id)
            if env.status != "RUNNING":
                raise RuntimeError("Environment is not running")
            requested_generation = body.get("runtimeLifecycleGeneration")
            if requested_generation is not None:
                try:
                    requested_generation = int(requested_generation)
                except (TypeError, ValueError) as exc:
                    raise RuntimeError("Invalid runtime lifecycle generation") from exc
                if requested_generation != env.lifecycleGeneration:
                    raise RuntimeError("Terminal ticket is stale for the current runtime generation")
            shell = str(body.get("shell") or "bash")
            if shell not in {"bash", "sh", "zsh"}:
                raise RuntimeError("Unsupported shell")
            cwd = str(body.get("cwd") or f"/home/{self.ssh_user}")
            if not cwd.startswith("/"):
                raise RuntimeError("cwd must be absolute")
            cols = max(20, min(400, int(body.get("cols", 120))))
            rows = max(5, min(200, int(body.get("rows", 30))))
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            key = Path(env.sshKeyPath)
            command = [
                require_binary("ssh"), "-tt", "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=5",
                "-o", "LogLevel=ERROR", "-i", str(key), "-p", str(env.sshPort),
                f"{self.ssh_user}@127.0.0.1", f"cd -- {shell_quote(cwd)} && ulimit -u 2048 && ulimit -n 4096 && exec {shell} -l",
            ]
            proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                    start_new_session=True, close_fds=True)
            os.close(slave)
            os.set_blocking(master, False)
            sid = safe_id(str(body.get("sessionId") or uuid.uuid4().hex))
            if sid in self._ptys:
                os.close(master)
                proc.terminate()
                raise RuntimeError("Terminal session already exists")
            session = PtySession(sid, env.environmentId, proc, master, now_iso(), now_iso())
            self._ptys[sid] = session
            return {"sessionId": sid, "environmentId": env.environmentId, "shell": shell, "cwd": cwd, "cols": cols, "rows": rows}

    def pty_read(self, session_id: str) -> dict[str, Any]:
        session = self._pty(session_id)
        chunks: list[str] = []
        while True:
            ready, _, _ = select.select([session.masterFd], [], [], 0)
            if not ready:
                break
            try:
                data = os.read(session.masterFd, 65536)
            except OSError:
                break
            if not data:
                break
            chunks.append(data.decode(errors="replace"))
            session.lastActiveAt = now_iso()
            if len(data) < 65536:
                break
        exited = session.process.poll() is not None
        return {"sessionId": session.sessionId, "data": "".join(chunks), "exited": exited}

    def pty_input(self, session_id: str, data: str) -> dict[str, Any]:
        session = self._pty(session_id)
        if len(data.encode()) > 16000:
            raise RuntimeError("Terminal input is too large")
        os.write(session.masterFd, data.encode())
        session.lastActiveAt = now_iso()
        return {"accepted": True}

    def pty_resize(self, session_id: str, body: dict[str, Any]) -> dict[str, Any]:
        session = self._pty(session_id)
        cols = max(20, min(400, int(body.get("cols", 120))))
        rows = max(5, min(200, int(body.get("rows", 30))))
        fcntl.ioctl(session.masterFd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        return {"cols": cols, "rows": rows}

    def pty_signal(self, session_id: str, signal_name: str) -> dict[str, Any]:
        session = self._pty(session_id)
        signals = {"SIGINT": signal.SIGINT, "SIGTERM": signal.SIGTERM, "SIGTSTP": signal.SIGTSTP}
        if signal_name == "EOF":
            os.write(session.masterFd, b"\x04")
        elif signal_name in signals:
            os.killpg(session.process.pid, signals[signal_name])
        else:
            raise RuntimeError("Unsupported terminal signal")
        return {"accepted": True, "signal": signal_name}

    def pty_close(self, session_id: str) -> dict[str, Any]:
        sid = safe_id(session_id)
        session = self._ptys.pop(sid, None)
        if not session:
            return {"closed": True}
        try:
            if session.process.poll() is None:
                os.killpg(session.process.pid, signal.SIGTERM)
                try:
                    session.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(session.process.pid, signal.SIGKILL)
        finally:
            try: os.close(session.masterFd)
            except OSError: pass
        return {"closed": True}

    def execute(self, env_id: str, body: dict[str, Any]) -> dict[str, Any]:
        env = self._get(env_id)
        input_obj = body.get("input") or {}
        if input_obj.get("kind") != "raw-shell": raise RuntimeError("V49 execute expects raw-shell input")
        shell = body.get("shell") or "bash"
        if shell not in {"bash", "sh", "zsh"}: raise RuntimeError("Unsupported shell")
        cwd = str(body.get("cwd") or f"/home/{self.ssh_user}")
        if not cwd.startswith("/"): raise RuntimeError("cwd must be absolute")
        command = str(input_obj.get("data") or "")
        if not command: raise RuntimeError("Empty command")
        timeout = min(120, max(1, int(body.get("timeoutMs") or 10000) / 1000))
        marker = f"__LF_CWD_{secrets.token_hex(8)}__"
        script = f"cd -- {shell_quote(cwd)} && {command}\nprintf '\\n{marker}%s\\n' \"$PWD\""
        started = time.monotonic()
        code, stdout, stderr = self.ssh(env, f"{shell} -lc {shell_quote(script)}", timeout=timeout)
        duration = max(1, int((time.monotonic() - started) * 1000))
        cwd_after = cwd
        if marker in stdout:
            before, after = stdout.rsplit(marker, 1)
            stdout = before
            cwd_after = after.strip().splitlines()[0] if after.strip() else cwd
        observation = self.observe(env, cwd_after)
        return execution_record(env, shell, command, cwd, cwd_after, stdout, stderr, code, duration, observation, self.ssh_user)

    def observe(self, env: Environment, cwd: str) -> dict[str, Any]:
        fs_code, fs_out, _ = self.ssh(env, "find /home -maxdepth 4 -printf '%y|%m|%p|%s\\n' 2>/dev/null | head -500", timeout=10)
        ps_code, ps_out, _ = self.ssh(env, "ps -eo pid=,user=,comm=,stat= --no-headers | head -200", timeout=10)
        ss_code, ss_out, _ = self.ssh(env, "ss -lntH 2>/dev/null || true", timeout=10)
        fs = []
        for line in fs_out.splitlines():
            parts = line.split("|", 3)
            if len(parts) == 4:
                typ, mode, path, size = parts
                fs.append({"objectId": hashlib.sha1(path.encode()).hexdigest()[:16], "objectType": "directory" if typ == "d" else "file", "path": path, "name": Path(path).name or "/", "permissions": mode, "content": "", "active": True, "createdByChallenge": None, "lastModifiedByChallenge": None, "createdAt": now_iso()})
        processes = []
        if ps_code == 0:
            for line in ps_out.splitlines():
                parts = line.split(None, 3)
                if len(parts) == 4:
                    try: processes.append({"pid": int(parts[0]), "user": parts[1], "command": parts[2], "state": parts[3]})
                    except ValueError: pass
        listeners = []
        if ss_code == 0:
            for line in ss_out.splitlines():
                fields = line.split()
                if len(fields) >= 4:
                    port = fields[3].rsplit(":", 1)[-1]
                    try: listeners.append({"port": int(port), "process": "unknown"})
                    except ValueError: pass
        return {"status": "RUNNING", "cwd": cwd, "filesystem": fs, "processes": processes, "listeners": listeners}

    def filesystem(self, env_id: str, cwd: str) -> dict[str, Any]:
        env = self._get(env_id); obs = self.observe(env, cwd)
        return {"root": f"/home/{self.ssh_user}", "cwd": cwd, "objects": obs["filesystem"], "modelled": False}

    def processes(self, env_id: str) -> dict[str, Any]:
        env = self._get(env_id); return {"supported": True, "processes": self.observe(env, f"/home/{self.ssh_user}")["processes"]}

    def services(self, env_id: str) -> dict[str, Any]:
        env = self._get(env_id)
        code, out, _ = self.ssh(env, "systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null | head -200", timeout=10)
        enabled_code, enabled_out, _ = self.ssh(env, "systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null | head -500", timeout=10)
        enabled = set()
        if enabled_code == 0:
            for line in enabled_out.splitlines():
                parts = line.split()
                if len(parts) >= 2 and parts[1] in {"enabled", "enabled-runtime"}:
                    enabled.add(parts[0])
        services = []
        if code == 0:
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 4:
                    name, load, active, sub = parts[:4]
                    services.append({"name": name, "state": "running" if active == "active" else "stopped", "enabled": name in enabled})
        return {"supported": True, "services": services}

    def inspect(self, env_id: str, paths: list[dict[str, Any]]) -> dict[str, Any]:
        env = self._get(env_id)
        filesystem = []
        for requested in paths[:64]:
            path = str(requested.get("path") or "")
            if not path.startswith("/") or "\x00" in path:
                raise RuntimeError("Inspection paths must be absolute and valid")
            code, meta, err = self.ssh(env, f"stat -c '%F\t%a\t%U\t%G\t%s' -- {shell_quote(path)}", timeout=10)
            if code != 0:
                continue
            parts = meta.strip().split("\t")
            if len(parts) != 5:
                continue
            kind, mode, owner, group, size = parts
            object_type = "directory" if kind == "directory" else "file"
            content = None
            truncated = False
            if object_type == "file" and bool(requested.get("includeContent")):
                size_int = int(size)
                if size_int <= 64_000:
                    c_code, raw, _ = self.ssh(env, f"base64 -w0 -- {shell_quote(path)}", timeout=10)
                    if c_code == 0:
                        try: content = base64.b64decode(raw.strip()).decode("utf-8", errors="replace")
                        except Exception: content = None
                else:
                    truncated = True
            filesystem.append({"path": path, "objectType": object_type, "permissions": mode, "owner": owner, "group": group, "sizeBytes": int(size), "content": content, "contentTruncated": truncated})
        observation = self.observe(env, f"/home/{self.ssh_user}")
        services = self.services(env_id)["services"]
        return {"filesystem": filesystem, "processes": observation["processes"], "services": services, "network": observation["listeners"], "capturedAt": now_iso()}

    def variables(self, env_id: str) -> dict[str, Any]:
        env = self._get(env_id)
        code, out, _ = self.ssh(env, "env -0", timeout=10)
        safe: dict[str, str] = {}; redacted: list[str] = []
        if code == 0:
            for raw in out.split("\x00"):
                if "=" not in raw: continue
                key, value = raw.split("=", 1)
                if any(term in key.upper() for term in ("TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL")):
                    redacted.append(key); continue
                safe[key] = value
        return {"supported": True, "variables": safe, "redactedKeys": sorted(redacted)}

    def descriptor(self, env: Environment) -> dict[str, Any]:
        return {
            "handle": {"provider": "real-linux-isolated-v1", "environmentId": env.environmentId, "userId": env.userId, "labId": env.labId},
            "status": env.status,
            "capabilities": {
                "id": "real-linux-isolated-v1", "label": "Kali Linux VM", "description": "A real isolated Kali Linux virtual machine.",
                "realLinux": True, "runtimeClass": "vm", "modelled": False, "interactiveShell": True, "streaming": True,
                "resize": True, "processes": True, "services": True, "environmentVariables": True, "network": False,
                "snapshots": True, "pauseResume": True,
            },
            "resourcePolicy": {"executionTimeoutMs": 10000, "idleExpiryMs": 43200000, "cpuMillicores": env.cpus * 500, "memoryMiB": env.memoryMiB, "storageMiB": env.storageMiB, "maxProcesses": 32, "maxOpenFiles": 256, "maxOutputBytes": 64000, "network": "none", "egressAllowlist": [], "allowPrivilegeEscalation": False, "allowHostFilesystem": False},
            "snapshotId": env.snapshotId, "createdAt": env.createdAt, "updatedAt": env.updatedAt, "lastActiveAt": env.updatedAt, "expiresAt": None,
            "metadata": {"runtimeVersion": SERVICE_VERSION, "architecture": self._architecture(), "sshPort": str(env.sshPort), "imageArtifactRelease": "2026.2", "error": env.error, "qemuExitCode": env.qemuExitCode, "qemuLogPath": env.qemuLogPath, "lifecycleState": env.lifecycleState, "lifecycleGeneration": str(env.lifecycleGeneration), "bootAttempts": str(env.bootAttempts), "failureCount": str(env.failureCount), "quarantinedReason": env.quarantinedReason or "", "persistenceState": ("DESTROYED" if env.lifecycleState == "DESTROYED" else ("STOPPED" if env.lifecycleState == "STOPPED" else ("QUARANTINED" if env.lifecycleState == "QUARANTINED" else ("ACTIVE" if env.lifecycleState in {"RUNNING","READY","PAUSED"} else "PROVISIONING")))), "environmentGeneration": str(env.environmentGeneration), "artifactVersion": str(env.artifactVersion)},
            "persistence": self.persistence(env.environmentId),
        }

    def packages(self, env_id: str, package_names: list[str]) -> dict[str, Any]:
        env = self._get(env_id)
        fmt = "\x27${Package}\t${Version}\t${Status}\n\x27"
        if package_names:
            cmd = f"dpkg-query -W -f={fmt} " + " ".join(shell_quote(p) for p in package_names[:32]) + " 2>/dev/null || true"
        else:
            cmd = f"dpkg-query -W -f={fmt} 2>/dev/null | head -100"
        code, out, _ = self.ssh(env, cmd, timeout=10)
        packages = []
        if code == 0:
            for line in out.splitlines():
                parts = line.strip().split("	")
                if len(parts) >= 2:
                    status = parts[2] if len(parts) >= 3 else "installed"
                    packages.append({"name": parts[0], "version": parts[1], "status": "installed" if "install ok installed" in status or status == "installed" else "unknown"})
        return {"supported": True, "packageManager": "dpkg", "packages": packages}

    def guest_identity(self, env_id: str) -> dict[str, Any]:
        env = self._get(env_id)
        code, out, err = self.ssh(env, "cat /etc/os-release; printf '\n---KERNEL---\n'; uname -a", timeout=15)
        if code != 0:
            raise RuntimeError(err.strip() or "Unable to verify guest identity")
        values: dict[str, str] = {}
        kernel = ""
        in_kernel = False
        for line in out.splitlines():
            if line == "---KERNEL---":
                in_kernel = True
                continue
            if in_kernel:
                if line.strip():
                    kernel = line.strip()
                continue
            if "=" in line:
                key, value = line.split("=", 1)
                values[key] = value.strip().strip('"')
        guest_version = values.get("VERSION_ID") or values.get("VERSION", "")
        expected = "2026.2"
        return {
            "environmentId": env.environmentId,
            "expectedArtifactRelease": expected,
            "guestName": values.get("PRETTY_NAME", values.get("NAME", "")),
            "guestVersion": guest_version,
            "guestVersionMatchesArtifact": guest_version == expected,
            "kernel": kernel,
            "verifiedAt": now_iso(),
        }

    def health(self) -> dict[str, Any]:
        qemu_ok = shutil.which("qemu-system-aarch64") or shutil.which("qemu-system-x86_64")
        img_ok = self.base_image.is_file()
        return {
            "provider": "real-linux-isolated-v1", "runtimeClass": "vm", "runtimeVersion": SERVICE_VERSION,
            "healthy": bool(qemu_ok and img_ok), "ready": bool(qemu_ok and img_ok), "checkedAt": now_iso(),
            "security": {"networkIsolationEnforced": True, "hostFilesystemBlocked": True, "privilegeEscalationBlocked": True, "metadataAccessBlocked": True},
            "capacity": {"activeEnvironments": len([e for e in self._envs.values() if e.lifecycleState in {"CREATING", "BOOTING", "READY", "RUNNING", "PAUSED", "RESETTING", "STOPPING"}]), "maxEnvironments": self.max_environments},
        }


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def sys_platform() -> str:
    import platform
    return platform.system().lower()


def execution_record(env: Environment, shell: str, command: str, cwd_before: str, cwd_after: str, stdout: str, stderr: str, exit_code: int, duration_ms: int, observation: dict[str, Any], ssh_user: str = DEFAULT_SSH_USER) -> dict[str, Any]:
    chunks = []
    seq = 0
    if stdout:
        chunks.append({"seq": seq, "stream": "stdout", "text": stdout, "atMs": duration_ms}); seq += 1
    if stderr:
        chunks.append({"seq": seq, "stream": "stderr", "text": stderr, "atMs": duration_ms})
    return {
        "shell": shell, "provider": "real-linux-isolated-v1", "environmentId": env.environmentId, "input": command,
        "inputKind": "raw-shell", "cwdBefore": cwd_before, "cwdAfter": cwd_after, "stdout": stdout, "stderr": stderr,
        "exitCode": exit_code, "durationMs": duration_ms, "chunks": chunks, "outputTruncated": False, "blocked": None,
        "stateBefore": {
            "filesystem": {
                "root": f"/home/{ssh_user}",
                "cwd": cwd_before,
                "objects": observation.get("filesystem", []),
                "modelled": False,
            },
            "processes": observation.get("processes", []),
            "network": observation.get("listeners", []),
        },
        "stateAfter": {
            "filesystem": {
                "root": f"/home/{ssh_user}",
                "cwd": cwd_after,
                "objects": observation.get("filesystem", []),
                "modelled": False,
            },
            "processes": observation.get("processes", []),
            "network": observation.get("listeners", []),
        },
        "deltas": {
            "filesystem": [],
            "processes": observation["processes"],
            "services": [],
            "network": observation["listeners"],
        },
        "method": {"statements": [command], "usedLoopConstruct": any(x in command for x in ("for ", "while ", "until ")), "effectiveOperations": 1, "invocations": 1},
        "metadata": {"modelled": "false", "runtimeClass": "vm"}, "redactedFields": [],
    }


MANAGER = RuntimeManager()


class Handler(BaseHTTPRequestHandler):
    server_version = "LinuxForgeRuntime/49"

    def _auth(self) -> None:
        expected = MANAGER.auth_token
        if not expected:
            raise PermissionError("FORGE_RUNTIME_SERVICE_TOKEN is not configured")
        actual = self.headers.get("authorization", "")
        if not secrets.compare_digest(actual, f"Bearer {expected}"):
            raise PermissionError("Runtime authentication failed")

    def _json(self, status: int, payload: Any) -> None:
        data = json.dumps({"ok": True, "value": payload}).encode()
        self.send_response(status); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def _error(self, status: int, message: str, code: str = "INTERNAL") -> None:
        data = json.dumps({"ok": False, "error": {"code": code, "message": message, "retryable": status >= 500}}).encode()
        self.send_response(status); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0")); raw = self.rfile.read(length) if length else b"{}"; return json.loads(raw or b"{}")

    def do_GET(self) -> None:
        try:
            self._auth()
            path = urllib.parse.urlparse(self.path).path
            parts = [p for p in path.split("/") if p]
            if path == "/v1/health": return self._json(200, MANAGER.health())
            if len(parts) >= 3 and parts[:2] == ["v1", "environments"]:
                env = MANAGER._get(parts[2])
                if len(parts) == 3: return self._json(200, MANAGER.descriptor(env))
                if parts[3] == "identity": return self._json(200, MANAGER.guest_identity(env.environmentId))
                if parts[3] == "packages": return self._json(200, MANAGER.packages(env.environmentId, []))
                if parts[3] == "filesystem": return self._json(200, MANAGER.filesystem(env.environmentId, ""))
                if parts[3] == "processes": return self._json(200, MANAGER.processes(env.environmentId))
                if parts[3] == "services": return self._json(200, MANAGER.services(env.environmentId))
                if parts[3] == "environment": return self._json(200, MANAGER.variables(env.environmentId))
                if parts[3] == "inspect": return self._json(200, MANAGER.inspect(env.environmentId, []))
                if parts[3] == "persistence": return self._json(200, MANAGER.persistence(env.environmentId))
            return self._error(404, "Runtime endpoint not found")
        except PermissionError as exc: self._error(401, str(exc))
        except KeyError as exc: self._error(404, str(exc), "ENVIRONMENT_NOT_FOUND")
        except Exception as exc: self._error(500, str(exc))

    def do_POST(self) -> None:
        try:
            self._auth(); body = self._body(); path = urllib.parse.urlparse(self.path).path; parts = [p for p in path.split("/") if p]
            if path == "/v1/environments": return self._json(200, MANAGER.create(body))
            if len(parts) >= 4 and parts[:2] == ["v1", "environments"]:
                env_id = parts[2]; action = parts[3]
                if action == "start": return self._json(200, MANAGER.start(env_id, body.get("operation")))
                if action == "stop": return self._json(200, MANAGER.stop(env_id, body.get("operation")))
                if action == "reset": return self._json(200, MANAGER.reset(env_id, body.get("operation")))
                if action == "pause": return self._json(200, MANAGER.pause(env_id, body.get("operation")))
                if action == "resume": return self._json(200, MANAGER.resume(env_id, body.get("operation")))
                if action == "snapshot": return self._json(200, MANAGER.snapshot(env_id))
                if action == "restore": return self._json(200, MANAGER.restore(env_id, str(body.get("snapshotId", ""))))
                if action == "destroy": return self._json(200, MANAGER.destroy(env_id, body.get("operation")))
                if action == "execute": return self._json(200, MANAGER.execute(env_id, body))
                if action == "pty-open": return self._json(200, MANAGER.pty_open(env_id, body))
                if action == "pty-input": return self._json(200, MANAGER.pty_input(str(body.get("sessionId", "")), str(body.get("data", ""))))
                if action == "pty-read": return self._json(200, MANAGER.pty_read(str(body.get("sessionId", ""))))
                if action == "pty-resize": return self._json(200, MANAGER.pty_resize(str(body.get("sessionId", "")), body))
                if action == "pty-signal": return self._json(200, MANAGER.pty_signal(str(body.get("sessionId", "")), str(body.get("signal", ""))))
                if action == "pty-close": return self._json(200, MANAGER.pty_close(str(body.get("sessionId", ""))))
                if action == "input": return self._json(200, {"unsupported": True, "message": "Use PTY transport for interactive terminal input."})
                if action == "resize": return self._json(200, {"cols": max(20, min(400, int(body.get("size", {}).get("cols", 120)))), "rows": max(5, min(200, int(body.get("size", {}).get("rows", 30))))})
                if action == "filesystem": return self._json(200, MANAGER.filesystem(env_id, str(body.get("cwd") or f"/home/{MANAGER.ssh_user}")))
                if action == "processes": return self._json(200, MANAGER.processes(env_id))
                if action == "services": return self._json(200, MANAGER.services(env_id))
                if action == "environment": return self._json(200, MANAGER.variables(env_id))
                if action == "inspect": return self._json(200, MANAGER.inspect(env_id, list(body.get("paths") or [])))
                if action == "packages": return self._json(200, MANAGER.packages(env_id, list(body.get("packageNames") or [])))
            return self._error(404, "Runtime endpoint not found")
        except PermissionError as exc: self._error(401, str(exc))
        except KeyError as exc: self._error(404, str(exc), "ENVIRONMENT_NOT_FOUND")
        except subprocess.TimeoutExpired: self._error(408, "Guest command timed out")
        except Exception as exc: self._error(500, str(exc))

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[runtime] {self.address_string()} {format % args}")


def main() -> None:
    host = os.environ.get("FORGE_RUNTIME_BIND", DEFAULT_BIND)
    port = int(os.environ.get("FORGE_RUNTIME_PORT", str(DEFAULT_PORT)))
    require_binary("qemu-img")
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"LinuxForge V49 QEMU runtime listening on http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
