/**
 * Environment Observer Facade.
 *
 * Provider-neutral observation service that coordinates targeted or full
 * inspections against SandboxProvider implementations, normalizes observations,
 * generates immutable snapshots, and tracks mission artifacts.
 *
 * Architecture boundary:
 *   Learning/Verifier Domain -> EnvironmentObserver -> SandboxProvider -> Isolated VM/Runtime
 */

import type {
  EnvironmentHandle,
  EnvironmentInspection,
  InspectionPath,
  PackageState,
  ProviderError,
  SandboxProvider,
} from "../sandbox/contract";

import { evaluateArtifacts } from "./artifacts";
import { normalizeEnvironment, type RawRuntimeObservationBundle } from "./normalization";
import { createEnvironmentSnapshot } from "./snapshots";
import type {
  CanonicalEnvironmentModel,
  EnvironmentFilesystemObject,
  EnvironmentIdentity,
  EnvironmentPackage,
  EnvironmentNetwork,
  EnvironmentProcess,
  EnvironmentRuntimeMetadata,
  EnvironmentService,
  EnvironmentSnapshot,
  EnvironmentSystem,
  EnvironmentVariables,
  MissionArtifact,
  ObservationCategory,
  ObservationErrorRecord,
  ObservationSource,
  TargetedObservationScope,
} from "./types";

export type ObserveEnvironmentOptions = {
  scope?: TargetedObservationScope | undefined;
  environmentGeneration?: number | undefined;
};

export type ObservationOutcome =
  | {
      ok: true;
      snapshot: EnvironmentSnapshot;
      model: CanonicalEnvironmentModel;
      errors: ObservationErrorRecord[];
    }
  | {
      ok: false;
      error: ProviderError;
      partialSnapshot?: EnvironmentSnapshot;
    };

export class EnvironmentObserver {
  constructor(private readonly provider: SandboxProvider) {}

  /**
   * Captures an authorized, deterministic observation of the environment,
   * returning an immutable EnvironmentSnapshot.
   */
  async observe(
    handle: EnvironmentHandle,
    options: ObserveEnvironmentOptions = {},
  ): Promise<ObservationOutcome> {
    const scope = options.scope;
    const requestedCategories: ObservationCategory[] =
      scope?.categories && scope.categories.length > 0
        ? [...scope.categories]
        : [
            "identity",
            "filesystem",
            "processes",
            "services",
            "environment",
            "network",
            "system",
            "runtime",
          ];

    const errors: ObservationErrorRecord[] = [];
    const provenance: ObservationSource[] = [];
    const bundle: RawRuntimeObservationBundle = { handle };

    // 0. Runtime Health & Security Controls (Authoritative)
    const healthResult = await this.provider.getRuntimeHealth();
    if (healthResult.ok) {
      bundle.runtimeHealth = healthResult.value;
      provenance.push({
        category: "runtime",
        provider: handle.provider,
        method: "getRuntimeHealth",
        observedAt: new Date().toISOString(),
        evidence: "OBSERVED_FACT",
      });
    }

    // 1. Runtime Descriptor & Capabilities
    const descResult = await this.provider.getEnvironmentState(handle);
    if (!descResult.ok) {
      errors.push({
        category: "runtime",
        code: descResult.error.code === "PROVIDER_NOT_CONFIGURED" ? "UNSUPPORTED_CAPABILITY" : "RUNTIME_UNAVAILABLE",
        message: descResult.error.message,
        occurredAt: new Date().toISOString(),
      });
      return { ok: false, error: descResult.error };
    }
    bundle.descriptor = descResult.value;
    provenance.push({
      category: "runtime",
      provider: handle.provider,
      method: "getEnvironmentState",
      observedAt: new Date().toISOString(),
      evidence: "OBSERVED_FACT",
    });

    // 2. Guest Identity if supported / available
    if (typeof this.provider.getGuestIdentity === "function") {
      try {
        const idResult = await this.provider.getGuestIdentity(handle);
        if (idResult.ok) {
          bundle.guestIdentity = idResult.value;
          provenance.push({
            category: "identity",
            provider: handle.provider,
            method: "getGuestIdentity",
            observedAt: new Date().toISOString(),
            evidence: "OBSERVED_FACT",
          });
        }
      } catch (err) {
        errors.push({
          category: "identity",
          code: "COMMAND_FAILED",
          message: err instanceof Error ? err.message : "Guest identity fetch failed",
          occurredAt: new Date().toISOString(),
        });
      }
    }

    // 3. Filesystem Inspection
    if (requestedCategories.includes("filesystem") || scope?.filesystemTargets) {
      const paths: InspectionPath[] =
        scope?.filesystemTargets && scope.filesystemTargets.length > 0
          ? scope.filesystemTargets.map((t) => (t.includeContent !== undefined ? { path: t.path, includeContent: t.includeContent } : { path: t.path }))
          : [
              { path: "/home/linuxforge" },
              { path: "/tmp" },
              { path: "/etc/passwd" },
            ];

      const inspectResult = await this.provider.inspectEnvironment(handle, paths);
      if (inspectResult.ok) {
        bundle.inspection = inspectResult.value;
        provenance.push({
          category: "filesystem",
          provider: handle.provider,
          method: "inspectEnvironment",
          observedAt: new Date().toISOString(),
          evidence: "OBSERVED_FACT",
        });
      } else {
        const fsResult = await this.provider.getFilesystemState(handle, "/home/linuxforge");
        if (fsResult.ok) {
          bundle.filesystem = fsResult.value;
          provenance.push({
            category: "filesystem",
            provider: handle.provider,
            method: "getFilesystemState",
            observedAt: new Date().toISOString(),
            evidence: fsResult.value.modelled ? "STRONG_INFERENCE" : "OBSERVED_FACT",
          });
        } else {
          errors.push({
            category: "filesystem",
            code: "COMMAND_FAILED",
            message: fsResult.error.message,
            occurredAt: new Date().toISOString(),
          });
        }
      }
    }

    // 4. Processes
    if (requestedCategories.includes("processes")) {
      if (this.provider.capabilities.processes) {
        const psResult = await this.provider.getProcessState(handle);
        if (psResult.ok) {
          bundle.processes = psResult.value;
          provenance.push({
            category: "processes",
            provider: handle.provider,
            method: "getProcessState",
            observedAt: new Date().toISOString(),
            evidence: psResult.value.supported ? "OBSERVED_FACT" : "UNKNOWN",
          });
        } else {
          errors.push({
            category: "processes",
            code: "COMMAND_FAILED",
            message: psResult.error.message,
            occurredAt: new Date().toISOString(),
          });
        }
      } else {
        errors.push({
          category: "processes",
          code: "UNSUPPORTED_CAPABILITY",
          message: "Process inspection not supported by this provider.",
          occurredAt: new Date().toISOString(),
        });
      }
    }

    // 5. Services
    if (requestedCategories.includes("services")) {
      if (this.provider.capabilities.services) {
        const svcResult = await this.provider.getServiceState(handle);
        if (svcResult.ok) {
          bundle.services = svcResult.value;
          provenance.push({
            category: "services",
            provider: handle.provider,
            method: "getServiceState",
            observedAt: new Date().toISOString(),
            evidence: svcResult.value.supported ? "OBSERVED_FACT" : "UNKNOWN",
          });
        } else {
          errors.push({
            category: "services",
            code: "COMMAND_FAILED",
            message: svcResult.error.message,
            occurredAt: new Date().toISOString(),
          });
        }
      } else {
        errors.push({
          category: "services",
          code: "UNSUPPORTED_CAPABILITY",
          message: "Service inspection not supported by this provider.",
          occurredAt: new Date().toISOString(),
        });
      }
    }

    // 6. Packages
    if (requestedCategories.includes("packages") || scope?.packageTargets) {
      if (typeof this.provider.getPackageState === "function") {
        const pkgNames = scope?.packageTargets?.packageNames;
        const pkgResult = await this.provider.getPackageState(handle, pkgNames);
        if (pkgResult.ok) {
          bundle.rawPackages = pkgResult.value.packages;
          bundle.packageState = pkgResult.value;
          provenance.push({
            category: "packages",
            provider: handle.provider,
            method: "getPackageState",
            observedAt: new Date().toISOString(),
            evidence: pkgResult.value.supported ? "OBSERVED_FACT" : "UNKNOWN",
          });
        } else {
          errors.push({
            category: "packages",
            code: "COMMAND_FAILED",
            message: pkgResult.error.message,
            occurredAt: new Date().toISOString(),
          });
        }
      } else {
        errors.push({
          category: "packages",
          code: "UNSUPPORTED_CAPABILITY",
          message: "Package inspection not supported by this provider.",
          occurredAt: new Date().toISOString(),
        });
      }
    }

    // 7. Environment variables
    if (requestedCategories.includes("environment")) {
      if (this.provider.capabilities.environmentVariables) {
        const envResult = await this.provider.getEnvironmentVariables(handle);
        if (envResult.ok) {
          bundle.variables = envResult.value;
          provenance.push({
            category: "environment",
            provider: handle.provider,
            method: "getEnvironmentVariables",
            observedAt: new Date().toISOString(),
            evidence: envResult.value.supported ? "OBSERVED_FACT" : "UNKNOWN",
          });
        } else {
          errors.push({
            category: "environment",
            code: "COMMAND_FAILED",
            message: envResult.error.message,
            occurredAt: new Date().toISOString(),
          });
        }
      }
    }

    let artifacts: MissionArtifact[] = [];
    if (scope?.trackArtifacts && scope.trackArtifacts.length > 0) {
      artifacts = scope.trackArtifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        identifier: a.identifier,
        expectedState: a.expectedState,
        observedState: null,
        verified: false,
        evidence: "UNKNOWN",
      }));
    }

    const normalizedModel = normalizeEnvironment(bundle, artifacts);
    if (artifacts.length > 0) {
      normalizedModel.artifacts = evaluateArtifacts(artifacts, normalizedModel);
    }

    const generation =
      options.environmentGeneration ??
      (bundle.descriptor?.metadata?.["environmentGeneration"]
        ? parseInt(bundle.descriptor.metadata["environmentGeneration"], 10)
        : 1);

    const snapshot = createEnvironmentSnapshot({
      environmentId: handle.environmentId,
      generation,
      model: normalizedModel,
      observedCategories: requestedCategories,
      errors,
      provenance,
    });

    return {
      ok: true,
      snapshot,
      model: normalizedModel,
      errors,
    };
  }

  async observeIdentity(handle: EnvironmentHandle): Promise<EnvironmentIdentity> {
    const outcome = await this.observe(handle, { scope: { categories: ["identity"] } });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.model.identity;
  }

  async observeFilesystem(
    handle: EnvironmentHandle,
    targets?: Array<{ path: string; includeContent?: boolean }>,
  ): Promise<EnvironmentFilesystemObject[]> {
    const scope: TargetedObservationScope = { categories: ["filesystem"] };
    if (targets) scope.filesystemTargets = targets;
    const outcome = await this.observe(handle, { scope });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.model.filesystem;
  }

  async observeProcesses(handle: EnvironmentHandle): Promise<EnvironmentProcess[]> {
    const outcome = await this.observe(handle, { scope: { categories: ["processes"] } });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.model.processes;
  }

  async observeServices(handle: EnvironmentHandle): Promise<EnvironmentService[]> {
    const outcome = await this.observe(handle, { scope: { categories: ["services"] } });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.model.services;
  }

  async observeNetwork(handle: EnvironmentHandle): Promise<EnvironmentNetwork> {
    const outcome = await this.observe(handle, { scope: { categories: ["network"] } });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.model.network;
  }

  async observePackages(
    handle: EnvironmentHandle,
    packageNames?: string[],
  ): Promise<EnvironmentPackage[]> {
    const scope: TargetedObservationScope = {
      categories: ["packages"],
      ...(packageNames && packageNames.length > 0 ? { packageTargets: { packageNames } } : {}),
    };
    const outcome = await this.observe(handle, { scope });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.model.packages;
  }

  async observeEnvironmentVariables(handle: EnvironmentHandle): Promise<EnvironmentVariables> {
    const outcome = await this.observe(handle, { scope: { categories: ["environment"] } });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.model.environment;
  }

  async observeSystem(handle: EnvironmentHandle): Promise<EnvironmentSystem> {
    const outcome = await this.observe(handle, { scope: { categories: ["system"] } });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.model.system;
  }

  async observeRuntime(handle: EnvironmentHandle): Promise<EnvironmentRuntimeMetadata> {
    const outcome = await this.observe(handle, { scope: { categories: ["runtime"] } });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.model.runtime;
  }
}

export function createEnvironmentObserver(provider: SandboxProvider): EnvironmentObserver {
  return new EnvironmentObserver(provider);
}
