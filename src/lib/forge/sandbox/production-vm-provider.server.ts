/**
 * LinuxForge Production Dedicated VM/MicroVM Sandbox Provider.
 *
 * Dedicated production implementation of SandboxProvider.
 * Enforces:
 * - RuntimeClass: 'vm' | 'microvm'
 * - Immutable image reference pinned by sha256 digest
 * - Strict resource bounding and validation
 * - Network isolation (deny-by-default egress)
 * - Authenticated control-plane <-> runtime communication
 * - Fails closed if host or runtime isolation cannot be guaranteed
 */

import {
  REAL_LINUX_PROVIDER_ID,
  providerFail,
  providerOk,
  type CreateEnvironmentRequest,
  type EnvironmentDescriptor,
  type EnvironmentHandle,
  type EnvironmentInspection,
  type EnvironmentPersistence,
  type EnvironmentVariablesState,
  type ExecutionRecord,
  type ExecutionRequest,
  type FilesystemState,
  type InspectionPath,
  type PackageState,
  type ProcessState,
  type ProviderCapabilities,
  type ProviderResult,
  type RuntimeClass,
  type RuntimeHealth,
  type SandboxProvider,
  type ServiceState,
  type SnapshotRef,
} from "./contract";
import { assertProductionRuntimeSpec, buildRuntimeLaunchSpec } from "./runtime-admission";
import { validateProductionResourcePolicy } from "./production-resource-policy";
import { validateProductionNetworkPolicy } from "./production-network-policy";
import { validateProductionImageRef } from "./production-image";

export type ProductionVmProviderConfig = {
  endpoint: string;
  credential: string;
  imageRef: string;
  runtimeClass: "vm" | "microvm";
  production: true;
  requestTimeoutMs?: number;
};

export const PRODUCTION_VM_CAPABILITIES: ProviderCapabilities = {
  id: REAL_LINUX_PROVIDER_ID,
  label: "Isolated Kali Linux VM",
  description: "A production-grade, hardware-isolated Linux VM runtime.",
  realLinux: true,
  runtimeClass: "vm",
  modelled: false,
  interactiveShell: true,
  streaming: true,
  resize: true,
  processes: true,
  services: true,
  environmentVariables: true,
  network: true,
  snapshots: true,
  pauseResume: true,
  packages: true,
};

export class ProductionVmSandboxProvider implements SandboxProvider {
  public readonly capabilities: ProviderCapabilities;

  constructor(private readonly config: ProductionVmProviderConfig) {
    if (!config.endpoint || !config.credential || !config.imageRef) {
      throw new Error("Production VM provider requires endpoint, credential, and imageRef.");
    }
    if (config.runtimeClass !== "vm" && config.runtimeClass !== "microvm") {
      throw new Error(
        `Production VM provider requires 'vm' or 'microvm' runtimeClass (got '${config.runtimeClass}').`,
      );
    }

    // Validate immutable image reference
    const imgValidation = validateProductionImageRef(config.imageRef);
    if (!imgValidation.ok) {
      throw new Error(imgValidation.error);
    }

    // Validate endpoint protocol
    const url = new URL(config.endpoint);
    if (
      config.production &&
      url.protocol !== "https:" &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost"
    ) {
      throw new Error("Production runtime endpoint must use HTTPS.");
    }

    this.capabilities = {
      ...PRODUCTION_VM_CAPABILITIES,
      runtimeClass: config.runtimeClass,
    };
  }

  private async call<T>(
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<ProviderResult<T>> {
    const url = `${this.config.endpoint.replace(/\/$/, "")}${path}`;
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.credential}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const payload = (await response.json()) as any;
      if (!response.ok) {
        const errorMsg = payload?.error?.message ?? `Runtime HTTP error ${response.status}`;
        const code = payload?.error?.code ?? "INTERNAL";
        return providerFail(code, errorMsg, response.status >= 500);
      }

      if (payload && payload.ok === true && payload.value !== undefined) {
        return providerOk(payload.value as T);
      }

      return providerOk(payload as T);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Runtime communication failure";
      return providerFail("INTERNAL", msg, true);
    }
  }

  private envPath(handle: EnvironmentHandle, suffix = ""): string {
    return `/v1/environments/${encodeURIComponent(handle.environmentId)}${suffix}`;
  }

  async createEnvironment(
    request: CreateEnvironmentRequest,
  ): Promise<ProviderResult<EnvironmentDescriptor>> {
    // 1. Validate resource policy
    const resValidation = validateProductionResourcePolicy(request.resourcePolicy);
    if (!resValidation.ok) {
      return providerFail("SAFETY_POLICY_BLOCKED", resValidation.error);
    }

    // 2. Validate network policy
    const netValidation = validateProductionNetworkPolicy({
      mode: resValidation.policy.network === "egress-allowlist" ? "EGRESS_ALLOWLIST" : "DENY",
      allowlist: resValidation.policy.egressAllowlist.map((dest) => ({
        destination: dest,
        port: 443,
        protocol: "tcp" as const,
      })),
    });
    if (!netValidation.ok) {
      return providerFail("SAFETY_POLICY_BLOCKED", netValidation.error);
    }

    // 3. Validate image
    const imgValidation = validateProductionImageRef(this.config.imageRef);
    if (!imgValidation.ok) {
      return providerFail("SAFETY_POLICY_BLOCKED", imgValidation.error);
    }

    // 4. Assert production admission
    try {
      const spec = buildRuntimeLaunchSpec(request, this.config.imageRef, this.config.runtimeClass);
      assertProductionRuntimeSpec(spec);
    } catch (err) {
      return providerFail(
        "SAFETY_POLICY_BLOCKED",
        err instanceof Error ? err.message : String(err),
      );
    }

    const payload = {
      environmentId: request.environmentId,
      userId: request.userId,
      labId: request.labId,
      imageRef: this.config.imageRef,
      resourcePolicy: resValidation.policy,
      metadata: {
        ...request.metadata,
        runtimeClass: this.config.runtimeClass,
        isolationEnforced: "true",
      },
    };

    return this.call<EnvironmentDescriptor>("/v1/environments", payload, 30_000);
  }

  async startEnvironment(
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<EnvironmentDescriptor>> {
    return this.call<EnvironmentDescriptor>(this.envPath(handle, "/start"), {});
  }

  async stopEnvironment(handle: EnvironmentHandle): Promise<ProviderResult<EnvironmentDescriptor>> {
    return this.call<EnvironmentDescriptor>(this.envPath(handle, "/stop"), {});
  }

  async resetEnvironment(
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<EnvironmentDescriptor>> {
    return this.call<EnvironmentDescriptor>(this.envPath(handle, "/reset"), {});
  }

  async pauseEnvironment(
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<EnvironmentDescriptor>> {
    return this.call<EnvironmentDescriptor>(this.envPath(handle, "/pause"), {});
  }

  async resumeEnvironment(
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<EnvironmentDescriptor>> {
    return this.call<EnvironmentDescriptor>(this.envPath(handle, "/resume"), {});
  }

  async snapshotEnvironment(handle: EnvironmentHandle): Promise<ProviderResult<SnapshotRef>> {
    return this.call<SnapshotRef>(this.envPath(handle, "/snapshot"), {});
  }

  async restoreEnvironment(
    handle: EnvironmentHandle,
    snapshotId: string,
  ): Promise<ProviderResult<EnvironmentDescriptor>> {
    return this.call<EnvironmentDescriptor>(this.envPath(handle, "/restore"), { snapshotId });
  }

  async destroyEnvironment(
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<{ destroyed: true }>> {
    return this.call<{ destroyed: true }>(this.envPath(handle, "/destroy"), {});
  }

  async executeCommand(request: ExecutionRequest): Promise<ProviderResult<ExecutionRecord>> {
    return this.call<ExecutionRecord>(this.envPath(request.handle, "/execute"), request, 20_000);
  }

  async sendInput(request: ExecutionRequest): Promise<ProviderResult<ExecutionRecord>> {
    return this.call<ExecutionRecord>(this.envPath(request.handle, "/execute"), request, 20_000);
  }

  async resizeTerminal(
    handle: EnvironmentHandle,
    size: { cols: number; rows: number },
  ): Promise<ProviderResult<{ cols: number; rows: number }>> {
    const cols = Math.max(20, Math.min(400, size.cols));
    const rows = Math.max(5, Math.min(200, size.rows));
    return this.call<{ cols: number; rows: number }>(this.envPath(handle, "/resize"), {
      size: { cols, rows },
    });
  }

  async getEnvironmentState(
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<EnvironmentDescriptor>> {
    return this.call<EnvironmentDescriptor>(this.envPath(handle));
  }

  async getEnvironmentPersistence(
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<EnvironmentPersistence>> {
    return this.call<EnvironmentPersistence>(this.envPath(handle, "/persistence"));
  }

  async getRuntimeHealth(): Promise<ProviderResult<RuntimeHealth>> {
    const healthResult = await this.call<RuntimeHealth>("/v1/health");
    if (!healthResult.ok) return healthResult;

    // Verify isolation guarantees reported by the runtime
    const h = healthResult.value;
    if (
      !h.security.hostFilesystemBlocked ||
      !h.security.privilegeEscalationBlocked ||
      !h.security.metadataAccessBlocked ||
      !h.security.networkIsolationEnforced
    ) {
      return providerFail(
        "SAFETY_POLICY_BLOCKED",
        "Runtime health verification failed: missing security guarantees.",
      );
    }

    return healthResult;
  }

  async getFilesystemState(
    handle: EnvironmentHandle,
    cwd: string,
  ): Promise<ProviderResult<FilesystemState>> {
    return this.call<FilesystemState>(this.envPath(handle, "/filesystem"), { cwd });
  }

  async getProcessState(handle: EnvironmentHandle): Promise<ProviderResult<ProcessState>> {
    return this.call<ProcessState>(this.envPath(handle, "/processes"));
  }

  async getServiceState(handle: EnvironmentHandle): Promise<ProviderResult<ServiceState>> {
    return this.call<ServiceState>(this.envPath(handle, "/services"));
  }

  async getEnvironmentVariables(
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<EnvironmentVariablesState>> {
    return this.call<EnvironmentVariablesState>(this.envPath(handle, "/environment"));
  }

  async inspectEnvironment(
    handle: EnvironmentHandle,
    paths: InspectionPath[],
  ): Promise<ProviderResult<EnvironmentInspection>> {
    return this.call<EnvironmentInspection>(this.envPath(handle, "/inspect"), { paths });
  }

  async getPackageState(
    handle: EnvironmentHandle,
    packageNames?: string[],
  ): Promise<ProviderResult<PackageState>> {
    return this.call<PackageState>(this.envPath(handle, "/packages"), { packageNames });
  }

  async getGuestIdentity(handle: EnvironmentHandle) {
    return this.call<{
      environmentId: string;
      expectedArtifactRelease: string;
      guestName: string;
      guestVersion: string;
      guestVersionMatchesArtifact: boolean;
      kernel: string;
      verifiedAt: string;
    }>(this.envPath(handle, "/identity"));
  }
}
