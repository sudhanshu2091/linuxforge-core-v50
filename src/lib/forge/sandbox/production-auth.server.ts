/**
 * LinuxForge Production Runtime Authentication Boundary.
 *
 * Implements authenticated control-plane <-> runtime communication using
 * short-lived, environment-bound, learner-scoped HMAC tokens with replay protection.
 *
 * Server-only: Runtime service credentials, worker tokens, and service-role keys
 * are never transmitted to the browser or guest.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type RuntimeTokenClaims = {
  tokenId: string;
  workerId: string;
  environmentId: string;
  learnerId: string;
  labId: string;
  bindingGeneration: number;
  exp: number;
  iat: number;
  nonce: string;
};

export type IssueRuntimeTokenInput = {
  workerId: string;
  environmentId: string;
  learnerId: string;
  labId: string;
  bindingGeneration: number;
  ttlSeconds?: number;
};

export type VerifyRuntimeTokenResult =
  | { ok: true; claims: RuntimeTokenClaims }
  | { ok: false; error: string; code: "EXPIRED" | "INVALID_SIGNATURE" | "MALFORMED" | "MISMATCH" };

function secretKey(secret?: string): Buffer {
  const value =
    secret || process.env["FORGE_RUNTIME_SERVICE_TOKEN"] || process.env["FORGE_SANDBOX_CREDENTIAL"];
  if (!value || value.length < 16) {
    throw new Error("Runtime service authentication secret is not configured securely.");
  }
  return Buffer.from(value, "utf8");
}

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

function ub64(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

/**
 * Issues a short-lived, replay-resistant token for control-plane -> runtime service calls.
 */
export function issueRuntimeToken(
  input: IssueRuntimeTokenInput,
  secret?: string,
): { token: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds !== undefined ? input.ttlSeconds : 60;
  const exp = now + ttl;

  const claims: RuntimeTokenClaims = {
    tokenId: randomBytes(16).toString("hex"),
    workerId: input.workerId,
    environmentId: input.environmentId,
    learnerId: input.learnerId,
    labId: input.labId,
    bindingGeneration: input.bindingGeneration,
    iat: now,
    exp,
    nonce: randomBytes(16).toString("hex"),
  };

  const payloadStr = JSON.stringify(claims);
  const payloadB64 = b64u(Buffer.from(payloadStr, "utf8"));
  const hmac = createHmac("sha256", secretKey(secret));
  hmac.update(payloadB64);
  const sig = b64u(hmac.digest());

  return {
    token: `${payloadB64}.${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Verifies a runtime token and ensures ownership and environment binding match.
 */
export function verifyRuntimeToken(
  token: string,
  expectedEnvironmentId: string,
  expectedLearnerId: string,
  secret?: string,
): VerifyRuntimeTokenResult {
  if (!token || typeof token !== "string") {
    return { ok: false, error: "Missing or invalid runtime token format.", code: "MALFORMED" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, error: "Runtime token structure is invalid.", code: "MALFORMED" };
  }

  const payloadB64 = parts[0];
  const sigB64 = parts[1];
  if (!payloadB64 || !sigB64) {
    return { ok: false, error: "Runtime token components missing.", code: "MALFORMED" };
  }

  const hmac = createHmac("sha256", secretKey(secret));
  hmac.update(payloadB64);
  const expectedSig = hmac.digest();
  const actualSig = ub64(sigB64);

  if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
    return {
      ok: false,
      error: "Runtime token signature verification failed.",
      code: "INVALID_SIGNATURE",
    };
  }

  let claims: RuntimeTokenClaims;
  try {
    claims = JSON.parse(ub64(payloadB64).toString("utf8")) as RuntimeTokenClaims;
  } catch {
    return { ok: false, error: "Runtime token payload could not be decoded.", code: "MALFORMED" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) {
    return { ok: false, error: "Runtime token has expired.", code: "EXPIRED" };
  }

  if (claims.environmentId !== expectedEnvironmentId) {
    return {
      ok: false,
      error: `Token environmentId mismatch: expected '${expectedEnvironmentId}', got '${claims.environmentId}'.`,
      code: "MISMATCH",
    };
  }

  if (claims.learnerId !== expectedLearnerId) {
    return {
      ok: false,
      error: `Token learnerId mismatch: expected '${expectedLearnerId}', got '${claims.learnerId}'.`,
      code: "MISMATCH",
    };
  }

  return { ok: true, claims };
}
