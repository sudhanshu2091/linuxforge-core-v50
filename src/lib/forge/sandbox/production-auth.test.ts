import { describe, expect, it } from "vitest";
import { issueRuntimeToken, verifyRuntimeToken } from "./production-auth.server";

describe("Production Runtime Authentication Boundary", () => {
  const secret = "v50-super-secret-key-at-least-32-bytes-long";

  it("issues and verifies a valid short-lived runtime token", () => {
    const { token, expiresAt } = issueRuntimeToken(
      {
        workerId: "worker-prod-1",
        environmentId: "env-prod-100",
        learnerId: "user-alpha",
        labId: "lab-beta",
        bindingGeneration: 3,
        ttlSeconds: 60,
      },
      secret,
    );

    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(expiresAt).toBeDefined();

    const verified = verifyRuntimeToken(token, "env-prod-100", "user-alpha", secret);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.workerId).toBe("worker-prod-1");
    expect(verified.claims.environmentId).toBe("env-prod-100");
    expect(verified.claims.learnerId).toBe("user-alpha");
    expect(verified.claims.bindingGeneration).toBe(3);
  });

  it("rejects token when environmentId mismatches", () => {
    const { token } = issueRuntimeToken(
      {
        workerId: "w1",
        environmentId: "env-1",
        learnerId: "u1",
        labId: "l1",
        bindingGeneration: 1,
      },
      secret,
    );

    const verified = verifyRuntimeToken(token, "env-wrong", "u1", secret);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.code).toBe("MISMATCH");
    }
  });

  it("rejects token when learnerId mismatches", () => {
    const { token } = issueRuntimeToken(
      {
        workerId: "w1",
        environmentId: "env-1",
        learnerId: "u1",
        labId: "l1",
        bindingGeneration: 1,
      },
      secret,
    );

    const verified = verifyRuntimeToken(token, "env-1", "u-wrong", secret);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.code).toBe("MISMATCH");
    }
  });

  it("rejects tampered token signature", () => {
    const { token } = issueRuntimeToken(
      {
        workerId: "w1",
        environmentId: "env-1",
        learnerId: "u1",
        labId: "l1",
        bindingGeneration: 1,
      },
      secret,
    );

    const tampered = token.slice(0, -4) + "XXXX";
    const verified = verifyRuntimeToken(tampered, "env-1", "u1", secret);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.code).toBe("INVALID_SIGNATURE");
    }
  });

  it("rejects expired token", () => {
    const { token } = issueRuntimeToken(
      {
        workerId: "w1",
        environmentId: "env-1",
        learnerId: "u1",
        labId: "l1",
        bindingGeneration: 1,
        ttlSeconds: -10, // already expired
      },
      secret,
    );

    const verified = verifyRuntimeToken(token, "env-1", "u1", secret);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.code).toBe("EXPIRED");
    }
  });
});
