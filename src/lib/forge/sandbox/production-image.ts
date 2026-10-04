/**
 * LinuxForge Production Image & Rootfs Boundary.
 *
 * Enforces immutable pinned base images (`image@sha256:<64 hex chars>`).
 * Rejects mutable tags (e.g. `:latest`), arbitrary host file paths, and unapproved registries.
 */

export const IMMUTABLE_IMAGE_REGEX = /^([a-zA-Z0-9_\-\.\/]+)@sha256:([0-9a-fA-F]{64})$/;

export const APPROVED_IMAGE_PREFIXES = [
  "kali-linux",
  "linuxforge/kali",
  "quay.io/linuxforge/kali",
  "ghcr.io/sudhanshu2091/linuxforge-kali",
] as const;

export type ParsedImageRef = {
  repository: string;
  digest: string;
  canonicalRef: string;
};

export type ImageValidationResult =
  { ok: true; image: ParsedImageRef } | { ok: false; error: string };

/**
 * Validates that an image reference is immutable, cryptographically pinned,
 * and adheres to production security policy.
 */
export function validateProductionImageRef(imageRef: string): ImageValidationResult {
  if (!imageRef || typeof imageRef !== "string") {
    return { ok: false, error: "Image reference is missing or not a string." };
  }

  const trimmed = imageRef.trim();

  // Reject local file paths or relative directory traversals
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.includes("..")) {
    return { ok: false, error: "Arbitrary host paths are not permitted as image references." };
  }

  const match = IMMUTABLE_IMAGE_REGEX.exec(trimmed);
  if (!match || !match[1] || !match[2]) {
    return {
      ok: false,
      error: `Production images must be pinned by SHA-256 digest: 'image@sha256:<64-hex>' (received '${trimmed}').`,
    };
  }

  const repository = match[1];
  const digest = match[2];
  const canonicalRef = `${repository.toLowerCase()}@sha256:${digest.toLowerCase()}`;

  // Check trusted image prefix
  const isApproved = APPROVED_IMAGE_PREFIXES.some((prefix) =>
    repository.toLowerCase().startsWith(prefix.toLowerCase()),
  );

  if (!isApproved) {
    return {
      ok: false,
      error: `Image repository '${repository}' is not in the approved LinuxForge production image list.`,
    };
  }

  return {
    ok: true,
    image: {
      repository: repository.toLowerCase(),
      digest: digest.toLowerCase(),
      canonicalRef,
    },
  };
}
