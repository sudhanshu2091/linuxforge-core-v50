import { describe, expect, it } from "vitest";
import {
  PRODUCTION_DEFAULT_RESOURCE_POLICY,
  validateProductionResourcePolicy,
} from "./production-resource-policy";

describe("Production Resource Policy", () => {
  it("provides valid default production resource policy", () => {
    const res = validateProductionResourcePolicy(null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.policy.cpuMillicores).toBe(1000);
    expect(res.policy.memoryMiB).toBe(2048);
    expect(res.policy.storageMiB).toBe(20480);
    expect(res.policy.network).toBe("none");
    expect(res.policy.allowHostFilesystem).toBe(false);
    expect(res.policy.allowPrivilegeEscalation).toBe(false);
  });

  it("rejects hostile attempts to enable privilege escalation or host filesystem", () => {
    const res1 = validateProductionResourcePolicy({ allowPrivilegeEscalation: true as any });
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.error).toContain("Privilege escalation to host is prohibited");
    }

    const res2 = validateProductionResourcePolicy({ allowHostFilesystem: true as any });
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.error).toContain("Host filesystem access is prohibited");
    }
  });

  it("validates within safe bounds", () => {
    const valid = validateProductionResourcePolicy({
      cpuMillicores: 2000,
      memoryMiB: 4096,
      maxProcesses: 512,
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.policy.cpuMillicores).toBe(2000);
    expect(valid.policy.memoryMiB).toBe(4096);
    expect(valid.policy.maxProcesses).toBe(512);
  });

  it("rejects excessive CPU or RAM values", () => {
    const excessiveCpu = validateProductionResourcePolicy({ cpuMillicores: 16000 });
    expect(excessiveCpu.ok).toBe(false);

    const excessiveMem = validateProductionResourcePolicy({ memoryMiB: 65536 });
    expect(excessiveMem.ok).toBe(false);

    const negativeProcs = validateProductionResourcePolicy({ maxProcesses: -5 });
    expect(negativeProcs.ok).toBe(false);
  });

  it("sanitizes and validates egress allowlist", () => {
    const valid = validateProductionResourcePolicy({
      network: "egress-allowlist",
      egressAllowlist: ["api.github.com", "crates.io:443"],
    });
    expect(valid.ok).toBe(true);

    const invalid = validateProductionResourcePolicy({
      network: "egress-allowlist",
      egressAllowlist: ["bad space url", ";rm -rf /"],
    });
    expect(invalid.ok).toBe(false);
  });
});
