#!/usr/bin/env python3
"""Fail-closed microVM provider boundary.

Firecracker/Cloud Hypervisor support is intentionally not implemented yet.
This service exposes truthful health information and rejects all guest
lifecycle/execution/PTY operations until a real hypervisor-backed data plane
is added. It must never simulate a guest.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import time
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional

SERVICE_VERSION = "v50-microvm-unimplemented-1"
DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 18082
IMMUTABLE_DIGEST_REGEX = re.compile(r"^.+@sha256:[0-9a-fA-F]{64}$")
IMPLEMENTATION_REASON = (
    "Firecracker/Cloud Hypervisor guest execution is not implemented in this runtime. "
    "The provider is intentionally unavailable until a real hypervisor-backed data plane exists."
)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def is_safe_id(value: str) -> bool:
    return bool(value) and len(value) <= 128 and all(
        c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in value
    )


@dataclass
class MicrovmCapabilities:
    kvm_available: bool
    firecracker_binary: Optional[str]
    cloud_hypervisor_binary: Optional[str]

    @property
    def hypervisor_type(self) -> str:
        if self.cloud_hypervisor_binary:
            return "cloud-hypervisor"
        if self.firecracker_binary:
            return "firecracker"
        return "none"

    @property
    def provider_executable(self) -> bool:
        # A binary alone is not enough: there is no implemented guest data plane.
        return False

    @property
    def missing_prerequisites(self) -> list[str]:
        missing: list[str] = []
        if not self.kvm_available:
            missing.append("/dev/kvm")
        if not self.firecracker_binary and not self.cloud_hypervisor_binary:
            missing.append("firecracker-or-cloud-hypervisor")
        missing.append("implemented-microvm-guest-data-plane")
        return missing


def detect_capabilities() -> MicrovmCapabilities:
    return MicrovmCapabilities(
        kvm_available=os.path.exists("/dev/kvm") and os.access("/dev/kvm", os.R_OK | os.W_OK),
        firecracker_binary=shutil.which("firecracker"),
        cloud_hypervisor_binary=shutil.which("cloud-hypervisor"),
    )


@dataclass
class ProductionEnvironment:
    environmentId: str
    userId: str
    labId: str
    imageRef: str
    status: str = "CREATING"
    lifecycleState: str = "CREATING"
    lifecycleGeneration: int = 1
    createdAt: str = field(default_factory=now_iso)
    updatedAt: str = field(default_factory=now_iso)
    lastActiveAt: str = field(default_factory=now_iso)
    error: Optional[str] = None


class MicrovmRuntimeManager:
    def __init__(self, data_dir: Optional[Path] = None, auth_token: Optional[str] = None):
        self.data_dir = data_dir or Path(os.environ.get("FORGE_RUNTIME_DATA_DIR", "/tmp/linuxforge-microvm"))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.auth_token = auth_token if auth_token is not None else os.environ.get("FORGE_RUNTIME_SERVICE_TOKEN", "")
        self.capabilities = detect_capabilities()
        self.environments: Dict[str, ProductionEnvironment] = {}

    def _unavailable(self) -> RuntimeError:
        return RuntimeError(IMPLEMENTATION_REASON)

    def health(self) -> Dict[str, Any]:
        return {
            "provider": "real-linux-isolated-v1",
            "runtimeClass": "microvm",
            "runtimeVersion": SERVICE_VERSION,
            "healthy": True,
            "ready": False,
            "available": False,
            "configured": False,
            "executable": False,
            "reason": IMPLEMENTATION_REASON,
            "missingPrerequisites": self.capabilities.missing_prerequisites,
            "checkedAt": now_iso(),
            "capabilities": {
                "kvmAvailable": self.capabilities.kvm_available,
                "hypervisor": self.capabilities.hypervisor_type,
                "firecrackerAvailable": bool(self.capabilities.firecracker_binary),
                "cloudHypervisorAvailable": bool(self.capabilities.cloud_hypervisor_binary),
                "providerExecutable": False,
                "environmentCreated": False,
                "guestRunning": False,
                "commandExecution": False,
                "interactivePty": False,
            },
            "security": {
                "networkIsolationEnforced": False,
                "hostFilesystemBlocked": True,
                "privilegeEscalationBlocked": True,
                "metadataAccessBlocked": False,
            },
            "capacity": {"activeEnvironments": 0, "maxEnvironments": 0},
        }

    def create(self, body: Dict[str, Any]) -> Dict[str, Any]:
        # Creation is deliberately rejected rather than manufacturing a READY
        # environment that has no backing guest.
        image_ref = str(body.get("imageRef") or "")
        if not IMMUTABLE_DIGEST_REGEX.match(image_ref):
            raise ValueError(f"Production image reference must be pinned by sha256: '{image_ref}'")
        raise self._unavailable()

    def _get(self, env_id: str) -> ProductionEnvironment:
        env = self.environments.get(env_id)
        if not env:
            raise KeyError(f"Environment {env_id} not found")
        return env

    def descriptor(self, env: ProductionEnvironment) -> Dict[str, Any]:
        return {
            "handle": {
                "provider": "real-linux-isolated-v1",
                "environmentId": env.environmentId,
                "userId": env.userId,
                "labId": env.labId,
            },
            "status": env.status,
            "capabilities": {
                "id": "real-linux-isolated-v1",
                "label": "MicroVM provider (not configured)",
                "description": IMPLEMENTATION_REASON,
                "realLinux": False,
                "runtimeClass": "microvm",
                "modelled": False,
                "interactiveShell": False,
                "streaming": False,
                "resize": False,
                "processes": False,
                "services": False,
                "environmentVariables": False,
                "network": False,
                "snapshots": False,
                "pauseResume": False,
                "packages": False,
            },
            "resourcePolicy": {},
            "snapshotId": None,
            "createdAt": env.createdAt,
            "updatedAt": env.updatedAt,
            "lastActiveAt": env.lastActiveAt,
            "expiresAt": None,
            "metadata": {
                "runtimeVersion": SERVICE_VERSION,
                "runtimeClass": "microvm",
                "availability": "unavailable",
                "reason": IMPLEMENTATION_REASON,
            },
        }

    def start(self, env_id: str) -> Dict[str, Any]:
        self._get(env_id)
        raise self._unavailable()

    def stop(self, env_id: str) -> Dict[str, Any]:
        self._get(env_id)
        raise self._unavailable()

    def reset(self, env_id: str) -> Dict[str, Any]:
        self._get(env_id)
        raise self._unavailable()

    def pause(self, env_id: str) -> Dict[str, Any]:
        self._get(env_id)
        raise self._unavailable()

    def resume(self, env_id: str) -> Dict[str, Any]:
        self._get(env_id)
        raise self._unavailable()

    def destroy(self, env_id: str) -> Dict[str, Any]:
        env = self.environments.pop(env_id, None)
        return {"destroyed": env is not None, "environmentId": env_id}

    def execute(self, env_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
        self._get(env_id)
        raise self._unavailable()

    def pty_open(self, env_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
        self._get(env_id)
        raise self._unavailable()

    def pty_read(self, session_id: str) -> Dict[str, Any]:
        raise self._unavailable()

    def pty_input(self, session_id: str, data: str) -> Dict[str, Any]:
        raise self._unavailable()

    def pty_resize(self, session_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
        raise self._unavailable()

    def pty_signal(self, session_id: str, signal_name: str) -> Dict[str, Any]:
        raise self._unavailable()

    def pty_close(self, session_id: str) -> Dict[str, Any]:
        return {"closed": False, "sessionId": session_id, "reason": IMPLEMENTATION_REASON}


MICROVM_MANAGER = MicrovmRuntimeManager()


class MicrovmHandler(BaseHTTPRequestHandler):
    server_version = "LinuxForgeMicroVM/50"

    def _auth(self) -> None:
        expected = MICROVM_MANAGER.auth_token
        if not expected:
            return
        actual = self.headers.get("authorization", "")
        if not secrets.compare_digest(actual, f"Bearer {expected}"):
            raise PermissionError("Runtime authentication failed")

    def _json(self, status: int, payload: Any) -> None:
        data = json.dumps({"ok": True, "value": payload}).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, message: str, code: str = "INTERNAL") -> None:
        data = json.dumps({
            "ok": False,
            "error": {"code": code, "message": message, "retryable": status >= 500},
        }).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> Dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def do_GET(self) -> None:
        try:
            self._auth()
            path = urllib.parse.urlparse(self.path).path
            parts = [p for p in path.split("/") if p]
            if path == "/v1/health":
                return self._json(200, MICROVM_MANAGER.health())
            if len(parts) == 3 and parts[:2] == ["v1", "environments"]:
                return self._json(200, MICROVM_MANAGER.descriptor(MICROVM_MANAGER._get(parts[2])))
            return self._error(404, "Runtime endpoint not found")
        except PermissionError as exc:
            self._error(401, str(exc), "UNAUTHORIZED")
        except KeyError as exc:
            self._error(404, str(exc), "ENVIRONMENT_NOT_FOUND")
        except RuntimeError as exc:
            self._error(503, str(exc), "PROVIDER_NOT_CONFIGURED")
        except Exception as exc:
            self._error(500, str(exc))

    def do_POST(self) -> None:
        try:
            self._auth()
            body = self._body()
            path = urllib.parse.urlparse(self.path).path
            parts = [p for p in path.split("/") if p]
            if path == "/v1/environments":
                return self._json(503, MICROVM_MANAGER.create(body))
            if len(parts) >= 4 and parts[:2] == ["v1", "environments"]:
                env_id = parts[2]
                action = parts[3]
                if action == "destroy":
                    return self._json(200, MICROVM_MANAGER.destroy(env_id))
                if action in {"start", "stop", "reset", "pause", "resume"}:
                    return self._json(503, getattr(MICROVM_MANAGER, action)(env_id))
                if action == "execute":
                    return self._json(503, MICROVM_MANAGER.execute(env_id, body))
                if action == "pty-open":
                    return self._json(503, MICROVM_MANAGER.pty_open(env_id, body))
                if action == "pty-input":
                    return self._json(503, MICROVM_MANAGER.pty_input(str(body.get("sessionId", "")), str(body.get("data", ""))))
                if action == "pty-read":
                    return self._json(503, MICROVM_MANAGER.pty_read(str(body.get("sessionId", ""))))
                if action == "pty-resize":
                    return self._json(503, MICROVM_MANAGER.pty_resize(str(body.get("sessionId", "")), body))
                if action == "pty-signal":
                    return self._json(503, MICROVM_MANAGER.pty_signal(str(body.get("sessionId", "")), str(body.get("signal", ""))))
                if action == "pty-close":
                    return self._json(503, MICROVM_MANAGER.pty_close(str(body.get("sessionId", ""))))
            return self._error(404, "Runtime endpoint not found")
        except PermissionError as exc:
            self._error(401, str(exc), "UNAUTHORIZED")
        except KeyError as exc:
            self._error(404, str(exc), "ENVIRONMENT_NOT_FOUND")
        except ValueError as exc:
            self._error(400, str(exc), "BAD_REQUEST")
        except RuntimeError as exc:
            self._error(503, str(exc), "PROVIDER_NOT_CONFIGURED")
        except Exception as exc:
            self._error(500, str(exc))


def main() -> None:
    host = os.environ.get("FORGE_RUNTIME_BIND", DEFAULT_BIND)
    port = int(os.environ.get("FORGE_RUNTIME_PORT", str(DEFAULT_PORT)))
    httpd = ThreadingHTTPServer((host, port), MicrovmHandler)
    print(f"LinuxForge MicroVM provider boundary listening on http://{host}:{port} (fail-closed)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
