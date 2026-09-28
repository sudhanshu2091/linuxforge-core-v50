/** HTTP adapter for a genuinely isolated Linux lab runtime (VM/microVM/container). */

import {
  REAL_LINUX_PROVIDER_ID,
  providerFail,
  providerOk,
  type CreateEnvironmentRequest,
  type EnvironmentDescriptor,
  type EnvironmentHandle,
  type ExecutionRecord,
  type ExecutionRequest,
  type FilesystemState,
  type ProcessState,
  type ProviderCapabilities,
  type ProviderResult,
  type SandboxProvider,
  type ServiceState,
  type EnvironmentVariablesState,
  type SnapshotRef,
  type PackageState,
  type RuntimeHealth,
  type RuntimeClass,
  type InspectionPath,
  type EnvironmentInspection,
} from "./contract";
import { assertProductionRuntimeSpec, buildRuntimeLaunchSpec } from "./runtime-admission";

export const REAL_LINUX_CAPABILITIES: ProviderCapabilities = {
  id: REAL_LINUX_PROVIDER_ID,
  label: "Isolated Kali Linux lab",
  description: "A real Linux environment reached only through the isolated lab runtime.",
  realLinux: true,
  runtimeClass: "container-dev",
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

export type RealLinuxProviderConfig = {
  endpoint: string;
  credential: string;
  imageRef: string;
  runtimeClass: RuntimeClass;
  production: boolean;
};

export type RealLinuxProviderEnvironment = {
  FORGE_SANDBOX_ENDPOINT?: string | undefined;
  FORGE_SANDBOX_CREDENTIAL?: string | undefined;
  FORGE_SANDBOX_IMAGE?: string | undefined;
  FORGE_SANDBOX_RUNTIME_MODE?: string | undefined;
  FORGE_SANDBOX_RUNTIME_CLASS?: string | undefined;
};

export const REAL_LINUX_UNAVAILABLE_REASON =
  "No isolated Linux execution provider is configured. Set FORGE_SANDBOX_ENDPOINT, FORGE_SANDBOX_CREDENTIAL and FORGE_SANDBOX_IMAGE.";

const PRODUCTION_ADMISSION_ERROR =
  "Production isolated labs require HTTPS, a VM/microVM runtime class, and an immutable image digest.";

function currentEnvironment(): RealLinuxProviderEnvironment {
  return {
    FORGE_SANDBOX_ENDPOINT: process.env["FORGE_SANDBOX_ENDPOINT"],
    FORGE_SANDBOX_CREDENTIAL: process.env["FORGE_SANDBOX_CREDENTIAL"],
    FORGE_SANDBOX_IMAGE: process.env["FORGE_SANDBOX_IMAGE"],
    FORGE_SANDBOX_RUNTIME_MODE: process.env["FORGE_SANDBOX_RUNTIME_MODE"],
    FORGE_SANDBOX_RUNTIME_CLASS: process.env["FORGE_SANDBOX_RUNTIME_CLASS"],
  };
}

export function readRealLinuxProviderConfig(
  environment: RealLinuxProviderEnvironment = currentEnvironment(),
): RealLinuxProviderConfig | null {
  const endpoint = environment.FORGE_SANDBOX_ENDPOINT;
  const credential = environment.FORGE_SANDBOX_CREDENTIAL;
  const imageRef = environment.FORGE_SANDBOX_IMAGE;

  if (!endpoint || !credential || !imageRef) return null;

  const mode = environment.FORGE_SANDBOX_RUNTIME_MODE ?? "development";
  const runtimeClass = (environment.FORGE_SANDBOX_RUNTIME_CLASS ?? "container-dev") as RuntimeClass;
  const production = mode === "production";

  try {
    const url = new URL(endpoint);

    if (production && url.protocol !== "https:") {
      throw new Error(PRODUCTION_ADMISSION_ERROR);
    }

    if (production && runtimeClass !== "vm" && runtimeClass !== "microvm") {
      throw new Error(PRODUCTION_ADMISSION_ERROR);
    }

    if (production && !/^.+@sha256:[0-9a-f]{64}$/i.test(imageRef.trim())) {
      throw new Error(PRODUCTION_ADMISSION_ERROR);
    }

    if (!url.hostname) {
      throw new Error("Invalid runtime endpoint.");
    }
  } catch (error) {
    if (error instanceof Error && error.message === PRODUCTION_ADMISSION_ERROR) {
      throw error;
    }

    return null;
  }

  return {
    endpoint: endpoint.replace(/\/$/, ""),
    credential,
    imageRef,
    runtimeClass,
    production,
  };
}

export function realLinuxProviderAvailability(
  environment: RealLinuxProviderEnvironment = currentEnvironment(),
) {
  try {
    const configured = readRealLinuxProviderConfig(environment);

    return configured
      ? {
          available: true,
          reason: configured.production
            ? "Configured production VM/microVM runtime."
            : "Configured development isolated Linux runtime.",
        }
      : {
          available: false,
          reason: REAL_LINUX_UNAVAILABLE_REASON,
        };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : REAL_LINUX_UNAVAILABLE_REASON,
    };
  }
}

async function call<T>(
  config: RealLinuxProviderConfig,
  path: string,
  body?: unknown,
): Promise<ProviderResult<T>> {
  try {
    const response = await fetch(`${config.endpoint}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.credential}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });

    const payload = (await response.json()) as ProviderResult<T>;

    if (!response.ok) {
      return !payload.ok ? payload : providerFail("INTERNAL", `Runtime HTTP ${response.status}`);
    }

    return payload;
  } catch (error) {
    return providerFail(
      "INTERNAL",
      error instanceof Error ? error.message : "Unable to reach isolated lab runtime.",
      true,
    );
  }
}

const pathFor = (handle: EnvironmentHandle) =>
  `/v1/environments/${encodeURIComponent(handle.environmentId)}`;

export function createRealLinuxSandboxProvider(
  environment: RealLinuxProviderEnvironment = currentEnvironment(),
): SandboxProvider {
  const config = readRealLinuxProviderConfig(environment);

  if (!config) {
    throw new Error(REAL_LINUX_UNAVAILABLE_REASON);
  }

  const capabilities: ProviderCapabilities = {
    ...REAL_LINUX_CAPABILITIES,
    runtimeClass: config.runtimeClass,
  };

  return {
    capabilities,

    createEnvironment: (request: CreateEnvironmentRequest) => {
      const runtime = buildRuntimeLaunchSpec(request, config.imageRef, config.runtimeClass);

      if (config.production) {
        assertProductionRuntimeSpec(runtime);
      }

      return call<EnvironmentDescriptor>(config, "/v1/environments", {
        ...request,
        ...(request.environmentId ? { environmentId: request.environmentId } : {}),
        runtime,
      });
    },

    startEnvironment: (handle) =>
      call<EnvironmentDescriptor>(config, `${pathFor(handle)}/start`, { handle }),

    stopEnvironment: (handle) =>
      call<EnvironmentDescriptor>(config, `${pathFor(handle)}/stop`, { handle }),

    executeCommand: (request: ExecutionRequest) =>
      call<ExecutionRecord>(config, `${pathFor(request.handle)}/execute`, request),

    sendInput: (request) =>
      call<ExecutionRecord>(config, `${pathFor(request.handle)}/input`, request),

    resizeTerminal: (handle, size) =>
      call<{ cols: number; rows: number }>(config, `${pathFor(handle)}/resize`, { handle, size }),

    getEnvironmentState: (handle) => call<EnvironmentDescriptor>(config, pathFor(handle)),

    getEnvironmentPersistence: (handle) =>
      call<import("./contract").EnvironmentPersistence>(config, `${pathFor(handle)}/persistence`),

    getRuntimeHealth: () => call<RuntimeHealth>(config, "/v1/health"),

    getFilesystemState: (handle, cwd) =>
      call<FilesystemState>(config, `${pathFor(handle)}/filesystem`, { handle, cwd }),

    getProcessState: (handle) =>
      call<ProcessState>(config, `${pathFor(handle)}/processes`, { handle }),

    getServiceState: (handle) =>
      call<ServiceState>(config, `${pathFor(handle)}/services`, { handle }),

    getEnvironmentVariables: (handle) =>
      call<EnvironmentVariablesState>(config, `${pathFor(handle)}/environment`, { handle }),

    inspectEnvironment: (handle, paths: InspectionPath[]) =>
      call<EnvironmentInspection>(config, `${pathFor(handle)}/inspect`, { handle, paths }),

    resetEnvironment: (handle) =>
      call<EnvironmentDescriptor>(config, `${pathFor(handle)}/reset`, { handle }),

    snapshotEnvironment: (handle) =>
      call<SnapshotRef>(config, `${pathFor(handle)}/snapshot`, { handle }),

    restoreEnvironment: (handle, snapshotId) =>
      call<EnvironmentDescriptor>(config, `${pathFor(handle)}/restore`, { handle, snapshotId }),

    pauseEnvironment: (handle) =>
      call<EnvironmentDescriptor>(config, `${pathFor(handle)}/pause`, { handle }),

    resumeEnvironment: (handle) =>
      call<EnvironmentDescriptor>(config, `${pathFor(handle)}/resume`, { handle }),

    destroyEnvironment: (handle) =>
      call<{ destroyed: true }>(config, `${pathFor(handle)}/destroy`, { handle }),

    getPackageState: (handle, packageNames) =>
      call<PackageState>(config, `${pathFor(handle)}/packages`, { handle, packageNames: packageNames ?? [] }),

    getGuestIdentity: (handle) =>
      call<{
        environmentId: string;
        expectedArtifactRelease: string;
        guestName: string;
        guestVersion: string;
        guestVersionMatchesArtifact: boolean;
        kernel: string;
        verifiedAt: string;
      }>(config, `${pathFor(handle)}/identity`),
  };
}
