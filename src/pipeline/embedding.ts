/**
 * Workers AI embedding wrappers and batching constants.
 *
 * Wraps the BGE-M3 model behind `generateEmbedding` (single text) and
 * `generateEmbeddingBatch` (multi-text). Callers must chunk inputs by
 * `MAX_EMBEDDING_BATCH_SIZE`; the helper does not split internally.
 */

/** Maximum characters for embedding input (BGE-M3 context limit ~8192 tokens, conservative char limit) */
export const MAX_EMBEDDING_INPUT_CHARS = 8000;

/**
 * Maximum number of inputs per Workers AI batch embed call.
 * Cloudflare Workers AI does not publish a hard cap on batched embedding inputs,
 * so we split large commits into multiple calls. 20 × 8000 chars ≈ 160k chars per
 * call keeps payload size comfortably inside observed request limits.
 */
export const MAX_EMBEDDING_BATCH_SIZE = 20;

/**
 * Maximum number of vectors per single Vectorize.upsert call.
 * We mirror MAX_EMBEDDING_BATCH_SIZE so each embed batch maps 1:1 onto one upsert.
 */
export const MAX_VECTORIZE_UPSERT_BATCH_SIZE = 20;

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
 * Workers AI does not publish a hard limit on the number of inputs per call,
 * so callers must chunk by MAX_EMBEDDING_BATCH_SIZE before invoking this
 * function. Throws if the returned vector count does not match the input count.
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
