import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCTION_NETWORK_POLICY,
  isEgressAllowed,
  validateProductionNetworkPolicy,
} from "./production-network-policy";

describe("Production Network Policy", () => {
  it("defaults to egress DENY", () => {
    const res = validateProductionNetworkPolicy(null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.policy.mode).toBe("DENY");
    expect(isEgressAllowed("8.8.8.8", 53, "udp", res.policy)).toBe(false);
    expect(isEgressAllowed("google.com", 443, "tcp", res.policy)).toBe(false);
  });

  it("blocks cloud metadata service even if attempted in allowlist", () => {
    const res = validateProductionNetworkPolicy({
      mode: "EGRESS_ALLOWLIST",
      allowlist: [{ destination: "169.254.169.254", port: 80, protocol: "tcp" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Prohibited egress destination");
    }
  });

  it("blocks host loopback destinations in allowlist", () => {
    const res = validateProductionNetworkPolicy({
      mode: "EGRESS_ALLOWLIST",
      allowlist: [{ destination: "127.0.0.1", port: 8080, protocol: "tcp" }],
    });
    expect(res.ok).toBe(false);
  });

  it("permits explicit allowlist entries and rejects non-listed traffic", () => {
    const res = validateProductionNetworkPolicy({
      mode: "EGRESS_ALLOWLIST",
      allowlist: [{ destination: "packages.kali.org", port: 443, protocol: "tcp" }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Allowed
    expect(isEgressAllowed("packages.kali.org", 443, "tcp", res.policy)).toBe(true);

    // Wrong port blocked
    expect(isEgressAllowed("packages.kali.org", 80, "tcp", res.policy)).toBe(false);

    // Wrong protocol blocked
    expect(isEgressAllowed("packages.kali.org", 443, "udp", res.policy)).toBe(false);

    // Unlisted destination blocked
    expect(isEgressAllowed("malicious.site", 443, "tcp", res.policy)).toBe(false);
  });
});
