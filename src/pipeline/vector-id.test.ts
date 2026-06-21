import { describe, it, expect } from "vitest";
import {
  vectorId,
  releaseVectorId,
  docVectorId,
  wikiDocVectorId,
  diffVectorId,
  issueCommentVectorId,
  prReviewVectorId,
  prReviewCommentVectorId,
} from "./vector-id.js";

// Vectorize enforces a 64-byte cap on vector IDs (see vector-id.ts header).
const VECTORIZE_ID_MAX_BYTES = 64;
const byteLen = (s: string) => new TextEncoder().encode(s).length;

describe("vector-id: deterministic, fixed-length Vectorize IDs", () => {
  it("is deterministic — same inputs produce the same ID", async () => {
    expect(await vectorId("owner/repo", 42)).toBe(await vectorId("owner/repo", 42));
    expect(await diffVectorId("o/r", "abc123", "src/a.ts")).toBe(
      await diffVectorId("o/r", "abc123", "src/a.ts"),
    );
  });

  it("pins the scheme {prefix}:{base64url(sha256(parts joined by NUL 0x00))}", async () => {
    // Known-answer vector computed independently (node crypto):
    //   base64url(sha256("owner/repo\x00" + "42")) = rHCVapZQcT6gbJcsAzEimy1VNhqNG2uaF9n5aGgouVk
    // The NUL separator (not a space) is what keeps surface parts injective —
    // see the collision-resistance test below.
    expect(await vectorId("owner/repo", 42)).toBe(
      "i:rHCVapZQcT6gbJcsAzEimy1VNhqNG2uaF9n5aGgouVk",
    );
  });

  it("uses the documented per-surface prefix", async () => {
    expect(await vectorId("o/r", 1)).toMatch(/^i:/);
    expect(await releaseVectorId("o/r", "v1.0.0")).toMatch(/^r:/);
    expect(await docVectorId("o/r", "docs/x.md")).toMatch(/^d:/);
    expect(await wikiDocVectorId("o/r", "Home")).toMatch(/^w:/);
    expect(await diffVectorId("o/r", "sha", "f.ts")).toMatch(/^c:/);
    expect(await issueCommentVectorId("o/r", 5)).toMatch(/^ic:/);
    expect(await prReviewVectorId("o/r", 7)).toMatch(/^pv:/);
    expect(await prReviewCommentVectorId("o/r", 9)).toMatch(/^pc:/);
  });

  it("digest is 43-char URL-safe base64 without padding", async () => {
    const digest = (await vectorId("owner/repo", 42)).split(":")[1];
    expect(digest).toHaveLength(43);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/); // no +, /, or =
  });

  it("stays under the 64-byte Vectorize cap even for very long inputs", async () => {
    const longPath = "src/" + "a/".repeat(200) + "very-long-filename.ts";
    const ids = [
      await vectorId("owner/repo", 999999999),
      await docVectorId("owner/repo", longPath),
      await diffVectorId("owner/repo", "0".repeat(40), longPath),
      await prReviewCommentVectorId("owner/repo", 123456789),
    ];
    for (const id of ids) {
      expect(byteLen(id)).toBeLessThanOrEqual(VECTORIZE_ID_MAX_BYTES);
      expect(byteLen(id)).toBeLessThanOrEqual(46); // documented 45–46 upper bound
    }
  });

  it("separates surfaces: same logical key under different surfaces never collides", async () => {
    const ids = new Set([
      await vectorId("o/r", 5),
      await issueCommentVectorId("o/r", 5),
      await prReviewVectorId("o/r", 5),
      await prReviewCommentVectorId("o/r", 5),
    ]);
    expect(ids.size).toBe(4);
  });

  it("NUL-joins parts so space-containing parts cannot collide", async () => {
    // Parts are joined with NUL (0x00), so ("b c","d") and ("b","c d") map to
    // distinct inputs ("repo\0b c\0d" vs "repo\0b\0c d"). A space join would
    // collapse both to "repo b c d" and collide. This pins that collision
    // resistance.
    const a = await diffVectorId("owner/repo", "b c", "d");
    const b = await diffVectorId("owner/repo", "b", "c d");
    expect(a).not.toBe(b);
  });
});
