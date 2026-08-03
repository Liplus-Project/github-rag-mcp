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
 * no vector to re-upsert, so every candidate carries the full ingest fan-out and
 * the caller drives the sweep one batch at a time. What that fan-out actually
 * costs per candidate is measured at `DEFAULT_INDEX_BACKFILL_LIMIT` below.
 */

import type { Env } from "./types.js";
import { processAndUpsertIssue, type GitHubIssueData } from "./pipeline.js";

/**
 * Per-candidate subrequest cost, measured rather than estimated.
 *
 * Observed in production on 2026-08-03 while sweeping issue #210, over 4
 * repositories and 48 calls:
 *
 *   - `limit=50` -> the *first* call of every repository fails outright with
 *     `Too many subrequests by single Worker invocation`
 *   - `limit=25` -> every one of the 48 calls reports `indexed=24 failed=1`.
 *     Exactly one, every time, across repositories — the budget runs out on the
 *     25th candidate, not on any property of the item
 *   - `limit=15` -> `failed=0` on all 8 calls
 *
 * The 24 / 25 boundary is what the cost is read off. With a 1000-subrequest
 * invocation budget, per-candidate cost `c`, and per-call fixed cost `O`
 * (`fetchHighestItemNumber` plus the scan-chunk D1 queries):
 *
 *   24c + O <= 1000 < 25c + O   =>   c ≈ 40  (39.2 .. 41.7 for O in 0..20)
 *
 * ~40 subrequests per candidate, against ~6 logical binding calls per candidate
 * in this module's code path (GitHub fetch 1 / store DO 2 / Workers AI 1 /
 * Vectorize 1 / D1 1). One logical call therefore does not equal one
 * subrequest here, and **which binding accounts for the difference is not
 * identified** — do not infer a mechanism from these numbers, only a budget.
 * `MAX_COMMENT_FETCHES_PER_REPO_PER_RUN` in `./poller.ts` carries the same
 * shape of correction, from `~3-5` down to a measured value.
 *
 * These figures cannot be re-measured: the #210 sweep took all 6 indexed
 * repositories to 100% coverage, so no candidates remain to consume budget.
 * Deleting rows to manufacture candidates is not an option. Any later revision
 * of these constants rests on the data above plus the unit tests, and the
 * cursor invariant below is what keeps correctness independent of their
 * accuracy.
 */

/** Candidate numbers attempted per call, unless the caller overrides it.
 *  15 is the largest value **measured** to complete with `failed=0`. */
export const DEFAULT_INDEX_BACKFILL_LIMIT = 15;

/** Hard ceiling on the per-call candidate budget. At c ≈ 40 the arithmetic
 *  ceiling is 1000 / 40 ≈ 24, so 20 keeps ~15% headroom under it. 20 is
 *  **arithmetic only — never measured**; 15 (the default above) is the measured
 *  value. The previous ceiling of 100 was unreachable: any call near it failed
 *  as a whole, which is the kind of limit that drops the next operator into the
 *  same hole. */
export const MAX_INDEX_BACKFILL_LIMIT = 20;

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
  /** Candidates whose embed or upsert failed. The cursor is held below the first
   *  of them, so the next call resumes on that exact number. */
  failed: number;
  /** Pass back as `cursor` to continue; `null` once the sweep reached `maxNumber`
   *  with every candidate ingested. Equal to the `cursor` that was passed in when
   *  the call's first candidate failed — the sweep is held, not finished. */
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
 * Cursor invariant, the same one the poller's watermark obeys (`nextIssueWatermark`
 * in `./poller.ts`, issue #210): **the cursor never advances past the first
 * candidate this call failed to ingest.** Candidates are walked in ascending
 * number order, so holding at the first failure covers every later one. Without
 * the hold, a candidate the subrequest budget cut off was overtaken by the cursor
 * and only a second sweep at a lower `limit` picked it up (issue #216) — which is
 * exactly what production needed on the #210 repair. With it, an over-generous
 * `limit` costs a wasted call, not a missed item: correctness stops depending on
 * how accurate `DEFAULT_INDEX_BACKFILL_LIMIT` is.
 *
 * A 404 (`absent`) does not hold the cursor. Those numbers are permanently gone
 * from GitHub, so holding on one would stall the sweep forever rather than
 * bounding a retry.
 *
 * The tradeoff is the poller's: a candidate that fails on every attempt stops the
 * sweep. Here it is visible rather than silent — `nextCursor` comes back equal to
 * the `cursor` that went in, with `failed >= 1` — and this endpoint is driven by a
 * human or an AI, not by cron. Pass `cursor = nextCursor + 1` to step over the
 * blocking number by hand.
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
  /** First candidate number this call did not get onto the retrieval surfaces. */
  let retryBoundary: number | undefined;

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
      if (result.embedded) {
        indexed++;
      } else {
        failed++;
        retryBoundary ??= number;
      }
    }
  }

  // Held one below the first uningested candidate so the next call reopens on it.
  // `retryBoundary - 1 >= cursor` always holds (every candidate is above `cursor`),
  // so the cursor cannot regress; equality is the stall signal.
  const nextCursor =
    retryBoundary !== undefined
      ? retryBoundary - 1
      : scannedTo >= maxNumber
        ? null
        : scannedTo;
  const done = nextCursor === null;

  console.log(
    `${repo} backfill-issue-index: max=${maxNumber} cursor=${cursor} ` +
      `scanned_to=${scannedTo} candidates=${candidates.length} attempted=${attempted} ` +
      `indexed=${indexed} absent=${absent} failed=${failed}` +
      `${retryBoundary !== undefined ? ` (held before #${retryBoundary})` : ""}` +
      `${dryRun ? " (dry run)" : ""}`,
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
    nextCursor,
    done,
  };
}
