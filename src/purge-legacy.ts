/**
 * One-off purge of pre-migration ("legacy") doc vectors from Vectorize.
 *
 * Vector IDs were migrated from plain text to a hashed scheme in `215e2e2`
 * (2026-04-19, PR #84). Every delete path — the doc reap in `./poller.ts`, the
 * `removed` handling in `./webhook.ts` — computes the *current* ID, so vectors
 * written before that commit can never be named again. They stay in the index,
 * answer dense queries with pre-migration content, and take a candidate slot away
 * from the live row for the same file (issue #204).
 *
 * The fix is a purge, not a rebuild: the legacy ID is deterministic from the path
 * (`{repo}#doc-{path}`), so the orphan set can be reconstructed without
 * enumerating Vectorize and without re-embedding anything.
 *
 * Two path sources feed it:
 *  - the repo's current tree, which covers every file that is still alive and
 *    therefore currently double-indexed;
 *  - an explicit `paths` list, for files already deleted from the tree. Their
 *    legacy IDs cannot be enumerated from anything the worker still holds. That
 *    residue is finite and closed — the legacy scheme stopped writing in April
 *    2026 — so a one-time explicit pass finishes it.
 *
 * Nothing here touches current-generation vectors: the two ID formats are
 * disjoint (`{repo}#doc-...` vs `d:{base64url}`), and only IDs built by
 * `legacyDocVectorId` are ever handed to `deleteByIds`.
 */

import type { Env } from "./types.js";
import { listRepoDocPaths } from "./poller.js";
import { fitsVectorizeIdCap, legacyDocVectorId } from "./pipeline/legacy-vector-id.js";

/**
 * Legacy IDs deleted per call, unless the caller lowers it.
 *
 * The cap exists for the same reason the doc reap has one (issue #203): a Worker
 * invocation has a bounded subrequest budget and this endpoint shares it with
 * whatever else the request does. Deleting is far cheaper per item than reaping
 * (no per-item embed / D1 / store fan-out — just batched `deleteByIds` calls), so
 * the budget lands orders of magnitude higher than the reap's 5.
 */
export const DEFAULT_PURGE_LIMIT = 500;

/** Hard ceiling on the per-call limit a caller may request. */
export const MAX_PURGE_LIMIT = 2000;

/**
 * IDs per `deleteByIds` call. Vectorize documents no cap for deletes; the closest
 * documented Workers-side bound is 1000 vectors per upsert batch, so this stays
 * comfortably inside it.
 */
const DELETE_BATCH_SIZE = 500;

/** The only surface with confirmed legacy orphans (issue #204 scope). */
export type PurgeSurface = "doc";

export interface PurgeLegacyOptions {
  /** Report what would be deleted without calling Vectorize. */
  dryRun?: boolean;
  /** IDs to delete in this call (default `DEFAULT_PURGE_LIMIT`). */
  limit?: number;
  /** Offset into the ordered candidate list; resume point for a capped run. */
  cursor?: number;
  /** Paths already gone from the tree, whose legacy IDs nothing can enumerate. */
  paths?: string[];
}

export interface PurgeLegacySummary {
  repo: string;
  surface: PurgeSurface;
  dryRun: boolean;
  /** Legacy IDs that could exist, across the whole repo (tree + explicit paths). */
  candidates: number;
  /** Legacy IDs skipped as longer than Vectorize's 64-byte ID cap. */
  skippedOversize: number;
  /** True when the Trees API truncated its listing — the tree half is partial. */
  treeTruncated: boolean;
  cursor: number;
  limit: number;
  /** Candidates covered by this call. */
  targeted: number;
  /** Candidates actually handed to `deleteByIds` — always 0 on a dry run. */
  deleted: number;
  /** Candidates past this call's slice, left for the next one. */
  remaining: number;
  /** Cursor to pass back, or null when the walk is finished. */
  nextCursor: number | null;
  done: boolean;
}

/**
 * Build the ordered candidate list for a repo.
 *
 * Explicit paths come first so a capped run always covers the known-orphan set
 * before the (mostly clean) tree. Duplicates are dropped and the order is stable
 * across calls, which is what makes `cursor` resumable — provided the same
 * `paths` are passed each time, since dropping them shifts every later index.
 *
 * IDs over the Vectorize ID cap are dropped here rather than sent: a legacy ID
 * that long was rejected at upsert time, so no vector is keyed to it.
 */
function buildCandidates(
  repo: string,
  treePaths: string[],
  explicitPaths: string[],
): { ids: string[]; skippedOversize: number } {
  const seen = new Set<string>();
  const ids: string[] = [];
  let skippedOversize = 0;

  for (const path of [...explicitPaths, ...treePaths]) {
    const id = legacyDocVectorId(repo, path);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!fitsVectorizeIdCap(id)) {
      skippedOversize++;
      continue;
    }
    ids.push(id);
  }

  return { ids, skippedOversize };
}

/**
 * Purge one batch of legacy doc vectors for a repo.
 *
 * Deleting an ID that is absent is harmless, so a call is idempotent and safe to
 * repeat: if a batch throws mid-walk, resuming from the same `cursor` re-issues
 * the already-completed deletes without side effects.
 */
export async function purgeLegacyDocVectors(
  repo: string,
  env: Env,
  options: PurgeLegacyOptions = {},
): Promise<PurgeLegacySummary> {
  const dryRun = options.dryRun === true;
  const limit = options.limit ?? DEFAULT_PURGE_LIMIT;
  const cursor = options.cursor ?? 0;
  const explicitPaths = options.paths ?? [];

  const tree = await listRepoDocPaths(repo, env.GITHUB_TOKEN);
  const { ids, skippedOversize } = buildCandidates(repo, tree.paths, explicitPaths);

  const slice = ids.slice(cursor, cursor + limit);
  let deleted = 0;
  if (!dryRun) {
    for (let i = 0; i < slice.length; i += DELETE_BATCH_SIZE) {
      const batch = slice.slice(i, i + DELETE_BATCH_SIZE);
      await env.VECTORIZE.deleteByIds(batch);
      deleted += batch.length;
    }
  }

  const covered = Math.min(cursor + slice.length, ids.length);
  const remaining = Math.max(ids.length - covered, 0);
  const done = remaining === 0;

  console.log(
    `${repo} purge-legacy(doc): candidates=${ids.length} cursor=${cursor} ` +
      `targeted=${slice.length} deleted=${deleted} remaining=${remaining}` +
      `${dryRun ? " (dry run)" : ""}` +
      `${skippedOversize > 0 ? ` skipped_oversize=${skippedOversize}` : ""}` +
      `${tree.truncated ? " tree_truncated=true" : ""}`,
  );

  return {
    repo,
    surface: "doc",
    dryRun,
    candidates: ids.length,
    skippedOversize,
    treeTruncated: tree.truncated,
    cursor,
    limit,
    targeted: slice.length,
    deleted,
    remaining,
    nextCursor: done ? null : covered,
    done,
  };
}
