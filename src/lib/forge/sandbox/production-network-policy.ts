/**
 * LinuxForge Production Network Policy & Isolation Enforcement.
 *
 * Implements the non-negotiable security invariant:
 * LAB INTERNET EGRESS IS DENY-BY-DEFAULT AND ENFORCED OUTSIDE THE GUEST.
 *
 * Prevents:
 * - Host network access
 * - Cloud metadata service access (169.254.169.254)
 * - Cross-learner environment communication
 * - Unrestricted private RFC 1918 LAN access
 */

export type NetworkEgressMode = "DENY" | "EGRESS_ALLOWLIST";

export type NetworkEgressRule = {
  destination: string;
  port: number;
  protocol: "tcp" | "udp";
  description?: string;
};

export type ProductionNetworkPolicySpec = {
  mode: NetworkEgressMode;
  allowlist: NetworkEgressRule[];
  blockedCidrs: string[];
  blockHostLoopback: boolean;
  blockCloudMetadata: boolean;
  blockInterTenant: boolean;
};

export const PROHIBITED_NETWORK_TARGETS = [
  "169.254.169.254", // AWS/GCP/Azure link-local metadata service
  "169.254.169.254/32",
  "127.0.0.0/8", // Host loopback
  "::1/128", // IPv6 loopback
  "fe80::/10", // IPv6 link-local
  "10.0.0.0/8", // RFC 1918 Private LAN
  "172.16.0.0/12", // RFC 1918 Private LAN
  "192.168.0.0/16", // RFC 1918 Private LAN
] as const;

export const DEFAULT_PRODUCTION_NETWORK_POLICY: ProductionNetworkPolicySpec = {
  mode: "DENY",
  allowlist: [],
  blockedCidrs: [...PROHIBITED_NETWORK_TARGETS],
  blockHostLoopback: true,
  blockCloudMetadata: true,
  blockInterTenant: true,
};

export type NetworkPolicyValidationResult =
  { ok: true; policy: ProductionNetworkPolicySpec } | { ok: false; error: string };

/**
 * Validates a requested network policy against production isolation rules.
 */
export function validateProductionNetworkPolicy(
  spec?: Partial<ProductionNetworkPolicySpec> | null,
): NetworkPolicyValidationResult {
  if (!spec) {
    return { ok: true, policy: { ...DEFAULT_PRODUCTION_NETWORK_POLICY } };
  }

  const mode: NetworkEgressMode = spec.mode === "EGRESS_ALLOWLIST" ? "EGRESS_ALLOWLIST" : "DENY";
  const allowlist: NetworkEgressRule[] = [];

  if (mode === "EGRESS_ALLOWLIST" && Array.isArray(spec.allowlist)) {
    for (const rule of spec.allowlist) {
      if (!rule || typeof rule !== "object") {
        return { ok: false, error: "Malformed egress rule in allowlist." };
      }
      const dest = String(rule.destination || "").trim();
      const port = Number(rule.port);
      const proto = String(rule.protocol || "tcp").toLowerCase();

      if (!dest || dest.length > 256) {
        return { ok: false, error: `Invalid egress destination: '${dest}'` };
      }

      // Check if destination targets a prohibited network or metadata service
      const destLower = dest.toLowerCase();
      if (
        destLower.includes("169.254.169.254") ||
        destLower.includes("metadata.google.internal") ||
        destLower.includes("127.0.0.1") ||
        destLower.includes("localhost")
      ) {
        return {
          ok: false,
          error: `Prohibited egress destination targets host or metadata service: '${dest}'`,
        };
      }

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, error: `Invalid egress port: ${port}` };
      }

      if (proto !== "tcp" && proto !== "udp") {
        return { ok: false, error: `Unsupported egress protocol: '${proto}'` };
      }

      const egressRule: NetworkEgressRule = {
        destination: dest,
        port,
        protocol: proto,
      };
      if (rule.description) {
        egressRule.description = String(rule.description).slice(0, 200);
      }
      allowlist.push(egressRule);
    }
  }

  const policy: ProductionNetworkPolicySpec = {
    mode,
    allowlist,
    blockedCidrs: [...PROHIBITED_NETWORK_TARGETS],
    blockHostLoopback: true,
    blockCloudMetadata: true,
    blockInterTenant: true,
  };

  return { ok: true, policy };
}

/**
 * Checks whether a given outbound packet/connection is allowed under the policy.
 */
export function isEgressAllowed(
  destination: string,
  port: number,
  protocol: "tcp" | "udp",
  policy: ProductionNetworkPolicySpec,
): boolean {
  if (policy.mode === "DENY") {
    return false;
  }

  const destClean = destination.trim().toLowerCase();

  // Strict prohibited targets check
  if (
    policy.blockCloudMetadata &&
    (destClean === "169.254.169.254" || destClean.includes("metadata.google.internal"))
  ) {
    return false;
  }

  if (
    policy.blockHostLoopback &&
    (destClean.startsWith("127.") || destClean === "::1" || destClean === "localhost")
  ) {
    return false;
  }

  // Must match explicit allowlist
  return policy.allowlist.some(
    (rule) =>
      rule.destination.toLowerCase() === destClean &&
      rule.port === port &&
      rule.protocol.toLowerCase() === protocol.toLowerCase(),
  );
}
