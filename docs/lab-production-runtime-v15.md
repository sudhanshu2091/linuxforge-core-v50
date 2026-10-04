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

## Development vs Production Environments

### Development Environment
- **Adapter**: `sandbox-runtime/` (Kali + Docker + PRoot) or local `runtime/qemu-runtime.py`.
- **Runtime Class**: `container-dev` or local `vm`.
- **Intended Use**: Local developer machines (Mac Apple Silicon with HVF, local Linux without dedicated virtualization node).
- **Constraints**: Refuses `SANDBOX_RUNTIME_MODE=production`. Not intended for multi-tenant deployments.

### Production Environment
- **Provider**: `ProductionVmSandboxProvider` (`src/lib/forge/sandbox/production-vm-provider.server.ts`).
- **Data Plane**: Hardware-accelerated microVM or dedicated VM nodes (`runtime/microvm-runtime.py` / Cloud Hypervisor / Firecracker / KVM).
- **Host Pool**: `ProductionHostPool` (`src/lib/forge/sandbox/production-host-pool.server.ts`) managing capacity, placement, heartbeats, and worker lease lifecycles.
- **Runtime Class**: `vm` or `microvm` strictly.
- **Endpoint**: Dedicated virtualization nodes reached via authenticated HTTPS.
- **Fail-Closed Gate**: If hardware virtualization (`/dev/kvm`), immutable image pinning, or isolation invariants are missing, production admission fails closed immediately.

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
