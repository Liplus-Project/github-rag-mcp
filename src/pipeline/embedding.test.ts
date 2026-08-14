import { describe, it, expect } from "vitest";
import {
  estimateEmbeddingTokens,
  planEmbeddingBatches,
  MAX_EMBEDDING_BATCH_TOKENS,
  MAX_EMBEDDING_INPUT_CHARS,
  WORKERS_AI_BATCH_CONTEXT_LIMIT,
} from "./embedding.js";

/** Sum of the per-input estimates over one planned range. */
function rangeTokens(inputs: string[], range: { start: number; end: number }): number {
  return inputs
    .slice(range.start, range.end)
    .reduce((total, text) => total + estimateEmbeddingTokens(text), 0);
}

describe("estimateEmbeddingTokens", () => {
  it("counts ASCII at the assumed characters-per-token ratio", () => {
    expect(estimateEmbeddingTokens("x".repeat(300))).toBe(100);
  });

  it("rounds a partial token up rather than down", () => {
    expect(estimateEmbeddingTokens("x")).toBe(1);
    expect(estimateEmbeddingTokens("xxxx")).toBe(2);
  });

  it("counts non-ASCII one token per code unit — the CJK worst case", () => {
    expect(estimateEmbeddingTokens("あ".repeat(100))).toBe(100);
  });

  it("separates the two ranges inside one mixed input", () => {
    // 300 ASCII (100 tokens) + 50 CJK (50 tokens).
    expect(estimateEmbeddingTokens("x".repeat(300) + "あ".repeat(50))).toBe(150);
  });

  it("is empty for empty input", () => {
    expect(estimateEmbeddingTokens("")).toBe(0);
  });

  it("separates content of equal character length by token cost", () => {
    // The whole point of the axis: same chars, different budget consumption.
    const ascii = "x".repeat(MAX_EMBEDDING_INPUT_CHARS);
    const cjk = "あ".repeat(MAX_EMBEDDING_INPUT_CHARS);
    expect(estimateEmbeddingTokens(cjk)).toBeGreaterThan(estimateEmbeddingTokens(ascii));
  });
});

describe("MAX_EMBEDDING_BATCH_TOKENS", () => {
  it("keeps a margin against the endpoint's aggregate ceiling", () => {
    // Asserted rather than left to the comment at the constant, because the
    // pressure on this number runs one way: every batch costs two subrequests on
    // an axis this worker already overruns, so the temptation is to walk the
    // budget up toward the ceiling. The estimator approximates, and an estimate
    // that lands under the true count is what reproduces the stall this batching
    // exists to prevent. A failing assertion here is not a verdict that the new
    // value is wrong — it says the estimator now has to earn the thinner margin.
    expect(MAX_EMBEDDING_BATCH_TOKENS).toBeLessThanOrEqual(
      WORKERS_AI_BATCH_CONTEXT_LIMIT / 2,
    );
  });

  it("stays above the per-input maximum a truncated input can reach", () => {
    // The floor on the same number: below this, a maximal input could not be sent
    // even alone, and the planner would be handing the endpoint a call it rejects.
    expect(MAX_EMBEDDING_BATCH_TOKENS).toBeGreaterThanOrEqual(MAX_EMBEDDING_INPUT_CHARS);
  });
});

describe("planEmbeddingBatches", () => {
  it("returns no range for no inputs", () => {
    expect(planEmbeddingBatches([])).toEqual([]);
  });

  it("keeps inputs that fit the budget in a single call", () => {
    const inputs = Array.from({ length: 50 }, () => "x".repeat(300));
    expect(planEmbeddingBatches(inputs)).toEqual([{ start: 0, end: 50 }]);
  });

  it("splits when the running total would overrun the budget", () => {
    // 3 tokens each against a budget of 6: two per call, then the remainder.
    const inputs = Array.from({ length: 5 }, () => "x".repeat(9));
    expect(planEmbeddingBatches(inputs, 6)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 5 },
    ]);
  });

  it("covers every input exactly once, in order", () => {
    const inputs = Array.from({ length: 37 }, (_, i) => "x".repeat(i * 30 + 1));
    const ranges = planEmbeddingBatches(inputs, 200);

    expect(ranges[0].start).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(inputs.length);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBe(ranges[i - 1].end);
    }
    expect(ranges.every((r) => r.end > r.start)).toBe(true);
  });

  it("holds every multi-input call inside the budget", () => {
    const inputs = Array.from({ length: 40 }, (_, i) =>
      i % 3 === 0 ? "あ".repeat(400) : "x".repeat(900),
    );
    const ranges = planEmbeddingBatches(inputs, 1000);

    for (const range of ranges) {
      if (range.end - range.start > 1) {
        expect(rangeTokens(inputs, range)).toBeLessThanOrEqual(1000);
      }
    }
  });

  it("gives an over-budget input a call of its own instead of stalling", () => {
    // The guard that makes this pass is what keeps the planner from closing an
    // empty range and looping on the same index forever.
    const inputs = ["x".repeat(30), "あ".repeat(5000), "x".repeat(30)];
    expect(planEmbeddingBatches(inputs, 100)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
  });

  it("admits any single truncated input under the default budget", () => {
    // Truncation caps an input at MAX_EMBEDDING_INPUT_CHARS; at the CJK worst case
    // that is one token per character, and the default budget must still take it.
    const maximal = "あ".repeat(MAX_EMBEDDING_INPUT_CHARS);
    expect(estimateEmbeddingTokens(maximal)).toBeLessThanOrEqual(MAX_EMBEDDING_BATCH_TOKENS);
    expect(planEmbeddingBatches([maximal])).toEqual([{ start: 0, end: 1 }]);
  });
});
