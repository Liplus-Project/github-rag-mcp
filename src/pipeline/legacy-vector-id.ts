/**
 * Pre-migration ("legacy") Vectorize vector ID reconstruction.
 *
 * Before commit `215e2e2` (2026-04-19, PR #84) vector IDs embedded the scheme
 * parts as plain text — the doc surface used `{repo}#doc-{path}`. That scheme was
 * replaced by the hashed one in `./vector-id.ts`, and every delete path computes
 * the *current* ID. Vectors written before the migration therefore became
 * unreachable: the reap can never name them, so they keep answering dense
 * queries with pre-migration content (issue #204).
 *
 * This module is deliberately kept out of the `../pipeline.js` barrel. The legacy
 * scheme must never be reachable from ordinary ingest code; its only consumer is
 * the one-off purge in `../purge-legacy.ts`, which imports it by path so the
 * legacy path is explicit at the call site.
 *
 * Only the doc surface is reconstructed here. The migration changed every
 * surface's ID, but doc is the only surface where orphans have actually been
 * observed; the others are unconfirmed and out of scope for issue #204.
 */

/**
 * Vectorize's hard cap on vector ID length, in bytes.
 * Mirrored from `./vector-id.ts` — hitting this cap is what forced the migration.
 */
export const VECTORIZE_ID_MAX_BYTES = 64;

/**
 * Rebuild the pre-migration doc vector ID for a repo + path.
 *
 * Deterministic from the path alone, which is what makes the purge possible
 * without enumerating the index.
 */
export function legacyDocVectorId(repo: string, path: string): string {
  return `${repo}#doc-${path}`;
}

/**
 * Whether an ID is short enough to have ever existed in Vectorize.
 *
 * A legacy ID over the cap was rejected at upsert time — that overflow is the
 * reason the hashed scheme exists — so no vector can be keyed to it. Filtering
 * those out keeps a provably-absent ID from riding along in a delete batch.
 */
export function fitsVectorizeIdCap(id: string): boolean {
  return new TextEncoder().encode(id).length <= VECTORIZE_ID_MAX_BYTES;
}
