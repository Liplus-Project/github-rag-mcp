/**
 * Workers AI embedding wrappers and batching constants.
 *
 * Wraps the BGE-M3 model behind `generateEmbedding` (single text) and
 * `generateEmbeddingBatch` (multi-text). Callers must chunk inputs with
 * `planEmbeddingBatches`; the helper does not split internally.
 */

/** Characters one embedding input is truncated to.
 *
 *  A character cap, and only that. It was written against bge-m3's documented
 *  8192-token per-input window on the reading that a token spans a character, which
 *  byte fallback breaks the same way it broke the batch budget below: 8000
 *  characters of Japanese can decompose into far more tokens than that window holds.
 *  Whether the per-input axis needs a byte cap of its own is a separate question
 *  from the batch total this file bounds — the per-input window is enforced by the
 *  model, while the batch total is what the endpoint rejects outright. */
export const MAX_EMBEDDING_INPUT_CHARS = 8000;

/**
 * Aggregate context the Workers AI endpoint accepts across all inputs of one
 * batched embed call. Not the per-input maximum bge-m3 documents (8192) — the
 * batch is summed, and the endpoint reports the sum it rejected:
 *
 *   3030: Max context reached 85920 tokens but model supports only 60000
 *
 * Unpublished, so this is read off the error rather than a docs page. Kept named
 * because the byte budget below is derived from it, and a budget whose reference
 * is inlined reads as an arbitrary number the next time someone retunes it.
 */
export const WORKERS_AI_BATCH_CONTEXT_LIMIT = 60000;

/**
 * Tokens one input of a batch costs beyond what its own bytes account for.
 *
 * Two are the sentinels the model wraps around each input (`<s>` … `</s>`). The
 * third is the SentencePiece word-boundary marker: the tokenizer prefixes the text
 * with `▁`, and where that marker does not merge into the first piece it is emitted
 * as a token of its own, consuming no byte of the input. Three tokens per input is
 * therefore what the byte count below cannot see.
 *
 * Charged per input rather than once per batch because the batch's input count is
 * not bounded anywhere: a batch of many tiny inputs is where a single flat reserve
 * comes up short, and each of those inputs carries its own three.
 */
export const TOKEN_OVERHEAD_PER_INPUT = 3;

/**
 * UTF-8 bytes a string occupies.
 *
 * Counted off the UTF-16 code units rather than through `TextEncoder` so that
 * measuring an input allocates no copy of it. A lone surrogate is charged 3 — the
 * width of the U+FFFD that `TextEncoder` substitutes for it — so the count agrees
 * with the encoder on ill-formed strings too, which matters because the truncation
 * in `prepareDiffEmbeddingInput` cuts on a code-unit boundary and can leave one.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        // A well-formed pair is one code point above the BMP: 4 bytes for 2 units.
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * UTF-8 byte budget for the inputs of one batched Workers AI embed call.
 *
 * The ceiling itself, in bytes, because bytes *dominate* tokens rather than
 * approximating them: the finest split any of these tokenizers can make is one
 * token per byte of the UTF-8 input — that is what byte fallback is — so for any
 * input
 *
 *   tokens(input) <= utf8ByteLength(input) + TOKEN_OVERHEAD_PER_INPUT
 *
 * and a batch whose charged total stays inside this budget is inside the ceiling.
 * No calibration and no per-payload measurement, which is the property the two
 * budgets before this one were reaching for and missed:
 *
 *  - an estimated token count ran about 2.1x optimistic on diff patches and handed
 *    the endpoint 60678 and 64413 tokens against the ceiling;
 *  - a character count rested on "a token spans at least one character", which byte
 *    fallback breaks — a character outside the vocabulary is decomposed into its
 *    UTF-8 bytes, so one 3-byte Japanese character can cost 3 tokens. Production
 *    measured 68736 tokens on a batch charged at most 60000 characters, a ratio of
 *    1.146 tokens per character.
 *
 * Bytes are the floor under that decomposition: nothing splits finer, so no payload
 * can be the one this underestimates the way the two above were. The bound assumes
 * the tokenizer's NFKC normalization does not expand the input in bytes, which holds
 * except for compatibility characters that decompose into several (Arabic ligatures,
 * CJK square abbreviations). That is a different class of exposure from the two
 * retired premises: those broke on ordinary diff text, this one needs an input made
 * predominantly of one rare block.
 *
 * Equality with the ceiling is admissible: the rejections name counts strictly
 * above it (`Max context reached 68736 tokens but model supports only 60000`), so
 * 60000 is a supported count and not the first rejected one.
 *
 * Held at the ceiling rather than under it by a margin because a margin is not free
 * — every extra batch costs two subrequests (the AI call and its
 * `VECTORIZE.upsert`) against an invocation budget this worker already overruns,
 * and a bound that holds by construction has nothing left for a margin to buy.
 *
 * `MAX_EMBEDDING_INPUT_CHARS` truncates one input to 8000 characters, which is at
 * most 24000 bytes (3 per UTF-16 code unit is the widest UTF-8 gets; a surrogate
 * pair is 4 bytes across 2 units), so a batch holds at least 2 inputs however large
 * each patch is. That floor is what the poller's per-file subrequest estimate rests
 * on, and it is a third of what the character budget gave — a batch of Japanese
 * patches now splits about three ways where it used to be one call. The extra
 * subrequests are the price of the bound actually holding.
 */
export const MAX_EMBEDDING_BATCH_BYTES = WORKERS_AI_BATCH_CONTEXT_LIMIT;

/** Half-open `[start, end)` index range over a caller's input array. */
export interface EmbeddingBatchRange {
  start: number;
  end: number;
}

/**
 * Split embedding inputs into batches whose UTF-8 byte totals stay within
 * `budgetBytes`.
 *
 * Each input is charged its own byte length plus `TOKEN_OVERHEAD_PER_INPUT`, which
 * makes the charged total an upper bound on the batch's true token count rather
 * than an estimate of it (see `MAX_EMBEDDING_BATCH_BYTES`).
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
  budgetBytes: number = MAX_EMBEDDING_BATCH_BYTES,
): EmbeddingBatchRange[] {
  const ranges: EmbeddingBatchRange[] = [];
  let start = 0;
  let total = 0;

  for (let i = 0; i < inputs.length; i++) {
    const cost = utf8ByteLength(inputs[i]) + TOKEN_OVERHEAD_PER_INPUT;
    // Close the open range before an input that would overrun the budget. The
    // `i > start` guard is what keeps an oversized input in a batch of its own
    // instead of closing an empty range and looping on it forever.
    if (i > start && total + cost > budgetBytes) {
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
