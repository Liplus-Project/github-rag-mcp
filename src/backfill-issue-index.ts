/**
 * Re-index the issues and pull requests the poller left out of the index.
 *
 * Layer = L4 Operations (index repair surface)
 *
 * The poller advanced its watermark past every item the per-run embedding budget
 * deferred, so those items were marked for retry and then never fetched again
 * (issue #210). Measured 2026-08-03, that left roughly 55% of the issue / PR
 * history of the indexed repositories absent from `search_docs`. The watermark
 * is fixed at the source (`nextIssueWatermark` in `./poller.ts`), but the fix
 * only stops the leak: an item already stranded is not re-fetched by the poller,
 * because its `updated_at` no longer moves. This module walks the gap directly.
 *
 * Coverage is measured against `search_docs`, the sparse retrieval surface — the
 * same axis the issue measured, and the one a missing row makes a search silently
 * incomplete on. Walking by *issue number* rather than by timestamp is what makes
 * the sweep resumable and complete: the number space is dense and bounded, so a
 * numeric cursor states exactly how far the sweep has reached, while a timestamp
 * cursor over the same set would reintroduce the ordering the defect exploited.
 *
 * Unlike `./backfill-issue-state.ts`, this repair does embed: a missing row has
 * no vector to re-upsert. The per-call budget is therefore a Workers AI budget
 * first, and the caller drives the sweep one batch at a time.
 */

import type { Env } from "./types.js";
import { processAndUpsertIssue, type GitHubIssueData } from "./pipeline.js";

/** Candidate numbers attempted per call, unless the caller lowers it. Each one
 *  costs a GitHub fetch plus (when present) an embed + Vectorize + D1 + store
 *  fan-out, ~5 of the invocation's 1000 subrequests. */
export const DEFAULT_INDEX_BACKFILL_LIMIT = 25;

/** Hard ceiling on the per-call candidate budget. 100 candidates x ~5 subrequests
 *  ≈ 500, half the per-invocation budget, and 100 embeds is twice the cron's own
 *  per-run Workers AI allowance. */
export const MAX_INDEX_BACKFILL_LIMIT = 100;

/** Issue numbers covered by one indexed-set query. */
const SCAN_CHUNK = 200;

/** Chunk queries per call. Bounds the scan on a repository whose gap sits far
 *  above the cursor: 25 x 200 = 5000 numbers examined before the call returns a
 *  cursor and lets the caller decide whether to continue. */
const MAX_SCAN_CHUNKS = 25;

export interface IssueIndexBackfillOptions {
  /** Report the gap without fetching from GitHub or writing anything. */
  dryRun?: boolean;
  /** Candidate numbers attempted (default `DEFAULT_INDEX_BACKFILL_LIMIT`).
   *  Ignored on a dry run, which spends no fetch budget. */
  limit?: number;
  /** Issue number to resume after (exclusive). */
  cursor?: number;
}

export interface IssueIndexBackfillSummary {
  repo: string;
  dryRun: boolean;
  cursor: number;
  limit: number;
  /** Highest issue / PR number GitHub reports for the repository. */
  maxNumber: number;
  /** Last number this call examined. */
  scannedTo: number;
  /** Numbers in the examined range with no `search_docs` issue / PR row. */
  candidates: number;
  /** Candidates this call fetched from GitHub. 0 on a dry run. */
  attempted: number;
  /** Candidates now on both retrieval surfaces. */
  indexed: number;
  /** Candidates GitHub does not have (deleted or transferred numbers). */
  absent: number;
  /** Candidates whose embed or upsert failed; retried by a later call. */
  failed: number;
  /** Pass back as `cursor` to continue; `null` once the sweep reached `maxNumber`. */
  nextCursor: number | null;
  done: boolean;
}

const GITHUB_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "github-rag-mcp/0.1.0",
});

/**
 * Highest issue / PR number the repository has.
 *
 * Issues and pull requests share one ascending sequence, so the most recently
 * *created* item carries the highest number — one listing entry answers it.
 * Returns 0 for a repository with no issues and no pull requests.
 */
export async function fetchHighestItemNumber(
  repo: string,
  token: string,
): Promise<number> {
  const url = new URL(`https://api.github.com/repos/${repo}/issues`);
  url.searchParams.set("state", "all");
  url.searchParams.set("sort", "created");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "1");

  const resp = await fetch(url.toString(), {
    headers: GITHUB_HEADERS(token),
    cache: "no-store",
  } as RequestInit);

  if (!resp.ok) {
    throw new Error(`GitHub API error ${resp.status}: ${await resp.text()}`);
  }

  const items = (await resp.json()) as Array<{ number: number }>;
  return items.length > 0 ? Number(items[0].number) : 0;
}

/** Issue / PR numbers of the repository's `search_docs` rows within `(from, to]`. */
export async function selectIndexedNumbers(
  db: D1Database,
  repo: string,
  from: number,
  to: number,
): Promise<Set<number>> {
  const res = await db
    .prepare(
      `SELECT DISTINCT number
         FROM search_docs
        WHERE repo = ?
          AND type IN ('issue', 'pull_request')
          AND number > ?
          AND number <= ?`,
    )
    .bind(repo, from, to)
    .all<{ number: number }>();

  return new Set((res.results ?? []).map((r) => Number(r.number)));
}

/** Fetch one issue / PR by number; `null` when GitHub does not have that number. */
async function fetchItem(
  repo: string,
  token: string,
  number: number,
): Promise<GitHubIssueData | null> {
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/issues/${number}`,
    { headers: GITHUB_HEADERS(token), cache: "no-store" } as RequestInit,
  );

  // A number the repository never had, or whose item was deleted. Not every
  // number in the range is an issue — the sequence also skips over items moved
  // out of the repository.
  if (resp.status === 404 || resp.status === 410) return null;

  if (!resp.ok) {
    throw new Error(
      `GitHub API error ${resp.status} for ${repo}#${number}: ${await resp.text()}`,
    );
  }

  return (await resp.json()) as GitHubIssueData;
}

/**
 * Index one batch of the repository's missing issue / PR numbers.
 *
 * Resumable and idempotent: progress is a number cursor over the ascending
 * number space, an item already carrying a `search_docs` row is never fetched,
 * and re-running a batch re-issues writes that are already correct. Call it
 * repeatedly with the returned `nextCursor` until `done`.
 *
 * The ingest is forced past the body-hash check. The hash answers "did the body
 * change", but every candidate here is known to be missing a retrieval surface,
 * which a matching hash would otherwise skip over permanently.
 */
export async function backfillIssueIndex(
  repo: string,
  env: Env,
  options: IssueIndexBackfillOptions = {},
): Promise<IssueIndexBackfillSummary> {
  const dryRun = options.dryRun === true;
  const limit = options.limit ?? DEFAULT_INDEX_BACKFILL_LIMIT;
  const cursor = options.cursor ?? 0;

  const maxNumber = await fetchHighestItemNumber(repo, env.GITHUB_TOKEN);

  // Collect candidates chunk by chunk. A dry run spends no fetch budget, so it
  // measures the whole scan range instead of stopping at `limit`.
  const candidates: number[] = [];
  let scannedTo = Math.min(cursor, maxNumber);
  for (let chunk = 0; chunk < MAX_SCAN_CHUNKS && scannedTo < maxNumber; chunk++) {
    const from = scannedTo;
    const to = Math.min(from + SCAN_CHUNK, maxNumber);
    const indexed = await selectIndexedNumbers(env.DB_FTS, repo, from, to);

    let stopAt: number | undefined;
    for (let n = from + 1; n <= to; n++) {
      if (indexed.has(n)) continue;
      candidates.push(n);
      if (!dryRun && candidates.length >= limit) {
        // The budget is spent on this number; everything above it is unexamined.
        stopAt = n;
        break;
      }
    }

    scannedTo = stopAt ?? to;
    if (stopAt !== undefined) break;
  }

  let attempted = 0;
  let indexed = 0;
  let absent = 0;
  let failed = 0;

  if (!dryRun) {
    const storeId = env.ISSUE_STORE.idFromName("global");
    const storeStub = env.ISSUE_STORE.get(storeId);

    for (const number of candidates) {
      attempted++;
      const item = await fetchItem(repo, env.GITHUB_TOKEN, number);
      if (item === null) {
        absent++;
        continue;
      }
      const result = await processAndUpsertIssue(env, storeStub, repo, item, {
        force: true,
      });
      if (result.embedded) indexed++;
      else failed++;
    }
  }

  const done = scannedTo >= maxNumber;

  console.log(
    `${repo} backfill-issue-index: max=${maxNumber} cursor=${cursor} ` +
      `scanned_to=${scannedTo} candidates=${candidates.length} attempted=${attempted} ` +
      `indexed=${indexed} absent=${absent} failed=${failed}${dryRun ? " (dry run)" : ""}`,
  );

  return {
    repo,
    dryRun,
    cursor,
    limit,
    maxNumber,
    scannedTo,
    candidates: candidates.length,
    attempted,
    indexed,
    absent,
    failed,
    nextCursor: done ? null : scannedTo,
    done,
  };
}
