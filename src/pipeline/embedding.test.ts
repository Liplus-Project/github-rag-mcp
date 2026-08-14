import { describe, it, expect } from "vitest";
import {
  planEmbeddingBatches,
  MAX_EMBEDDING_BATCH_CHARS,
  MAX_EMBEDDING_INPUT_CHARS,
  SPECIAL_TOKENS_PER_INPUT,
  WORKERS_AI_BATCH_CONTEXT_LIMIT,
} from "./embedding.js";

/** What the planner charges one batch: the inputs' characters plus their special
 *  tokens. An upper bound on the batch's true token count, not an estimate of it. */
function rangeCharge(inputs: string[], range: { start: number; end: number }): number {
  return inputs
    .slice(range.start, range.end)
    .reduce((total, text) => total + text.length + SPECIAL_TOKENS_PER_INPUT, 0);
}

describe("MAX_EMBEDDING_BATCH_CHARS", () => {
  it("does not exceed the endpoint's aggregate ceiling", () => {
    // The whole guarantee rests on this: a token spans at least one character, so a
    // batch charged under the ceiling *in characters* is under it in tokens too.
    // Raise this above the ceiling and the bound stops holding by construction and
    // goes back to being a calibration — the state #237 was in when the same two
    // commits kept reporting the same over-ceiling token counts (#241).
    expect(MAX_EMBEDDING_BATCH_CHARS).toBeLessThanOrEqual(WORKERS_AI_BATCH_CONTEXT_LIMIT);
  });

  it("holds a batch of at least 7 maximal inputs", () => {
    // The floor the poller's DIFF_SUBREQUESTS_PER_FILE derivation reads off this
    // constant: a batch's 2 subrequests amortise over this many files. Truncation
    // caps one input at MAX_EMBEDDING_INPUT_CHARS, so the ratio of the two limits
    // is the minimum file count, and it must not drop under what the poller assumes.
    const minInputsPerBatch = Math.floor(
      MAX_EMBEDDING_BATCH_CHARS / (MAX_EMBEDDING_INPUT_CHARS + SPECIAL_TOKENS_PER_INPUT),
    );
    expect(minInputsPerBatch).toBeGreaterThanOrEqual(7);

    // Asserted through the planner as well, so the arithmetic above cannot drift
    // away from the behaviour it describes.
    const maximal = Array.from({ length: 20 }, () => "x".repeat(MAX_EMBEDDING_INPUT_CHARS));
    expect(planEmbeddingBatches(maximal)[0].end).toBeGreaterThanOrEqual(minInputsPerBatch);
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
    // Charge 11 each (9 characters + 2 special tokens) against a budget of 22.
    const inputs = Array.from({ length: 5 }, () => "x".repeat(9));
    expect(planEmbeddingBatches(inputs, 22)).toEqual([
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
        expect(rangeCharge(inputs, range)).toBeLessThanOrEqual(1000);
      }
    }
  });

  it("charges the special tokens each input carries, not one flat reserve", () => {
    // Many tiny inputs is the case a per-batch reserve gets wrong: 60 characters of
    // text, but 120 special tokens on top. A planner charging text alone would fit
    // all 60 in one call of 60 and hand the endpoint 180.
    const inputs = Array.from({ length: 60 }, () => "x");
    const ranges = planEmbeddingBatches(inputs, 60);

    expect(ranges.length).toBeGreaterThan(1);
    for (const range of ranges) {
      expect(rangeCharge(inputs, range)).toBeLessThanOrEqual(60);
    }
  });

  it("plans the same way for scripts of the same length", () => {
    // The property the retired estimator did not have. It read ASCII at 3 characters
    // per token and non-ASCII at 1, so the same character count planned differently
    // by script — and the ASCII figure was the one that ran low on diff patches. A
    // character bound is blind to what the characters are, which is why no payload
    // can be the one it underestimates.
    const chars = 12000;
    const ascii = Array.from({ length: 12 }, () => "x".repeat(chars));
    const cjk = Array.from({ length: 12 }, () => "あ".repeat(chars));

    expect(planEmbeddingBatches(cjk)).toEqual(planEmbeddingBatches(ascii));
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
    // Truncation caps an input at MAX_EMBEDDING_INPUT_CHARS, and the default budget
    // must take one of those alone — otherwise the planner hands the endpoint a
    // single-input call it rejects, with nowhere further to split.
    const maximal = "あ".repeat(MAX_EMBEDDING_INPUT_CHARS);
    expect(maximal.length + SPECIAL_TOKENS_PER_INPUT).toBeLessThanOrEqual(
      MAX_EMBEDDING_BATCH_CHARS,
    );
    expect(planEmbeddingBatches([maximal])).toEqual([{ start: 0, end: 1 }]);
  });
});
