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
 * Token budget for the inputs of one batched Workers AI embed call.
 *
 * Anchored to bge-m3's documented per-input maximum (8192 tokens), which is the
 * only published number on this axis: a batch must be able to carry one maximal
 * input, so the budget cannot sit below it, and holding it exactly there means a
 * single call never presents more than one model context worth of text.
 *
 * A count cap cannot express this. Characters per token vary by an order of
 * magnitude across the content this pipeline embeds — roughly 3 for ASCII source,
 * roughly 1 for CJK prose — so N inputs bound the request only when every input
 * is assumed to be the cheap kind.
 */
export const MAX_EMBEDDING_BATCH_TOKENS = 8192;

/**
 * Characters per token assumed for the ASCII range. bge-m3 tokenizes with an
 * XLM-RoBERTa SentencePiece vocabulary, where English prose runs near 4 and
 * punctuation-dense source code runs nearer 3. The lower figure is used because
 * the diff surface is source code and an underestimate is what overruns a call.
 */
const ASCII_CHARS_PER_TOKEN = 3;

/**
 * Estimate the token cost of one embedding input.
 *
 * Deliberately an estimate: the tokenizer is not available inside the Worker, and
 * the value is only ever compared against a budget that is itself conservative.
 * Non-ASCII code units are counted one token each (the CJK worst case), ASCII at
 * `ASCII_CHARS_PER_TOKEN`. Counting UTF-16 code units rather than code points
 * makes a surrogate pair cost two, which errs toward the safe side.
 */
export function estimateEmbeddingTokens(text: string): number {
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) wide++;
  }
  const ascii = text.length - wide;
  return wide + Math.ceil(ascii / ASCII_CHARS_PER_TOKEN);
}

/** Half-open `[start, end)` index range over a caller's input array. */
export interface EmbeddingBatchRange {
  start: number;
  end: number;
}

/**
 * Split embedding inputs into batches whose estimated token totals stay within
 * `budgetTokens`.
 *
 * Index ranges are returned rather than the strings themselves so the caller can
 * slice its own parallel arrays (files, metadata) by the same boundaries — the
 * position-for-position correspondence between inputs and returned vectors is
 * what the upsert depends on.
 *
 * Contract:
 *  - order is preserved, ranges are contiguous, and every input falls in exactly one
 *  - no returned range is empty
 *  - an input whose own estimate already exceeds the budget occupies a range of
 *    one. Cutting it down further belongs to the truncation axis
 *    (`MAX_EMBEDDING_INPUT_CHARS`), and dropping it would lose a file from the index.
 */
export function planEmbeddingBatches(
  inputs: string[],
  budgetTokens: number = MAX_EMBEDDING_BATCH_TOKENS,
): EmbeddingBatchRange[] {
  const ranges: EmbeddingBatchRange[] = [];
  let start = 0;
  let total = 0;

  for (let i = 0; i < inputs.length; i++) {
    const cost = estimateEmbeddingTokens(inputs[i]);
    // Close the open range before an input that would overrun the budget. The
    // `i > start` guard is what keeps an oversized input in a batch of its own
    // instead of closing an empty range and looping on it forever.
    if (i > start && total + cost > budgetTokens) {
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
