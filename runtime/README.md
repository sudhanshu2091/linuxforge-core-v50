# LinuxForge Runtime Services (v50)

These processes run in the infrastructure/runtime plane on dedicated host workers, completely isolated from the learner browser and outside the TanStack application process.

## 1. MicroVM provider boundary

The provider-neutral architecture reserves a `microvm` runtime class for future Firecracker or Cloud Hypervisor support. **That backend is not implemented in v50.**

`runtime/microvm-runtime.py` is intentionally fail-closed:

- health reports `available=false`, `configured=false`, `executable=false`, and `ready=false`;
- missing prerequisites include the unimplemented guest data plane, even if a hypervisor binary happens to be installed;
- environment creation, start/reset/resume, command execution, and PTY operations fail explicitly;
- no fake stdout/stderr, exit code, READY/RUNNING state, or simulated PTY is produced;
- no microVM capability such as processes, services, packages, network, snapshots, or interactive shell is advertised.

A future Firecracker/Cloud Hypervisor implementation must provide a real guest lifecycle, authenticated guest readiness, real command execution, and real PTY transport before this provider can report readiness.

---

## 2. Development QEMU Runtime

Local development VM runtime:

```bash
FORGE_RUNTIME_SERVICE_TOKEN='...' \
FORGE_RUNTIME_IMAGE_PATH='/path/to/kali.qcow2' \
FORGE_RUNTIME_IMAGE_REF='kali-linux@sha256:<64-hex-digest>' \
python3 runtime/qemu-runtime.py
```

Default listener: `127.0.0.1:18080`.

Intended for local development on Apple Silicon (QEMU + HVF) or local Linux workstations.

---

## 3. Browser Terminal Gateway (Hardened)

Edge WebSocket gateway for interactive PTY sessions:

```bash
FORGE_RUNTIME_SERVICE_TOKEN='...' \
FORGE_TERMINAL_TICKET_SECRET='at-least-32-random-bytes' \
FORGE_RUNTIME_HTTP_ENDPOINT='http://127.0.0.1:18082' \
FORGE_TERMINAL_ALLOWED_ORIGIN='https://linuxforge.app' \
python3 runtime/terminal-gateway.py
```

Default listener: `127.0.0.1:18081`.

### Gateway Hardening Properties:
- Full RFC 6455 protocol validation: requires client frame masking, enforces frame size limits (`16KB`), fragmented frame assembly with maximum message size bounds (`64KB`), and clean close frames.
- Connection limits and resource exhaustion protection: thread-safe `ConnectionLimiter` with configurable limits (`FORGE_TERMINAL_MAX_CONNECTIONS`), idle timeout (`300s`), and maximum session duration (`3600s`).
- Short-lived HMAC ticket validation binding `userId`, `labId`, `environmentId`, `sessionId`, `bindingGeneration`, and `runtimeLifecycleGeneration`.
- Input validation: JSON schema validation, input string type and byte bounds, integer resize bounds, signal whitelisting (`SIGINT`, `SIGTERM`, `SIGTSTP`, `EOF`).
- Server credentials and internal tokens are never transmitted to the browser.
