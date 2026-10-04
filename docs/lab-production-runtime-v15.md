# LinuxForge production runtime boundary v15 & v50

v50 completes the LinuxForge production runtime and host execution boundary, establishing a clear separation between local development and multi-tenant production execution.

## Architectural Boundary

```text
Learner Browser
  |
  | authenticated short-lived PTY ticket
  v
LinuxForge Application Server
  |
  | durable lab control plane / lab_jobs queue
  v
Production Host Pool & Worker Execution Plane
  |
  | capacity-aware placement / atomic lease & heartbeat
  v
Production Sandbox Provider (`ProductionVmSandboxProvider`)
  |
  | authenticated HTTPS REST contract (Bearer token)
  v
Dedicated Production VM / MicroVM Runtime (`runtime/microvm-runtime.py` / Cloud Hypervisor / Firecracker)
  |
  v
Isolated Guest VM (guest root hostile to host; egress DENY default; no metadata/host mount)
```

The browser never receives runtime credentials or connects directly to the hypervisor, QEMU monitor, Firecracker API, or host PTY.

---

## Concrete Production Hypervisor Backend: QEMU

LinuxForge Core designates **QEMU** (hardware-accelerated via KVM on Linux x86_64, HVF on Apple Silicon macOS, or TCG emulation when configured) as the primary concrete isolated guest backend in this codebase (`runtime/qemu-runtime.py`).

The provider boundary remains provider-neutral (`SandboxProvider` / `ProductionVmSandboxProvider`), with `runtime/microvm-runtime.py` maintaining capability detection for microVM hypervisors (Firecracker / Cloud Hypervisor) that fails closed when required virtualization and jailer binaries are absent on the host.

### Host Prerequisites
Running real guest execution requires the following host components:
1. **Hypervisor Binary**: `qemu-system-x86_64` (or `qemu-system-aarch64`).
2. **Virtualization Acceleration**: `/dev/kvm` accessible with read/write permissions (on Linux) or HVF (on macOS).
3. **Cloud-Init Seed Tool**: `cloud-localds`, `genisoimage`, or `xorriso` for generating the NoCloud `seed.iso`.
4. **SSH Tools**: `ssh` and `ssh-keygen` for guest readiness and control plane transport.
5. **Disk Utility**: `qemu-img` for cloning and resizing qcow2 overlays.
6. **Approved Base Image**: Controlled local Kali Linux qcow2 base image artifact pointed to by `FORGE_RUNTIME_IMAGE_PATH`.

When any host prerequisite is absent, the runtime explicitly **fails closed** during capability checks and environment start, reporting the exact missing prerequisite without faking execution.

---

## Detailed Subsystem Implementations

### 1. Immutable Image Resolution
- Requested image references must adhere to `image@sha256:<64 hex chars>`.
- The repository prefix is validated against `APPROVED_IMAGE_PREFIXES` (`kali-linux`, `linuxforge/kali`, `quay.io/linuxforge/kali`, `ghcr.io/sudhanshu2091/linuxforge-kali`).
- Path traversals, arbitrary filesystem paths (`/`, `./`, `..`), and mutable tags (`:latest`) are rejected server-side.
- The SHA-256 digest is verified against the host base image artifact. If the artifact is missing or the digest mismatches, the runtime fails closed.

### 2. Isolated Guest Provisioning & Storage
- Each environment receives a unique runtime directory (`data_dir / safe_id(environmentId)`).
- Dedicated per-environment storage:
  - Copy-on-write qcow2 overlay (`root.qcow2`) cloned from the approved base image.
  - Safe disk expansion via `qemu-img resize` to ensure the disk never shrinks below backing image size.
  - Per-environment Ed25519 SSH keypair (`id_ed25519`, permissions `0600`).
  - Per-environment cloud-init `user-data` and `meta-data` packaged into `seed.iso`.
- No host filesystem mounts (`-virtfs` / 9p is strictly prohibited).

### 3. Network Isolation
- QEMU user-mode slirp network is launched with:
  `-netdev user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:{sshPort}-:22`
  `-device virtio-net-pci,netdev=net0`
- With `restrict=on`:
  - Guest-to-host and guest-to-Internet communication is completely blocked (egress DENY).
  - Cloud metadata service (`169.254.169.254` and `metadata.google.internal`) is unreachable.
  - Cross-tenant / guest-to-guest traffic is strictly prevented.
  - Only the host control-plane can connect to `127.0.0.1:{sshPort}` forwarded to guest port 22.

### 4. Real Guest Readiness
- Rather than a fake timer, `_wait_for_ssh` polls the guest:
  1. Checks that the hypervisor process is alive (if it exited early, captures exit code and `qemu.log` tail and marks state `FAILED`).
  2. Probes TCP port `127.0.0.1:{sshPort}`.
  3. Executes an authenticated SSH probe (`ssh -o BatchMode=yes -i {key} -p {port} {user}@127.0.0.1 true`).
  4. Only transitions to `READY` and `RUNNING` after authenticated SSH verification succeeds.

### 5. Real Command Execution
- The `execute` endpoint requires the environment to be `RUNNING`.
- Learner commands are shell-quoted and dispatched strictly inside the guest via SSH.
- Returns real stdout, stderr, exit code, execution duration, and guest observation deltas (filesystem, processes, listening ports).
- Learner commands are never executed on the host.

### 6. Real Interactive PTY
- `pty_open` creates a genuine host pseudo-terminal (`pty.openpty()`), configures terminal geometry via `TIOCSWINSZ`, and connects into the guest shell via SSH.
- `pty_read` uses non-blocking `select.select` on master fd to stream real guest output.
- `pty_input` writes directly to master fd.
- `pty_resize` updates terminal rows/columns via `ioctl(TIOCSWINSZ)`.
- `pty_signal` delivers POSIX signals (`SIGINT`, `SIGTERM`, `SIGTSTP`, `EOF`).
- Browser clients connect via the hardened WebSocket terminal gateway (`runtime/terminal-gateway.py`), which validates HMAC tickets and proxies PTY operations to the runtime HTTP service.

### 7. Crash Recovery & Orphan Handling
- Environment state is atomically persisted to `state.json`.
- On service startup or reconciliation:
  - Verifies that recorded hypervisor PIDs are alive and match `qemu-system-` with the specific environment disk path (preventing PID-reuse race conditions).
  - Quarantines environments with unexpected process death.
  - Reconciles orphan hypervisor processes referencing runtime disks and terminates them.

### 8. Deterministic Teardown
- `destroy` gracefully terminates the guest via QMP `quit` (falling back to SIGTERM/SIGKILL), closes active PTY sessions, deletes disks and seeds, releases allocated ports, and persists a durable tombstone `state.json` marked `DESTROYED`.

---

## Production Security & Isolation Invariants

1. **Host Isolation**:
   - Zero host filesystem mounts.
   - Zero Docker sockets or hypervisor control sockets inside guest.
   - No host credentials or cloud provider metadata tokens inside guest.
2. **Network Isolation**:
   - Egress policy is `DENY` by default.
   - Cloud metadata service (`169.254.169.254`, `metadata.google.internal`) is strictly blocked.
   - Host loopback (`127.0.0.0/8`, `::1`) is strictly blocked.
   - Cross-tenant / cross-learner inter-VM communication is strictly blocked.
   - Lab-specific allowlists permit only explicitly authorized destination ports and protocols.
3. **Immutable Image Pinning**:
   - Mandatory reference format: `image@sha256:<64 hex characters>`.
   - Mutable tags (`:latest`) and arbitrary host paths are rejected server-side.
4. **Resource Quotas**:
   - Enforced by server-side validation (`production-resource-policy.ts`) and guest cgroups (CPU, memory, storage, process count, file descriptors, output bytes).
5. **Durable Lifecycle & Crash Recovery**:
   - States: `PROVISIONING` -> `STARTING` -> `READY`/`RUNNING` -> `STOPPING` -> `STOPPED` -> `DESTROYING` -> `DESTROYED`.
   - Unhealthy exits transition to durable `FAILED`/`ERROR`.
   - Stale worker leases and orphaned jobs are automatically reclaimed by `recoverExpiredJobs()`.
