/**
 * Reconcile the indexed `state` of issue / PR rows that were indexed while open
 * and never followed the item to `closed`.
 *
 * Layer = L4 Operations (index repair surface)
 *
 * The metadata-only path in `./pipeline/embed-issue.ts` is what carries a state
 * change onto the retrieval surfaces. It used to advance its own diff baseline
 * (the IssueStore record) before the mirror writes it guards, so a mirror write
 * that failed was never retried: the next poll compared GitHub against an
 * already-updated baseline and saw nothing to do. A body change would have
 * reconciled it, but a state-only change never brings one, so the rows stayed
 * `open` permanently (issue #209). The ordering is fixed at the source; this
 * module repairs the rows the old ordering left behind.
 *
 * No embedding is involved, so the repair is free of Workers AI cost:
 *  - the true state comes from one paginated `state=open` listing per repo;
 *  - the sparse side is a plain `UPDATE search_docs SET state = 'closed'`;
 *  - the dense side re-upserts the existing vector values fetched via
 *    `getByIds`, with only the `state` field of the metadata replaced.
 *
 * Direction is deliberately one-way (`open` -> `closed`). That is the direction
 * the defect produced and the direction that harms retrieval: a closed decision
 * resurfacing as a live one. Rows whose stored state is already `closed` are not
 * examined, which also keeps the scan proportional to the (small) open set
 * rather than to the whole index.
 *
 * Rows with no vector in Vectorize are counted and left to issue #210 (missing
 * index entries); their sparse state is still repaired, since that half exists.
 */

import type { Env } from "./types.js";

/** Rows examined per call, unless the caller lowers it. */
export const DEFAULT_ISSUE_STATE_LIMIT = 200;

/** Hard ceiling on the per-call row budget a caller may request. */
export const MAX_ISSUE_STATE_LIMIT = 1000;

/** Vector IDs per `getByIds` / `upsert` call.
 *
 *  Set by the *smaller* of the two caps this loop touches: `getByIds` rejects more
 *  than 20 IDs per call (`VECTOR_GET_ERROR (code = 40007): too many ids in payload;
 *  max id count is 20`), while the 1000-vector batch cap applies to `upsert`. One
 *  constant serves both calls, so it has to satisfy the tighter one — a repo with
 *  more than 20 stale rows failed on its first `getByIds` batch otherwise (#213). */
const VECTOR_BATCH_SIZE = 20;

/** Items per page of the GitHub open-item listing. */
const OPEN_LIST_PER_PAGE = 100;

/** Page cap on the open-item listing. The listing MUST be complete: a truncated
 *  open set would report live items as absent and close them. At 100 per page this
 *  allows 5000 open items, and the walk throws rather than guess past it. */
const MAX_OPEN_LIST_PAGES = 50;

export interface IssueStateBackfillOptions {
  /** Report what would change without writing to D1 or Vectorize. */
  dryRun?: boolean;
  /** Rows examined in this call (default `DEFAULT_ISSUE_STATE_LIMIT`). */
  limit?: number;
  /** Issue number to resume after (exclusive). */
  cursor?: number;
}

export interface IssueStateBackfillSummary {
  repo: string;
  dryRun: boolean;
  /** Issues + PRs GitHub currently reports as open. */
  openOnGitHub: number;
  cursor: number;
  limit: number;
  /** `state = 'open'` issue / PR rows examined in this call. */
  scanned: number;
  /** Examined rows GitHub no longer lists as open. */
  stale: number;
  /** Stale rows whose `search_docs.state` was set to `closed`. 0 on a dry run. */
  ftsUpdated: number;
  /** Stale rows whose Vectorize metadata was re-upserted. 0 on a dry run. */
  vectorsUpdated: number;
  /** Stale rows with no vector to refresh (issue #210 surface). */
  vectorsMissing: number;
  /** Pass back as `cursor` to continue; `null` once the scan is exhausted. */
  nextCursor: number | null;
  done: boolean;
}

/** One `state = 'open'` issue / PR row of the sparse index. */
export interface OpenRow {
  vectorId: string;
  number: number;
}

/**
 * One ordered page of the repo's `state = 'open'` issue / PR rows, resuming after
 * issue number `cursor`. Ordering by number is what makes the cursor resumable.
 */
export async function selectIndexedOpenRows(
  db: D1Database,
  repo: string,
  cursor: number,
  limit: number,
): Promise<OpenRow[]> {
  const res = await db
    .prepare(
      `SELECT vector_id, number
         FROM search_docs
        WHERE repo = ?
          AND type IN ('issue', 'pull_request')
          AND state = 'open'
          AND number > ?
        ORDER BY number
        LIMIT ?`,
    )
    .bind(repo, cursor, limit)
    .all<{ vector_id: string; number: number }>();

  return (res.results ?? []).map((r) => ({
    vectorId: String(r.vector_id ?? ""),
    number: Number(r.number ?? 0),
  }));
}

/**
 * Flip the given rows to `closed`.
 *
 * Batched statements rather than one bulk UPDATE: the `search_docs` UPDATE trigger
 * re-syncs the FTS5 index per row, and a single statement spanning the whole window
 * would fire it for every row at once. `content` / `content_fts` are untouched, so
 * the trigger's delete-then-reinsert replays the exact text the index holds.
 */
export async function markRowsClosed(
  db: D1Database,
  vectorIds: string[],
): Promise<void> {
  if (vectorIds.length === 0) return;
  const update = db.prepare(
    `UPDATE search_docs SET state = 'closed' WHERE vector_id = ?`,
  );
  await db.batch(vectorIds.map((id) => update.bind(id)));
}

/**
 * Every issue / PR number GitHub currently reports as open for a repo.
 *
 * `/issues` returns pull requests as well, so one listing covers both indexed
 * types. Throws when the walk would exceed `MAX_OPEN_LIST_PAGES`: a partial open
 * set is worse than no answer, because absence from it is what marks a row closed.
 */
export async function fetchOpenItemNumbers(
  repo: string,
  token: string,
): Promise<Set<number>> {
  const open = new Set<number>();

  for (let page = 1; page <= MAX_OPEN_LIST_PAGES; page++) {
    const url = new URL(`https://api.github.com/repos/${repo}/issues`);
    url.searchParams.set("state", "open");
    url.searchParams.set("per_page", String(OPEN_LIST_PER_PAGE));
    url.searchParams.set("page", String(page));

    const resp = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-rag-mcp/0.1.0",
      },
      cache: "no-store",
    } as RequestInit);

    if (!resp.ok) {
      throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
    }

    const items = (await resp.json()) as Array<{ number: number }>;
    for (const item of items) open.add(item.number);

    if (items.length < OPEN_LIST_PER_PAGE) return open;
  }

  throw new Error(
    `open-item listing for ${repo} exceeded ${MAX_OPEN_LIST_PAGES} pages — ` +
      `refusing to close rows against a partial open set`,
  );
}

/**
 * Repair one batch of stale `open` rows for a repo.
 *
 * Resumable and idempotent: progress is an issue-number cursor over the ordered
 * `state = 'open'` rows, a row that is genuinely open is skipped without a write,
 * and re-running a batch re-issues writes that are already correct. Vectorize is
 * updated before D1 on purpose — when the dense write throws, the sparse rows are
 * still `open`, so the same window is re-covered on the next call instead of
 * leaving the two sides split.
 */
export async function backfillIssueState(
  repo: string,
  env: Env,
  options: IssueStateBackfillOptions = {},
): Promise<IssueStateBackfillSummary> {
  const dryRun = options.dryRun === true;
  const limit = options.limit ?? DEFAULT_ISSUE_STATE_LIMIT;
  const cursor = options.cursor ?? 0;

  const openNumbers = await fetchOpenItemNumbers(repo, env.GITHUB_TOKEN);

  const rows = await selectIndexedOpenRows(env.DB_FTS, repo, cursor, limit);
  const stale = rows.filter((r) => !openNumbers.has(r.number));

  let vectorsUpdated = 0;
  let vectorsMissing = 0;
  let ftsUpdated = 0;

  if (!dryRun && stale.length > 0) {
    // Dense side: keep the existing values, replace only `state` in the metadata.
    for (let i = 0; i < stale.length; i += VECTOR_BATCH_SIZE) {
      const batch = stale.slice(i, i + VECTOR_BATCH_SIZE);
      const found = await env.VECTORIZE.getByIds(batch.map((r) => r.vectorId));
      const byId = new Map(found.map((v) => [v.id, v]));

      const refreshed: VectorizeVector[] = [];
      for (const row of batch) {
        const vector = byId.get(row.vectorId);
        if (!vector || !vector.values) {
          vectorsMissing++;
          continue;
        }
        refreshed.push({
          id: row.vectorId,
          values: vector.values as number[],
          metadata: { ...(vector.metadata ?? {}), state: "closed" },
        });
      }

      if (refreshed.length > 0) {
        await env.VECTORIZE.upsert(refreshed);
        vectorsUpdated += refreshed.length;
      }
    }

    // Sparse side.
    await markRowsClosed(env.DB_FTS, stale.map((r) => r.vectorId));
    ftsUpdated = stale.length;
  }

  // A short page means the scan reached the end of the open rows for this repo.
  const done = rows.length < limit;
  const nextCursor = done ? null : rows[rows.length - 1].number;

  console.log(
    `${repo} backfill-issue-state: open_on_github=${openNumbers.size} cursor=${cursor} ` +
      `scanned=${rows.length} stale=${stale.length} fts_updated=${ftsUpdated} ` +
      `vectors_updated=${vectorsUpdated} vectors_missing=${vectorsMissing}` +
      `${dryRun ? " (dry run)" : ""}`,
  );

  return {
    repo,
    dryRun,
    openOnGitHub: openNumbers.size,
    cursor,
    limit,
    scanned: rows.length,
    stale: stale.length,
    ftsUpdated,
    vectorsUpdated,
    vectorsMissing,
    nextCursor,
    done,
  };
}
