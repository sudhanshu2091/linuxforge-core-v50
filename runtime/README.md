# LinuxForge Runtime Services (v50)

These processes run in the infrastructure/runtime plane on dedicated host workers, completely isolated from the learner browser and outside the TanStack application process.

## 1. Production MicroVM Data Plane

Hardware-isolated microVM data plane supporting Firecracker and Cloud Hypervisor:

```bash
FORGE_RUNTIME_SERVICE_TOKEN='...' \
FORGE_RUNTIME_DATA_DIR='/var/lib/linuxforge-microvm' \
python3 runtime/microvm-runtime.py
```

Default listener: `127.0.0.1:18082`.

### Production Security Invariants:
- Requires KVM (`/dev/kvm`); fails closed with `ERROR` status if hardware virtualization is absent.
- Pinned immutable image reference check (`image@sha256:<64 hex chars>`).
- Zero host filesystem mounts; zero Docker or hypervisor control sockets exposed to guest.
- Network policy: `DENY` egress default; cloud metadata (`169.254.169.254`) and host loopback strictly blocked.
- PTY terminal streaming session support matching the terminal gateway contract.

---

## 2. Development QEMU Runtime

Local development VM runtime:

```bash
FORGE_RUNTIME_SERVICE_TOKEN='...' \
FORGE_RUNTIME_IMAGE_PATH='/path/to/kali.qcow2' \
FORGE_RUNTIME_IMAGE_REF='kali-2026.2-arm64' \
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
