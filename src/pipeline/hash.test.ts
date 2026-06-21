import { describe, it, expect } from "vitest";
import {
  computeBodyHash,
  sha256Hex,
  base64UrlEncode,
  prepareEmbeddingInput,
  prepareDiffEmbeddingInput,
  prepareCommentEmbeddingInput,
} from "./hash.js";
import { MAX_EMBEDDING_INPUT_CHARS } from "./embedding.js";

describe("hash: SHA-256 change-detection digests", () => {
  it("computeBodyHash pins the formula sha256(title + '\\n\\n' + body) as hex", async () => {
    // Independent oracle (node crypto): sha256("title\n\nbody")
    expect(await computeBodyHash("title", "body")).toBe(
      "858ed7d3647ecaf69c40587628c44fcfc6ce9370c4e9fb9c48dbb6955ca26a6a",
    );
  });

  it("computeBodyHash is deterministic and 64-char lowercase hex", async () => {
    expect(await computeBodyHash("t", "b")).toBe(await computeBodyHash("t", "b"));
    expect(await computeBodyHash("t", "b")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computeBodyHash keeps the title/body boundary (no field-merge collision)", async () => {
    // "ti"+"tlebody" must differ from "title"+"body": the "\n\n" joiner disambiguates.
    expect(await computeBodyHash("ti", "tlebody")).not.toBe(
      await computeBodyHash("title", "body"),
    );
  });

  it("sha256Hex pins a known vector", async () => {
    expect(await sha256Hex("hello world")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});

describe("base64UrlEncode: URL-safe, unpadded", () => {
  it("pins a known vector", () => {
    expect(base64UrlEncode("hello")).toBe("aGVsbG8");
  });

  it("uses the URL-safe alphabet (- and _) and strips padding", () => {
    // ">>>?" -> standard base64 "Pj4+Pw==" -> url-safe "Pj4-Pw"
    expect(base64UrlEncode(">>>?")).toBe("Pj4-Pw");
    expect(base64UrlEncode(">>>?")).not.toMatch(/[+/=]/);
  });
});

describe("embedding-input preparation: truncation + null handling", () => {
  it("prepareEmbeddingInput joins title/body and passes short input through", () => {
    expect(prepareEmbeddingInput("t", "b")).toBe("t\n\nb");
  });

  it("prepareEmbeddingInput treats null body as empty", () => {
    expect(prepareEmbeddingInput("t", null)).toBe("t\n\n");
  });

  it("prepareEmbeddingInput truncates to MAX_EMBEDDING_INPUT_CHARS", () => {
    const out = prepareEmbeddingInput("title", "x".repeat(MAX_EMBEDDING_INPUT_CHARS + 500));
    expect(out).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);
  });

  it("prepareDiffEmbeddingInput inlines the file path and truncates", () => {
    expect(prepareDiffEmbeddingInput("msg", "src/a.ts", "patch")).toBe(
      "msg\n\nsrc/a.ts\n\npatch",
    );
    const out = prepareDiffEmbeddingInput("m", "p", "x".repeat(MAX_EMBEDDING_INPUT_CHARS + 10));
    expect(out).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);
  });

  it("prepareCommentEmbeddingInput prefixes the author and truncates", () => {
    expect(prepareCommentEmbeddingInput("octocat", "nice")).toBe("octocat\n\nnice");
    const out = prepareCommentEmbeddingInput("a", "x".repeat(MAX_EMBEDDING_INPUT_CHARS + 10));
    expect(out).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);
  });
});
