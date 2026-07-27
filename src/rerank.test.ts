import { describe, it, expect, vi } from "vitest";
import {
  rerankCandidates,
  rerankWasApplied,
  truncatePair,
  type RerankCandidate,
} from "./rerank.js";
import type { Env } from "./types.js";

/**
 * Binding-independent unit tests for the reranker layer (node pool).
 *
 * Focus = the issue #172 surface: an all-empty-content candidate set must
 * return `[]` without an AI call, and `[]` must NOT be judged as "rerank
 * applied". The pre-#172 caller used a bare truthiness check on the result,
 * so an empty array reported `rerank_applied: true` with zero scores.
 */

/** Minimal Env stub exposing only the AI binding the reranker touches. */
function mkEnv(run: (model: string, input: unknown) => unknown): Env {
  return { AI: { run: vi.fn(run) } } as unknown as Env;
}

function cand(id: string, content: string): RerankCandidate {
  return { id, content };
}

describe("rerankWasApplied", () => {
  it("treats null (call error / malformed response) as not applied", () => {
    expect(rerankWasApplied(null)).toBe(false);
  });

  it("treats an empty array as NOT applied (the #172 defect)", () => {
    expect(rerankWasApplied([])).toBe(false);
  });

  it("treats a non-empty result set as applied", () => {
    expect(rerankWasApplied([{ id: "v1", score: 0.9 }])).toBe(true);
  });
});

describe("rerankCandidates: empty-content handling", () => {
  it("returns [] and skips the AI call when every candidate has empty content", async () => {
    // The dense-only Japanese-query shape: FTS5 matched nothing, so no
    // candidate carried content before the #172 D1 backfill.
    const run = vi.fn();
    const env = mkEnv(run);

    const result = await rerankCandidates(env, "日本語クエリ", [
      cand("v1", ""),
      cand("v2", ""),
      cand("v3", "   "),
    ]);

    expect(result).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(rerankWasApplied(result)).toBe(false);
  });

  it("returns [] for an empty candidate list without calling the AI binding", async () => {
    const run = vi.fn();
    const env = mkEnv(run);

    expect(await rerankCandidates(env, "q", [])).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("passthrough-scores a single non-empty candidate without an AI call", async () => {
    const run = vi.fn();
    const env = mkEnv(run);

    const result = await rerankCandidates(env, "q", [
      cand("v1", "the only candidate with content"),
      cand("v2", ""),
    ]);

    expect(result).toEqual([{ id: "v1", score: 1 }]);
    expect(run).not.toHaveBeenCalled();
    // One synthesized score still counts as applied — a score is attached.
    expect(rerankWasApplied(result)).toBe(true);
  });
});

describe("rerankCandidates: content-bearing candidates (post-backfill shape)", () => {
  it("scores every candidate once content is supplied, and reports applied", async () => {
    // After the #172 backfill, dense-only candidates arrive with D1 content.
    const run = vi.fn(() => ({
      response: [
        { id: 0, score: 0.2 },
        { id: 1, score: 0.9 },
      ],
    }));
    const env = mkEnv(run);

    const result = await rerankCandidates(env, "日本語クエリ", [
      cand("v1", "backfilled body for the first dense-only hit"),
      cand("v2", "backfilled body for the second dense-only hit"),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    // Sorted by score descending, caller ids preserved.
    expect(result).toEqual([
      { id: "v2", score: 0.9 },
      { id: "v1", score: 0.2 },
    ]);
    expect(rerankWasApplied(result)).toBe(true);
  });

  it("excludes empty-content rows from the AI payload but still scores the rest", async () => {
    // Partial backfill (some rows genuinely absent from D1) must not poison the
    // call — Workers AI rejects any zero-length `contexts[].text` with 5006.
    let seenContexts: Array<{ text: string }> = [];
    const run = vi.fn((_model: string, input: unknown) => {
      seenContexts = (input as { contexts: Array<{ text: string }> }).contexts;
      return {
        response: [
          { id: 0, score: 0.5 },
          { id: 1, score: 0.1 },
        ],
      };
    });
    const env = mkEnv(run);

    const result = await rerankCandidates(env, "q", [
      cand("v1", "first body"),
      cand("v2", ""),
      cand("v3", "third body"),
    ]);

    expect(seenContexts.map((c) => c.text)).toEqual(["first body", "third body"]);
    // Index mapping is against the filtered set, so v3 (not v2) is index 1.
    expect(result).toEqual([
      { id: "v1", score: 0.5 },
      { id: "v3", score: 0.1 },
    ]);
  });

  it("returns null (not []) when the AI call throws, so the caller keeps fusion order", async () => {
    const env = mkEnv(() => {
      throw new Error("5006");
    });

    const result = await rerankCandidates(env, "q", [
      cand("v1", "first body"),
      cand("v2", "second body"),
    ]);

    expect(result).toBeNull();
    expect(rerankWasApplied(result)).toBe(false);
  });

  it("returns null on an unexpected response shape", async () => {
    const env = mkEnv(() => ({ unexpected: true }));

    const result = await rerankCandidates(env, "q", [
      cand("v1", "first body"),
      cand("v2", "second body"),
    ]);

    expect(result).toBeNull();
  });
});

describe("truncatePair", () => {
  it("leaves short pairs untouched", () => {
    expect(truncatePair("q", "short body")).toEqual({ query: "q", content: "short body" });
  });

  it("truncates the query to its own budget and the content to the remainder", () => {
    const { query, content } = truncatePair("q".repeat(500), "c".repeat(5000));
    expect(query.length).toBe(200);
    expect(content.length).toBe(1500);
  });
});
