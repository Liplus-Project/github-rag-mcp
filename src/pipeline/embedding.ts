/**
 * Workers AI embedding wrappers and batching constants.
 *
 * Wraps the BGE-M3 model behind `generateEmbedding` (single text) and
 * `generateEmbeddingBatch` (multi-text). Callers must chunk inputs with
 * `planEmbeddingBatches`; the helper does not split internally.
 */

/** Maximum characters for embedding input (BGE-M3 context limit ~8192 tokens, conservative char limit) */
export const MAX_EMBEDDING_INPUT_CHARS = 8000;

/**
 * Aggregate context the Workers AI endpoint accepts across all inputs of one
 * batched embed call. Not the per-input maximum bge-m3 documents (8192) — the
 * batch is summed, and the endpoint reports the sum it rejected:
 *
 *   3030: Max context reached 85920 tokens but model supports only 60000
 *
 * Unpublished, so this is read off the error rather than a docs page. Kept named
 * because the character budget below is derived from it, and a budget whose
 * reference is inlined reads as an arbitrary number the next time someone
 * retunes it.
 */
export const WORKERS_AI_BATCH_CONTEXT_LIMIT = 60000;

/**
 * Special tokens the model wraps around each input of a batch (`<s>` … `</s>`).
 *
 * The only part of a batch's token count that does not come from the input text,
 * so it is the only part a character count cannot cover. It is charged per input
 * rather than once per batch because the batch's input count is not bounded
 * anywhere: a batch of many tiny inputs is where a single flat reserve would come
 * up short, and that is exactly the case a fixed constant hides.
 */
export const SPECIAL_TOKENS_PER_INPUT = 2;

/**
 * Character budget for the inputs of one batched Workers AI embed call.
 *
 * The ceiling itself, in characters, because characters *dominate* tokens rather
 * than approximating them: every token of a BPE or SentencePiece vocabulary spans
 * at least one character of the input, so for any input
 *
 *   tokens(input) <= input.length + SPECIAL_TOKENS_PER_INPUT
 *
 * and a batch whose charged total stays inside this budget is inside the ceiling
 * unconditionally — no calibration, and no dependence on the payload's language or
 * punctuation density. Which matters because the estimate this replaced was wrong
 * by about 2.1x on the surface that actually failed: diff patches run near 1.4
 * characters per token, not the 3 an ASCII-prose ratio assumed, so batches judged
 * to fit under a 30000-token budget reached 60678 and 64413 against the ceiling and
 * failed their whole chunk. A commit whose vectors never landed is one the diff
 * watermark holds on, so the surface stalled on the same commit every cron tick.
 *
 * Equality with the ceiling is admissible: the rejections name counts strictly
 * above it (`Max context reached 60678 tokens but model supports only 60000`), so
 * 60000 is a supported count and not the first rejected one.
 *
 * Sized in characters rather than under the ceiling by a margin because a margin
 * is not free — every extra batch costs two subrequests (the AI call and its
 * `VECTORIZE.upsert`) against an invocation budget this worker already overruns,
 * and a bound that holds by construction has nothing left for a margin to buy.
 *
 * `MAX_EMBEDDING_INPUT_CHARS` truncates one input to 8000 characters, so a batch
 * holds at least 7 inputs however large each patch is. That floor is what the
 * poller's per-file subrequest estimate rests on.
 */
export const MAX_EMBEDDING_BATCH_CHARS = WORKERS_AI_BATCH_CONTEXT_LIMIT;

/** Half-open `[start, end)` index range over a caller's input array. */
export interface EmbeddingBatchRange {
  start: number;
  end: number;
}

/**
 * Split embedding inputs into batches whose character totals stay within
 * `budgetChars`.
 *
 * Each input is charged its own length plus `SPECIAL_TOKENS_PER_INPUT`, which makes
 * the charged total an upper bound on the batch's true token count rather than an
 * estimate of it (see `MAX_EMBEDDING_BATCH_CHARS`). Length is counted in UTF-16
 * code units, so a surrogate pair costs two — one more than the code point it
 * encodes, which errs on the side that keeps the bound.
 *
 * Index ranges are returned rather than the strings themselves so the caller can
 * slice its own parallel arrays (files, metadata) by the same boundaries — the
 * position-for-position correspondence between inputs and returned vectors is
 * what the upsert depends on.
 *
 * Contract:
 *  - order is preserved, ranges are contiguous, and every input falls in exactly one
 *  - no returned range is empty
 *  - an input whose own charge already exceeds the budget occupies a range of
 *    one. Cutting it down further belongs to the truncation axis
 *    (`MAX_EMBEDDING_INPUT_CHARS`), and dropping it would lose a file from the index.
 */
export function planEmbeddingBatches(
  inputs: string[],
  budgetChars: number = MAX_EMBEDDING_BATCH_CHARS,
): EmbeddingBatchRange[] {
  const ranges: EmbeddingBatchRange[] = [];
  let start = 0;
  let total = 0;

  for (let i = 0; i < inputs.length; i++) {
    const cost = inputs[i].length + SPECIAL_TOKENS_PER_INPUT;
    // Close the open range before an input that would overrun the budget. The
    // `i > start` guard is what keeps an oversized input in a batch of its own
    // instead of closing an empty range and looping on it forever.
    if (i > start && total + cost > budgetChars) {
      ranges.push({ start, end: i });
      start = i;
      total = 0;
    }
    total += cost;
  }

  if (inputs.length > start) ranges.push({ start, end: inputs.length });
  return ranges;
}

/**
 * Generate embedding for a text input using Workers AI BGE-M3.
 * Returns 1024-dimensional float array.
 */
export async function generateEmbedding(
  ai: Ai,
  text: string,
): Promise<number[]> {
  const result = await ai.run("@cf/baai/bge-m3", {
    text: [text],
  });

  // Workers AI returns { data: [{ values: number[] }] } or similar
  const vectors = (result as { data: Array<number[]> }).data;
  if (!vectors || vectors.length === 0) {
    throw new Error("Workers AI returned no embedding vectors");
  }
  return vectors[0];
}

/**
 * Generate embeddings for multiple text inputs in one batched Workers AI call.
 * Input order is preserved in the returned array.
 *
 * Workers AI does not publish a hard limit on the size of one embed call, so
 * callers must chunk with `planEmbeddingBatches` before invoking this function.
 * Throws if the returned vector count does not match the input count.
 */
export async function generateEmbeddingBatch(
  ai: Ai,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const result = await ai.run("@cf/baai/bge-m3", { text: texts });
  const vectors = (result as { data: Array<number[]> }).data;

  if (!vectors || vectors.length !== texts.length) {
    throw new Error(
      `Workers AI returned ${vectors?.length ?? 0} vectors for ${texts.length} inputs`,
    );
  }
  return vectors;
}
