/**
 * Cross-encoder reranker — Workers AI `@cf/baai/bge-reranker-base`.
 *
 * Layer = L4 Operations (3rd retrieval tier on top of hybrid dense+sparse+RRF)
 *
 * Responsibilities:
 * - Send a (query, candidate contents) batch to bge-reranker-base.
 * - Truncate (query + candidate content) pairs to fit the model's 512-token
 *   context window using a conservative character-based estimate.
 * - Map the model's per-candidate relevance scores back onto the input order.
 * - Degrade gracefully when the AI binding errors or returns an unexpected
 *   shape — callers should keep the pre-rerank order intact in that case.
 *
 * Notes on the model:
 * - Cloudflare exposes bge-reranker-base as a cross-encoder. Request shape:
 *     { query: string, contexts: Array<{ text: string }>, top_k?: number }
 *   Response shape (per docs as of 2026-04):
 *     { response: Array<{ id: number, score: number }> }
 *   `id` is the 0-based index into the input `contexts` array.
 *   `result.usage` (token accounting) is not documented; we read it
 *   defensively for observability but do not depend on it.
 * - bge-reranker-base is English-centric. Multilingual content (e.g. Japanese
 *   issue bodies in this project) may see degraded ranking quality. Tracked
 *   as a known limitation in issue #91; out of scope for this layer.
 */

import type { Env } from "./types.js";

/**
 * Conservative character budget for one (query + content) pair.
 *
 * bge-reranker-base inherits BAAI's 512-token context window. We do not have
 * a tokenizer in Workers, so we approximate with characters.
 *
 * Empirical baseline:
 *   - English: ~4 chars/token
 *   - Japanese / mixed CJK: ~2 chars/token
 * We pick 1700 chars total budget (≈ 425 tokens at ~4 chars/token, or
 * ≈ 850 tokens-of-CJK at ~2 chars/token — over budget, but the truncate
 * still meaningfully shortens long bodies). The query slot reserves up to
 * 200 chars; the rest is for content.
 *
 * The constant is intentionally conservative: better to under-feed than to
 * have the model silently truncate input, because the silent truncate would
 * always cut from the tail (losing the most-recent commit/issue context).
 */
const MAX_PAIR_CHARS = 1700;
const MAX_QUERY_CHARS = 200;

/** Hard ceiling on candidates sent to the reranker per call. */
export const RERANK_MAX_CANDIDATES = 50;

/**
 * Truncate one (query, content) pair so total chars fit MAX_PAIR_CHARS.
 *
 * The query is truncated first to MAX_QUERY_CHARS, then the content is
 * truncated to fit the remaining budget. This biases the budget toward
 * candidate content, which is where the relevance signal lives for
 * cross-encoders.
 */
export function truncatePair(query: string, content: string): { query: string; content: string } {
  const q = query.length > MAX_QUERY_CHARS ? query.slice(0, MAX_QUERY_CHARS) : query;
  const remaining = MAX_PAIR_CHARS - q.length;
  // Reserve at least a few hundred chars for content even if the query is huge.
  const contentBudget = Math.max(remaining, MAX_PAIR_CHARS - MAX_QUERY_CHARS);
  const c = content.length > contentBudget ? content.slice(0, contentBudget) : content;
  return { query: q, content: c };
}

/** Input candidate for reranking. `content` is the text shown to the cross-encoder. */
export interface RerankCandidate {
  /** Stable identifier owned by the caller (e.g. Vectorize vector_id). Returned as-is. */
  id: string;
  /** Tokenizable text used by the cross-encoder. Empty string is allowed but contributes no signal. */
  content: string;
}

/** Per-candidate reranker output. `score` is the cross-encoder relevance score (higher = better). */
export interface RerankResult {
  id: string;
  score: number;
}

/**
 * Possible shapes returned by the AI binding for bge-reranker-base.
 *
 * Cloudflare's documented shape is `{ response: Array<{ id, score }> }` but
 * Workers AI has historically returned bare arrays for some models, so we
 * accept both. Unknown shapes fall through to the graceful fallback path.
 */
type RerankerResponse =
  | { response: Array<{ id: number; score: number }>; usage?: unknown }
  | Array<{ id: number; score: number }>;

/**
 * Rerank candidates with bge-reranker-base.
 *
 * Behavior:
 * - Returns a new array sorted by reranker score, descending. Length is
 *   `min(candidates.length, topK ?? candidates.length, RERANK_MAX_CANDIDATES_after_clamp)`.
 * - Empty `candidates` returns an empty array immediately (no AI call).
 * - Single-element `candidates` returns a passthrough with a synthesized
 *   score of 1, to avoid burning a Workers AI call on a one-element list.
 * - Any thrown error from `env.AI.run` or any malformed response returns
 *   `null` so the caller can keep the original (pre-rerank) order.
 *   The intent is "rerank is best-effort improvement, never a blocker".
 *
 * The caller is expected to have already capped `candidates.length` to a
 * reasonable overfetch size (issue #91 default: top_k × 5, max 50). We
 * additionally clamp here as a defensive lower bound — if a caller forgets,
 * we still bound the AI cost.
 */
export async function rerankCandidates(
  env: Env,
  query: string,
  candidates: RerankCandidate[],
  topK?: number,
): Promise<RerankResult[] | null> {
  if (candidates.length === 0) return [];
  if (candidates.length === 1) {
    return [{ id: candidates[0].id, score: 1 }];
  }

  // Defensive clamp on candidate count.
  const trimmedCandidates = candidates.slice(0, RERANK_MAX_CANDIDATES);

  // Build (query, contexts) payload with per-pair truncation. The query is
  // shared across all pairs; we still truncate it once up front.
  const truncatedQuery =
    query.length > MAX_QUERY_CHARS ? query.slice(0, MAX_QUERY_CHARS) : query;
  const contexts = trimmedCandidates.map((c) => {
    const { content } = truncatePair(truncatedQuery, c.content);
    return { text: content };
  });

  // The AI binding's typing is intentionally loose; we cast through unknown
  // and validate the shape ourselves.
  let raw: RerankerResponse;
  try {
    raw = (await env.AI.run("@cf/baai/bge-reranker-base", {
      query: truncatedQuery,
      contexts,
      // Ask for all candidates back; we sort and trim ourselves so the caller
      // can apply their own topK after post-filtering.
      top_k: trimmedCandidates.length,
    })) as unknown as RerankerResponse;
  } catch (err) {
    console.error(
      "rerankCandidates: bge-reranker-base call failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // Normalize response to Array<{ id, score }>.
  let scored: Array<{ id: number; score: number }>;
  if (Array.isArray(raw)) {
    scored = raw;
  } else if (raw && Array.isArray(raw.response)) {
    scored = raw.response;
  } else {
    console.error(
      "rerankCandidates: unexpected response shape from bge-reranker-base; falling back to pre-rerank order",
    );
    return null;
  }

  // Map id (0-based input index) back to the caller's stable id, drop any
  // out-of-range indices defensively.
  const results: RerankResult[] = [];
  for (const s of scored) {
    if (typeof s.id !== "number" || typeof s.score !== "number") continue;
    if (s.id < 0 || s.id >= trimmedCandidates.length) continue;
    results.push({ id: trimmedCandidates[s.id].id, score: s.score });
  }

  // Sort by score descending. The model usually returns sorted, but we do
  // not depend on that — explicit sort keeps the contract local.
  results.sort((a, b) => b.score - a.score);

  if (typeof topK === "number" && topK > 0 && results.length > topK) {
    return results.slice(0, topK);
  }
  return results;
}
