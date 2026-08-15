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
 *  from the batch charge this file bounds — the per-input window is enforced by the
 *  model, while the batch charge is what the endpoint rejects outright. The two do
 *  meet in one place: this cap is what puts a ceiling on the longest input a batch
 *  can hold, and that ceiling is what guarantees a batch of at least 2. */
export const MAX_EMBEDDING_INPUT_CHARS = 8000;

/**
 * Context the Workers AI endpoint accepts for one batched embed call. Not the
 * per-input maximum bge-m3 documents (8192) — the endpoint charges the call as a
 * whole and names the figure it rejected:
 *
 *   3030: Max context reached 85920 tokens but model supports only 60000
 *
 * What that figure counts is `input count × the longest input`, not the sum of the
 * inputs. Four rejections divide exactly by their input counts, and two of them are
 * the same commit sent at different counts:
 *
 *   18 inputs -> 60678 = 18 × 3371
 *   17 inputs -> 64413 = 17 × 3789
 *   20 inputs -> 85920 = 20 × 4296
 *   16 inputs -> 68736 = 16 × 4296
 *
 * The last pair is what settles it: dropping 4 inputs left the per-input quotient
 * unchanged at 4296, which a true sum could only do if the 4 dropped inputs were
 * identical in length. The endpoint pads a batch to its longest member and charges
 * every slot at that width.
 *
 * Unpublished, so this is read off the errors rather than a docs page.
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
 * What one input occupies in a padded slot of a batch, in UTF-8 bytes plus its
 * per-input token overhead.
 *
 * Bytes because they *dominate* the token count rather than approximating it: the
 * finest split any of these tokenizers can make is one token per byte of the UTF-8
 * input — that is what byte fallback is — so for any input
 *
 *   tokens(input) <= utf8ByteLength(input) + TOKEN_OVERHEAD_PER_INPUT
 *
 * No calibration and no per-payload measurement, which is the property two earlier
 * per-input measures were reaching for and missed: an estimated token count ran
 * about 2.1x optimistic on diff patches (#241), and a character count rested on "a
 * token spans at least one character", which byte fallback breaks — a character
 * outside the vocabulary is decomposed into its UTF-8 bytes, so one 3-byte Japanese
 * character can cost 3 tokens (#244). Bytes sit below that decomposition, so no
 * payload can be the one this underestimates the way those two were. What is left
 * assumed is that the tokenizer's NFKC normalization does not expand the input in
 * bytes, which holds except for compatibility characters that decompose into several
 * (Arabic ligatures, CJK square abbreviations) — an input would have to be made
 * predominantly of one rare block, where the two retired measures broke on ordinary
 * diff text.
 *
 * This is the per-input axis only. What the endpoint charges for a batch is this
 * measure taken over the *longest* input and multiplied by the input count; see
 * `planEmbeddingBatches`.
 */
function embeddingInputCost(text: string): number {
  return utf8ByteLength(text) + TOKEN_OVERHEAD_PER_INPUT;
}

/** Half-open `[start, end)` index range over a caller's input array. */
export interface EmbeddingBatchRange {
  start: number;
  end: number;
}

/**
 * Split embedding inputs into batches the endpoint will accept:
 *
 *   (end - start) × max(embeddingInputCost(input) over the range) <= budget
 *
 * The bound is on `count × longest`, not on the sum. Three budgets before this one
 * bounded the sum — by estimated tokens (#236), by characters (#242), by UTF-8 bytes
 * (#244) — and the endpoint kept rejecting the same batches, because the sum does
 * not appear in what it charges: it pads every slot of a batch to the longest input
 * and bills the padded width across the whole count (see
 * `WORKERS_AI_BATCH_CONTEXT_LIMIT` for the four measurements that show it). Tighten
 * a sum-axis bound however far and it still binds the wrong quantity.
 *
 * Two properties follow that a sum axis does not have. The largest input sets the
 * unit price for the whole batch, so a single large input among small ones is
 * charged as if all of them were large; and grouping inputs of similar size is
 * therefore what makes a batch efficient. Inputs are nonetheless taken in the order
 * given, without sorting: the caller slices its own parallel arrays (files,
 * metadata) by the returned boundaries, and the position-for-position
 * correspondence between inputs and returned vectors is what the upsert depends on.
 * Sorting would buy fewer calls at the cost of an index-set return type and a
 * permutation the caller has to carry — and it buys nothing against the worst case
 * the poller's subrequest budget is sized on, which is set by `MAX_EMBEDDING_INPUT_CHARS`
 * rather than by the packing.
 *
 * Equality with the budget is admissible: the rejections name charges strictly above
 * the ceiling (`Max context reached 60678 tokens but model supports only 60000`), so
 * 60000 is a supported charge and not the first rejected one. No margin is held under
 * it either — every extra batch costs two subrequests (the AI call and its
 * `VECTORIZE.upsert`) against an invocation budget this worker already overruns, and
 * a bound that holds by construction has nothing left for a margin to buy.
 *
 * Contract:
 *  - order is preserved, ranges are contiguous, and every input falls in exactly one
 *  - no returned range is empty
 *  - an input whose own cost already exceeds the budget occupies a range of
 *    one. Cutting it down further belongs to the truncation axis
 *    (`MAX_EMBEDDING_INPUT_CHARS`), and dropping it would lose a file from the index.
 *  - `MAX_EMBEDDING_INPUT_CHARS` truncates one input to 8000 characters, which is at
 *    most 24000 bytes (3 per UTF-16 code unit is the widest UTF-8 gets; a surrogate
 *    pair is 4 bytes across 2 units), so `2 × 24003 = 48006` fits the default budget
 *    and a batch holds at least 2 inputs however large each patch is. That floor is
 *    what the poller's per-file subrequest estimate rests on, and it is unchanged
 *    from the byte-sum budget this replaces.
 */
export function planEmbeddingBatches(
  inputs: string[],
  budget: number = WORKERS_AI_BATCH_CONTEXT_LIMIT,
): EmbeddingBatchRange[] {
  const ranges: EmbeddingBatchRange[] = [];
  let start = 0;
  let longest = 0;

  for (let i = 0; i < inputs.length; i++) {
    const cost = embeddingInputCost(inputs[i]);
    const widest = Math.max(longest, cost);
    // Close the open range before an input that would overrun the budget — either
    // by its own width or by widening the padding under every input already in the
    // range. The `i > start` guard is what keeps an oversized input in a batch of
    // its own instead of closing an empty range and looping on it forever.
    if (i > start && (i - start + 1) * widest > budget) {
      ranges.push({ start, end: i });
      start = i;
      longest = cost;
    } else {
      longest = widest;
    }
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
