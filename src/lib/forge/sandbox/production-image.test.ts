import { describe, expect, it } from "vitest";
import { validateProductionImageRef } from "./production-image";

describe("Production Image Reference Handling", () => {
  it("accepts valid pinned sha256 image references from approved repositories", () => {
    const valid = "kali-linux@sha256:" + "a".repeat(64);
    const res = validateProductionImageRef(valid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.image.repository).toBe("kali-linux");
    expect(res.image.digest).toBe("a".repeat(64));
    expect(res.image.canonicalRef).toBe(valid);
  });

  it("rejects mutable tags like :latest", () => {
    const res = validateProductionImageRef("kali-linux:latest");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Production images must be pinned by SHA-256 digest");
    }
  });

  it("rejects arbitrary host filesystem paths", () => {
    const res1 = validateProductionImageRef("/var/lib/docker/image.tar");
    expect(res1.ok).toBe(false);

    const res2 = validateProductionImageRef("../../my-kali.qcow2");
    expect(res2.ok).toBe(false);
  });

  it("rejects unapproved image repositories", () => {
    const unapproved = "untrusted-user/malicious-image@sha256:" + "b".repeat(64);
    const res = validateProductionImageRef(unapproved);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("is not in the approved LinuxForge production image list");
    }
  });

  it("rejects malformed digests", () => {
    const badDigest = "kali-linux@sha256:not-a-valid-hex-digest";
    const res = validateProductionImageRef(badDigest);
    expect(res.ok).toBe(false);
  });
});
