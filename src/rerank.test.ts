import { describe, it, expect, vi } from "vitest";
import {
  rerankCandidates,
  rerankWasApplied,
  truncatePair,
  type RerankCandidate,
} from "./rerank.js";
import type { Env } from "./types.js";
import { prepareDiffEmbeddingInput } from "./pipeline/hash.js";
import { MAX_EMBEDDING_INPUT_CHARS } from "./pipeline/embedding.js";

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


describe("diff input at the model boundary", () => {
  const message = "Commit headline\n\n" + "shared explanation ".repeat(150);
  const patch = "@@ -1 +1 @@\n-old\n+file-specific "+"patch bytes\n".repeat(300);
  const diff = (id: string, path: string, body = patch): RerankCandidate => ({
    id, type: "diff", filePath: path, content: `${message}\n\n${path}\n\n${body}`,
  });
  async function capture(query: string, candidates: RerankCandidate[]) {
    let input!: { query: string; contexts: { text: string }[]; top_k: number };
    const run = vi.fn((_model, value) => {
      input = value as typeof input;
      return { response: candidates.filter(c => c.content.trim()).map((_, id) => ({ id, score: 0.5 })) };
    });
    const result = await rerankCandidates(mkEnv(run), query, candidates);
    expect(run).toHaveBeenCalledTimes(1);
    return { input, result };
  }

  it.each([0, 42, 500])("reserves patch space using a query of %i characters", async length => {
    const query = "q".repeat(length);
    const candidates = [diff("a", "src/first.ts"), diff("b", "docs/second.md", patch.replace("file-specific", "second-specific"))];
    const { input, result } = await capture(query, candidates);
    expect(input.query).toBe(query.slice(0, 200));
    const budget = 1700 - input.query.length;
    for (const [i, { text }] of input.contexts.entries()) {
      expect(text.startsWith(candidates[i].filePath! + "\n\nCommit headline\n\n")).toBe(true);
      const sentPatch = text.slice(text.indexOf("@@"));
      expect(sentPatch.length).toBeGreaterThanOrEqual(Math.ceil(budget / 2));
      expect(candidates[i].content).toContain(sentPatch);
      expect(text.length + input.query.length).toBeLessThanOrEqual(1700);
    }
    expect(input.contexts[0].text).toContain("file-specific");
    expect(input.contexts[1].text).toContain("second-specific");
    // Equal model scores are valid; caller identity and input order survive.
    expect(result).toEqual([{ id: "a", score: 0.5 }, { id: "b", score: 0.5 }]);
  });

  it("keeps all of a short real patch and caps a long headline", async () => {
    const short = "@@ -1 +1 @@\n-a\n+b";
    const candidate = diff("a", "a.ts", short);
    candidate.content = "H".repeat(500) + candidate.content.slice(candidate.content.indexOf("\n"));
    const { input } = await capture("q", [candidate, diff("b", "b.ts", short)]);
    expect(input.contexts[0].text).toBe("a.ts\n\n" + "H".repeat(120) + "\n\n" + short);
  });

  it("uses raw bounded prefixes for unverifiable boundaries and non-diff candidates", async () => {
    const valid = diff("a", "a.ts");
    const cases: RerankCandidate[] = [
      { ...valid, id: "missing-path", filePath: undefined },
      { ...valid, id: "mismatch", filePath: "other.ts" },
      { ...valid, id: "missing-boundary", content: message },
      { ...valid, id: "ambiguous", content: valid.content + "\n\na.ts\n\n" + patch },
      diff("empty", "a.ts", ""), diff("whitespace", "a.ts", "   "),
      diff("lost-patch", "a.ts", "commit prose that mentions this path"),
      diff("partial-header", "a.ts", "@@ -1 +"),
      diff("long-path", "x".repeat(900)), diff("newline-path", "a\nb.ts"),
      { ...valid, id: "doc", type: "doc" }, { ...valid, id: "no-type", type: undefined },
    ];
    const { input } = await capture("q".repeat(500), cases);
    expect(input.contexts.map(c => c.text)).toEqual(cases.map(c => c.content.slice(0, 1500)));
  });

  it("falls back at the ingestion cap even when only a quoted path/hunk survived", async () => {
    const fakeCommit = "Commit headline\n\na.ts\n\n@@ -1 +1 @@\n-fake\n+quoted in commit\n" + "prose ".repeat(1500);
    const truncated = prepareDiffEmbeddingInput(fakeCommit, "a.ts", "@@ -2 +2 @@\n-real\n+actual patch");
    expect(truncated.length).toBe(MAX_EMBEDDING_INPUT_CHARS);
    expect(truncated).not.toContain("actual patch");
    const candidates = [
      { id: "lost", type: "diff", filePath: "a.ts", content: truncated },
      diff("at-cap", "a.ts"), diff("over-cap", "a.ts"), diff("under-cap", "a.ts"),
    ];
    for (const [i, length] of [[1, 8000], [2, 8001], [3, 7999]]) {
      candidates[i].content = candidates[i].content.padEnd(length, "x");
    }
    const { input } = await capture("q", candidates);
    expect(input.contexts.slice(0, 3).map(c => c.text)).toEqual(candidates.slice(0, 3).map(c => c.content.slice(0, 1699)));
    expect(input.contexts[3].text.startsWith("a.ts\n\nCommit headline\n\n@@")).toBe(true);
  });

  it("reduces headline overhead for a near-limit path and retains the candidate cap", async () => {
    const path = "p".repeat(746);
    const { input, result } = await capture("q".repeat(500),
      Array.from({ length: 55 }, (_, i) => diff(String(i), path)));
    expect(input.contexts).toHaveLength(50);
    expect(input.top_k).toBe(50);
    expect(result).toHaveLength(50);
    for (const { text } of input.contexts) {
      expect(text).toBe(path + "\n\n\n\n" + patch.slice(0, 750));
      expect(text.length).toBe(1500);
    }
  });

  it("preserves IDs when blank candidates are removed before preparing diffs", async () => {
    const { result, input } = await capture("q", [cand("blank", " "), diff("a", "a.ts"), diff("b", "b.ts")]);
    expect(input.contexts).toHaveLength(2);
    expect(result!.map(r => r.id)).toEqual(["a", "b"]);
  });
});
