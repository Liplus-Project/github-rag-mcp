import { describe, it, expect } from "vitest";
import {
  planEmbeddingBatches,
  utf8ByteLength,
  MAX_EMBEDDING_INPUT_CHARS,
  TOKEN_OVERHEAD_PER_INPUT,
  WORKERS_AI_BATCH_CONTEXT_LIMIT,
} from "./embedding.js";

/** What the endpoint charges one batch: its input count times its longest input,
 *  each input measured in UTF-8 bytes plus its per-input token overhead. The
 *  padding model, so the charge does not fall when short inputs join a batch. */
function batchCharge(texts: string[]): number {
  if (texts.length === 0) return 0;
  const longest = Math.max(
    ...texts.map((text) => utf8ByteLength(text) + TOKEN_OVERHEAD_PER_INPUT),
  );
  return texts.length * longest;
}

function rangeCharge(inputs: string[], range: { start: number; end: number }): number {
  return batchCharge(inputs.slice(range.start, range.end));
}

/** What the retired byte-sum budget charged the same inputs (#244). Kept in the
 *  tests only, to hold the regression fixtures inside the shape that budget passed
 *  and the endpoint rejected. */
function retiredSumCharge(texts: string[]): number {
  return texts.reduce((total, text) => total + utf8ByteLength(text) + TOKEN_OVERHEAD_PER_INPUT, 0);
}

/** What the retired character budget charged the same inputs (#242): UTF-16 code
 *  units plus two special tokens. */
function retiredCharCharge(inputs: string[]): number {
  return inputs.reduce((total, text) => total + text.length + 2, 0);
}

describe("utf8ByteLength", () => {
  const encoder = new TextEncoder();

  it("agrees with TextEncoder on every width", () => {
    // The count is derived from code units rather than by encoding, so the encoder
    // is what it has to stay equal to. One case per UTF-8 width, plus the ill-formed
    // input truncation can produce.
    const samples = [
      "",
      "plain ascii text",
      "+  const value = obj?.[key] ?? { a: 1, b: [2, 3] };\n",
      "é", // 2 bytes
      "あ", // 3 bytes
      "日本語のテキスト", // 3 bytes each
      "🐈", // surrogate pair, 4 bytes
      "mixed あ 🐈 text é",
      "\uD83D", // lone high surrogate -> U+FFFD, 3 bytes
      "\uDC08", // lone low surrogate -> U+FFFD, 3 bytes
      "🐈".repeat(50).slice(0, 51), // pair cut in half by a code-unit slice
    ];

    for (const sample of samples) {
      expect(utf8ByteLength(sample)).toBe(encoder.encode(sample).length);
    }
  });

  it("charges non-ASCII more than its character count", () => {
    // The whole reason the budget moved off characters: these two are the same
    // length and not the same size.
    expect(utf8ByteLength("あ".repeat(1000))).toBe(3000);
    expect(utf8ByteLength("x".repeat(1000))).toBe(1000);
  });
});

describe("WORKERS_AI_BATCH_CONTEXT_LIMIT", () => {
  it("divides the four production rejections into equal per-input slots", () => {
    // The measurement the bound is built on. Each rejection's reported figure is its
    // input count times an integer, and the last two are the same commit sent at
    // different counts with the quotient unchanged — which a true sum of the inputs
    // could only produce if the 4 dropped inputs had been identical in length.
    const rejections = [
      { inputs: 18, reported: 60678, perInput: 3371 },
      { inputs: 17, reported: 64413, perInput: 3789 },
      { inputs: 20, reported: 85920, perInput: 4296 },
      { inputs: 16, reported: 68736, perInput: 4296 },
    ];

    for (const { inputs, reported, perInput } of rejections) {
      expect(inputs * perInput).toBe(reported);
      expect(reported).toBeGreaterThan(WORKERS_AI_BATCH_CONTEXT_LIMIT);
    }
    // Same commit, two counts, one quotient: the padded-slot width, not a sum.
    expect(rejections[2].perInput).toBe(rejections[3].perInput);
  });

  it("holds a batch of at least 2 maximal inputs", () => {
    // The floor the poller's DIFF_SUBREQUESTS_PER_FILE derivation reads off this
    // constant: a batch's 2 subrequests amortise over this many files, and at 2 the
    // per-file worst case is exactly the 3 the poller assumes. Truncation caps one
    // input at MAX_EMBEDDING_INPUT_CHARS characters, and a UTF-16 code unit is at
    // most 3 UTF-8 bytes, so that product is the largest input the planner can face.
    // Count times longest and the retired sum agree exactly on a batch of equal
    // inputs, which is why moving the bound left this floor where it was.
    const maxBytesPerInput = MAX_EMBEDDING_INPUT_CHARS * 3;
    const minInputsPerBatch = Math.floor(
      WORKERS_AI_BATCH_CONTEXT_LIMIT / (maxBytesPerInput + TOKEN_OVERHEAD_PER_INPUT),
    );
    expect(minInputsPerBatch).toBeGreaterThanOrEqual(2);

    // Asserted through the planner as well, on the widest payload there is, so the
    // arithmetic above cannot drift away from the behaviour it describes.
    const maximal = Array.from({ length: 20 }, () => "あ".repeat(MAX_EMBEDDING_INPUT_CHARS));
    expect(planEmbeddingBatches(maximal)[0].end).toBeGreaterThanOrEqual(minInputsPerBatch);
  });

  it("keeps the shortest input in a batch from cheapening it", () => {
    // The property that separates this axis from every sum: one large input among
    // small ones is charged as if all of them were large, so a batch cannot be made
    // to fit by padding it out with cheap inputs.
    const one = "あ".repeat(4000);
    expect(batchCharge([one])).toBe(utf8ByteLength(one) + TOKEN_OVERHEAD_PER_INPUT);
    expect(batchCharge([one, "x"])).toBe(2 * batchCharge([one]));
    expect(batchCharge([one, "x", "y", "z"])).toBe(4 * batchCharge([one]));
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

  it("splits when count times longest would overrun the budget", () => {
    // Charge 12 each (9 bytes + 3 overhead) against a budget of 24: 2 slots fit.
    const inputs = Array.from({ length: 5 }, () => "x".repeat(9));
    expect(planEmbeddingBatches(inputs, 24)).toEqual([
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

  it("charges the per-input overhead each input carries, not one flat reserve", () => {
    // Many tiny inputs is the case a per-batch reserve gets wrong: 60 bytes of text,
    // but 180 tokens of overhead on top. A planner charging text alone would fit all
    // 60 in one call of 60 and hand the endpoint 240.
    const inputs = Array.from({ length: 60 }, () => "x");
    const ranges = planEmbeddingBatches(inputs, 60);

    expect(ranges.length).toBeGreaterThan(1);
    for (const range of ranges) {
      expect(rangeCharge(inputs, range)).toBeLessThanOrEqual(60);
    }
  });

  it("charges non-ASCII by what it costs, not by how long it reads", () => {
    // The property the retired character budget did not have, and the reason it
    // failed: it planned the same way for the same character count whatever the
    // script, so a Japanese payload was charged a third of what it costs. The same
    // count of Japanese characters must now be charged three times as much and split
    // into more calls.
    const chars = 12000;
    const ascii = Array.from({ length: 12 }, () => "x".repeat(chars));
    const cjk = Array.from({ length: 12 }, () => "あ".repeat(chars));

    expect(utf8ByteLength(cjk[0])).toBe(3 * utf8ByteLength(ascii[0]));
    expect(planEmbeddingBatches(cjk).length).toBeGreaterThan(
      planEmbeddingBatches(ascii).length,
    );
  });

  it("splits the production shape a character budget passed whole", () => {
    // 2026-08-15 cron, one commit of 16 Japanese-heavy files: the character budget
    // charged the batch at most 60000 and sent it as one call, and the endpoint
    // answered `Max context reached 68736 tokens but model supports only 60000` —
    // 1.146 tokens per character, so a token had not spanned a character at all.
    const inputs = Array.from({ length: 16 }, () => "あ".repeat(3700));

    // The fixture is only a regression test while it stays in the failing zone: the
    // retired character charge fits inside the budget it was measured against, so
    // that budget would have sent all 16 as one call.
    expect(retiredCharCharge(inputs)).toBeLessThanOrEqual(WORKERS_AI_BATCH_CONTEXT_LIMIT);

    const ranges = planEmbeddingBatches(inputs);
    expect(ranges.length).toBeGreaterThan(1);
    for (const range of ranges) {
      expect(rangeCharge(inputs, range)).toBeLessThanOrEqual(WORKERS_AI_BATCH_CONTEXT_LIMIT);
    }
    // Nothing is dropped on the way through the split.
    expect(ranges[ranges.length - 1].end).toBe(16);
  });

  it("splits the production shape a byte-sum budget passed whole", () => {
    // 2026-08-15 cron, `neuron-graph-rag@1fb0f6b`: 18 files, one long patch and a
    // tail of short ones. The byte-sum budget charged the batch about a fifth of the
    // ceiling and sent all 18 as one call; the endpoint answered `Max context reached
    // 60678 tokens but model supports only 60000` — 18 × 3371, the longest input
    // charged 18 times over. No sum-axis budget can see this batch, however tightly
    // it is tuned, which is what separates this fixture from the three before it.
    const longest = "x".repeat(3368);
    const inputs = [longest, ...Array.from({ length: 17 }, () => "x".repeat(500))];

    // The fixture is only a regression test while it stays in the failing zone: well
    // inside the retired byte-sum budget, well over the ceiling once padded.
    expect(retiredSumCharge(inputs)).toBeLessThanOrEqual(WORKERS_AI_BATCH_CONTEXT_LIMIT);
    expect(batchCharge(inputs)).toBeGreaterThan(WORKERS_AI_BATCH_CONTEXT_LIMIT);
    expect(batchCharge(inputs)).toBe(18 * 3371);

    const ranges = planEmbeddingBatches(inputs);
    expect(ranges.length).toBeGreaterThan(1);
    for (const range of ranges) {
      expect(rangeCharge(inputs, range)).toBeLessThanOrEqual(WORKERS_AI_BATCH_CONTEXT_LIMIT);
    }
    expect(ranges[ranges.length - 1].end).toBe(18);
  });

  it("reopens a batch when a later input widens the padding under it", () => {
    // The failure a running-sum planner cannot express: the first 17 inputs are
    // admissible together, and the 18th makes them inadmissible *retroactively* by
    // raising the width every slot is charged at. The cut therefore has to be
    // decided against the range's own longest member, recomputed as the range grows.
    const inputs = [...Array.from({ length: 17 }, () => "x".repeat(97)), "x".repeat(997)];

    expect(retiredSumCharge(inputs)).toBeLessThanOrEqual(2700);
    const ranges = planEmbeddingBatches(inputs, 2700);

    // 17 slots of 100 is 1700 and admissible; admitting the 18th would charge all
    // 18 slots at 1000, which is 18000 — the range has to close before it.
    expect(ranges).toEqual([
      { start: 0, end: 17 },
      { start: 17, end: 18 },
    ]);
    for (const range of ranges) {
      expect(rangeCharge(inputs, range)).toBeLessThanOrEqual(2700);
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
    // Truncation caps an input at MAX_EMBEDDING_INPUT_CHARS, and the default budget
    // must take one of those alone — otherwise the planner hands the endpoint a
    // single-input call it rejects, with nowhere further to split. Measured on the
    // widest encoding a truncated input can reach: 3 bytes per code unit.
    const maximal = "あ".repeat(MAX_EMBEDDING_INPUT_CHARS);
    expect(utf8ByteLength(maximal) + TOKEN_OVERHEAD_PER_INPUT).toBeLessThanOrEqual(
      WORKERS_AI_BATCH_CONTEXT_LIMIT,
    );
    expect(planEmbeddingBatches([maximal])).toEqual([{ start: 0, end: 1 }]);
  });
});
