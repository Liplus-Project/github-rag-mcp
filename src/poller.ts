/**
 * Cron Poller — scheduled handler for GitHub issue/PR polling and embedding pipeline.
 *
 * Runs hourly as a fallback sync (primary updates arrive via webhook).
 * Fetches issue/PR updates from GitHub API using `since` parameter for incremental updates.
 * Generates embeddings via Workers AI BGE-M3 and upserts into Vectorize.
 * Stores structured metadata in IssueStore Durable Object.
 */

import type {
  Env,
  IssueRecord,
  ReleaseRecord,
  DocRecord,
  WikiDocRecord,
} from "./types.js";
import {
  docVectorId,
  wikiDocVectorId,
  processAndUpsertIssue,
  processAndUpsertRelease,
  processAndUpsertDoc,
  processAndUpsertWikiDoc,
  processAndUpsertCommitDiff,
  fetchCommitDetail,
  ingestIssueComment,
  ingestPRReview,
  ingestPRReviewComment,
  sha256Hex,
  type GitHubIssueData,
  type GitHubReleaseData,
  type GitHubCommentData,
  type GitHubPRReviewData,
  type GitHubPRReviewCommentData,
} from "./pipeline.js";
import { deleteFtsRow } from "./fts.js";
import { deleteEdgesForVector } from "./graph.js";

/** GitHub API page size */
const PER_PAGE = 100;

/** Maximum number of embeddings to generate per single cron run.
 *  Prevents Workers AI rate-limit errors on large repos.
 *  Remaining issues are stored with empty bodyHash and retried next cron. */
const MAX_EMBEDDINGS_PER_RUN = 50;

/** Maximum number of API pages to fetch per single cron run.
 *  Prevents Cloudflare Worker CPU time limit on large repos (e.g. 900+ issues initial sync).
 *  At PER_PAGE=100, this caps a single run at 200 issues.
 *  When capped, the watermark is set to the last fetched issue's updated_at
 *  so the next cron continues from where it left off. */
const MAX_PAGES_PER_RUN = 2;

/** Maximum number of recent parent issues/PRs to fan out comment backfill over per repo.
 *  Keeps the API fan-out bounded on large, active repos so a single cron run
 *  does not exhaust the rate budget. Older parents are left to the next cron. */
const MAX_COMMENT_BACKFILL_PARENTS = 20;

/** Maximum number of comment-level items embedded per repo per run.
 *  Workers AI embed calls are the dominant cost for the comment surface. */
const MAX_COMMENTS_EMBEDDED_PER_REPO = 30;

/** Maximum number of GitHub API *fetches* the comment poller issues per repo
 *  per cron run. Distinct from MAX_COMMENTS_EMBEDDED_PER_REPO because each
 *  parent fans out to up to 3 endpoints (issue comments + PR reviews + PR
 *  review comments) and every fetch consumes 1 of the Worker's
 *  1000-subrequest-per-invocation budget — even on parents whose comments are
 *  unchanged and embed-skipped. With MAX_COMMENT_BACKFILL_PARENTS = 20 the
 *  worst-case fan-out is 60 fetches per repo, which combined with diff / wiki
 *  / issue pollers exhausts the budget on busy repos (issue #134, observed on
 *  Liplus-Project/dipper_ai). Capping fetches keeps the comment surface's
 *  worst-case bounded; remaining parents are picked up on the next cron.
 *
 *  Numeric history (issue #134):
 *    - PR #136 (merged 2026-04-27) introduced this cap at 30 as the initial
 *      defense.
 *    - 2026-04-28T15:15 UTC :15 cron observation (post-redeploy +33min): all
 *      5 polled repos still hit `fetches_issued=30/30, fetch_failures=30,
 *      Too many subrequests`. The cap fires (warn `pollComments: fetch budget
 *      reached`), but the 1000-subrequest-per-invocation budget is exhausted
 *      before fetches reach 30. Each fetch carries multi-subrequest overhead
 *      (Vectorize embed + D1 FTS upsert + Workers AI + Store DO calls), so
 *      5 repos × 30 fetches × ~3-5 subrequests easily blows past 1000.
 *    - Lowered to 10: worst-case 5 × 10 = 50 fetches × ~5 subrequests ≈ 250,
 *      leaving headroom for per-parent overhead and other pollers. */
const MAX_COMMENT_FETCHES_PER_REPO_PER_RUN = 10;

/** Maximum number of doc-file content fetches the docs poller issues per repo
 *  per cron run. Each changed `.md` entry triggers `fetchFileContent` (1 GitHub
 *  Contents API subrequest) followed by `processAndUpsertDoc` (~3-4 internal
 *  subrequests: Workers AI embed + Vectorize upsert + D1 FTS upsert + Store DO
 *  call), so a single doc fan-out is ~5 subrequests. Without this cap a repo
 *  with many changed `.md` files could consume ~250 subrequests on its own
 *  (50 × 5), and the LIGHT_CRON dispatch bundles 3 surfaces × 5 repos in one
 *  Worker invocation that shares a single 1000-subrequest budget — easily
 *  exhausted (issue #149).
 *
 *  Numeric design (issue #149, mirrors PR #144 / issue #134):
 *    - LIGHT_CRON worst-case = 5 repos × 3 surfaces × per-item fan-out.
 *    - Target headroom ≤ 800 subrequests (200 reserved for parent cron, error
 *      retries, store watermark writes).
 *    - 800 / 5 repos / 3 surfaces ≈ 53 subrequests / surface / repo.
 *    - 53 / ~5 subrequests-per-item ≈ 10 items.
 *    - Cap = 10. Worst-case 5 × 10 × 5 = 250 subrequests for the docs surface
 *      across all repos, well under the per-surface envelope.
 *  Remaining changed docs are picked up on the next cron run (blob SHA stays
 *  unchanged in the store until the doc is successfully upserted). */
const MAX_DOC_FETCHES_PER_REPO_PER_RUN = 10;

/** Maximum docs reaped (Vectorize + FTS5 + store row) per repo per cron run.
 *  Mirrors `MAX_WIKI_DELETIONS_PER_REPO_PER_RUN`: each reap fans out to 3
 *  subrequests, so an unbounded loop over a mass deletion could exhaust the
 *  LIGHT_CRON invocation budget on its own and starve every repo behind it —
 *  docs share that invocation with `pollRepo` and `pollReleases` (issue #203).
 *  A real case: github-webhook-mcp deleted 66 `.md` files in one PR, all of
 *  which land on the next single run.
 *
 *  Numeric design: 5 deletes x 3 subrequests x 5 repos = 75 subrequests for the
 *  reap, on top of the ~250 the docs fetch cap already allows. Together with
 *  pollRepo and pollReleases the LIGHT_CRON worst case stays around 825, inside
 *  the 1000 ceiling.
 *
 *  Remaining deletions are reaped next run: a reaped doc's store row is gone, so
 *  the leftover set only shrinks and the drain is monotonic. The tree ETag is
 *  deliberately *not* advanced while deletions are outstanding — the next run
 *  would otherwise short-circuit on 304 and never see them (same hold as the
 *  fetch cap, see the watermark write below). */
const MAX_DOC_DELETIONS_PER_REPO_PER_RUN = 5;

/** Maximum number of release records the releases poller upserts per repo per
 *  cron run. The GitHub Releases endpoint returns all recent releases in a
 *  single API call, so the GH-side fetch cost is fixed at 1, but each release
 *  upsert fans out through `processAndUpsertRelease` to ~4 internal
 *  subrequests (Workers AI embed + Vectorize upsert + D1 FTS upsert + Store DO
 *  call). Active repos with many releases blew the LIGHT_CRON 1000-subrequest
 *  budget when combined with pollDocs and pollRepo (issue #149).
 *
 *  Numeric design (issue #149, mirrors PR #144 / issue #134):
 *    - Same envelope as `MAX_DOC_FETCHES_PER_REPO_PER_RUN`: 10 items × ~5
 *      subrequests × 5 repos ≈ 250 subrequests for the releases surface.
 *    - Together with the docs cap (250) and pollRepo's existing
 *      `MAX_EMBEDDINGS_PER_RUN=50` × ~5 ≈ 250, the LIGHT_CRON worst case stays
 *      around 750 subrequests, well under the 1000 ceiling.
 *  Remaining releases are stored with empty bodyHash so the next cron run
 *  retries them (existing pattern in `pollReleases`). */
const MAX_RELEASE_UPSERTS_PER_REPO_PER_RUN = 10;

/** Maximum number of commits fetched in the forward (webhook-redundancy) phase
 *  of the diff poller per repo per run.
 *  Forward is normally a no-op because the webhook path already indexes new
 *  commits; this cap bounds the work when webhook delivery has stalled.
 *  Sized so that (forward + backward) × per-commit fan-out stays well under the
 *  Cloudflare Workers per-invocation subrequest limit (issue #124). */
const MAX_DIFF_COMMITS_FORWARD_PER_RUN = 5;

/** Maximum number of commits fetched in the backward (historical backfill) phase
 *  of the diff poller per repo per run.
 *  Backfill walks backward through repo history one hourly run at a time; the
 *  cap keeps per-run API and embedding cost bounded so the total sweep spreads
 *  over many runs (e.g. 5 commits/run × 24 runs/day = 120 commits/day per repo). */
const MAX_DIFF_COMMITS_BACKWARD_PER_RUN = 5;

/** Page size used when the forward diff phase enumerates its commit window.
 *  Listing is 1 subrequest regardless of page size, while the per-commit
 *  fan-out (detail fetch + embed + Vectorize + D1 + Store DO) is what the
 *  MAX_DIFF_COMMITS_FORWARD_PER_RUN cap bounds. Enumerating the whole window
 *  cheaply is what lets the poller pick the *oldest* unprocessed commits
 *  instead of the newest ones GitHub returns first (issue #178). */
const DIFF_FORWARD_LIST_PER_PAGE = 100;

/** Maximum number of times the forward diff window is halved when a single list
 *  page cannot enumerate it. A full page means the window may hold more commits
 *  than we can see, so the oldest end is unknown and the watermark must not
 *  advance. Halving self-adapts: an idle period is enumerated by the first call
 *  and traversed in one run, while a dense period converges in a few extra list
 *  calls (1 subrequest each, worst case 9 for the phase — negligible against the
 *  1000-per-invocation budget the per-commit fan-out actually spends).
 *
 *  Sized against the deepest expected rewind: `POST /admin/diff-watermark` may
 *  set the watermark weeks back to replay a gap, and 8 halvings narrow a 3-week
 *  window to ~2 hours, so enumeration only fails if a repo lands 100+ commits in
 *  2 hours. When even the smallest window overflows, the run holds the watermark
 *  and logs — a visible stall is preferred over a silent gap (issue #178). */
const MAX_DIFF_FORWARD_WINDOW_SHRINKS = 8;

/** Safety margin subtracted from a retry boundary when the forward diff
 *  watermark is pinned to an unprocessed commit's date. GitHub's `since` filter
 *  is documented as "commits after this date"; without the margin a commit whose
 *  timestamp equals the watermark could be excluded from the retry window, and
 *  commits sharing a timestamp are common in squash-merge workflows. The margin
 *  costs at most a bounded re-ingest of already-successful commits, which is
 *  idempotent on (repo, commit_sha, file_path). */
const DIFF_RETRY_BOUNDARY_BACKOFF_MS = 1000;

/** Sentinel value indicating GitHub returned 304 Not Modified */
const NOT_MODIFIED = Symbol("NOT_MODIFIED");

/**
 * Fetch a single page of issues from GitHub API.
 * Returns the issues array and a flag indicating whether more pages exist,
 * plus the ETag header from the response for conditional request support.
 *
 * When `etag` is provided (page 1 only), sends `If-None-Match` header.
 * If GitHub responds 304 Not Modified, returns NOT_MODIFIED sentinel.
 */
async function fetchIssuePage(
  repo: string,
  token: string,
  opts: { since?: string; page: number; state?: string; etag?: string },
): Promise<{ issues: GitHubIssueData[]; hasMore: boolean; etag?: string } | typeof NOT_MODIFIED> {
  const url = new URL(`https://api.github.com/repos/${repo}/issues`);
  url.searchParams.set("state", opts.state ?? "all");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(opts.page));
  if (opts.since) {
    url.searchParams.set("since", opts.since);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-rag-mcp/0.1.0",
  };

  // Send conditional request header for page 1 when ETag is available
  if (opts.etag) {
    headers["If-None-Match"] = opts.etag;
  }

  // Bypass Cloudflare cache layer to ensure If-None-Match reaches GitHub origin.
  // Workers fetch() supports standard `cache` option at runtime even though
  // @cloudflare/workers-types omits it from RequestInit. Type assertion required.
  const resp = await fetch(url.toString(), {
    headers,
    cache: "no-store",
  } as RequestInit);

  // 304 Not Modified — no changes since last poll
  if (resp.status === 304) {
    return NOT_MODIFIED;
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API error ${resp.status}: ${text}`);
  }

  const issues = (await resp.json()) as GitHubIssueData[];
  const hasMore = issues.length === PER_PAGE;
  const responseEtag = resp.headers.get("etag") ?? undefined;
  return { issues, hasMore, etag: responseEtag };
}

/**
 * Fetch issues (with pagination) from GitHub API since a given timestamp.
 * When maxPages is provided, stops after that many pages to stay within
 * Cloudflare Worker CPU time limits. Returns a `capped` flag indicating
 * whether pagination was truncated before exhausting all results.
 *
 * When `etag` is provided, page 1 uses a conditional request. If GitHub
 * returns 304 Not Modified, `notModified` is true and issues array is empty.
 * The response ETag from page 1 is returned in `responseEtag` for storage.
 */
async function fetchAllIssues(
  repo: string,
  token: string,
  since?: string,
  maxPages?: number,
  etag?: string,
): Promise<{ issues: GitHubIssueData[]; capped: boolean; notModified: boolean; responseEtag?: string }> {
  const allIssues: GitHubIssueData[] = [];
  let page = 1;
  let responseEtag: string | undefined;

  while (true) {
    // Send ETag only for page 1
    const result = await fetchIssuePage(repo, token, {
      since,
      page,
      etag: page === 1 ? etag : undefined,
    });

    // 304 Not Modified on page 1 — no changes
    if (result === NOT_MODIFIED) {
      return { issues: [], capped: false, notModified: true };
    }

    const { issues, hasMore, etag: pageEtag } = result;
    allIssues.push(...issues);

    // Capture ETag from page 1 response
    if (page === 1) {
      responseEtag = pageEtag;
    }

    if (!hasMore) break;
    page++;

    // Stop if we've reached the per-run page cap
    if (maxPages && page > maxPages) {
      console.warn(
        `Pagination capped at ${maxPages} pages (${allIssues.length} issues) for ${repo}. ` +
        `Remaining issues will be fetched in subsequent cron runs.`,
      );
      return { issues: allIssues, capped: true, notModified: false, responseEtag };
    }

    // Safety: absolute cap to prevent runaway loops
    if (page > 50) {
      console.warn(`Absolute pagination cap reached for ${repo} at page ${page}`);
      return { issues: allIssues, capped: true, notModified: false, responseEtag };
    }
  }

  return { issues: allIssues, capped: false, notModified: false, responseEtag };
}

/**
 * Process a batch of issues: compute hashes, generate embeddings for changed items,
 * upsert into Vectorize and IssueStore.
 *
 * Delegates per-item embedding+upsert to the shared pipeline, but manages
 * batch-level concerns: embedding count cap and stats tracking.
 */
async function processIssues(
  issues: GitHubIssueData[],
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<{ processed: number; embedded: number; skipped: number; failed: number }> {
  let processed = 0;
  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const issue of issues) {
    // Enforce per-run embedding limit to avoid Workers AI rate limits.
    // When the limit is reached, store with empty bodyHash so next poll retries.
    if (embedded >= MAX_EMBEDDINGS_PER_RUN) {
      if (embedded === MAX_EMBEDDINGS_PER_RUN) {
        console.warn(
          `Embedding batch limit reached (${MAX_EMBEDDINGS_PER_RUN}). ` +
          `Remaining issues will be retried next cron run.`,
        );
      }
      // Store record with empty bodyHash to trigger retry on next poll
      const body = issue.body ?? "";
      const type: IssueRecord["type"] = issue.pull_request
        ? "pull_request"
        : "issue";
      const record: IssueRecord = {
        repo,
        number: issue.number,
        type,
        state: issue.state,
        title: issue.title,
        labels: issue.labels.map((l) => l.name),
        milestone: issue.milestone?.title ?? "",
        assignees: issue.assignees.map((a) => a.login),
        bodyHash: "",
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      };
      await storeStub.fetch(
        new Request("http://store/upsert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        }),
      );
      processed++;
      continue;
    }

    const result = await processAndUpsertIssue(env, storeStub, repo, issue);

    if (result.skippedUnchanged) {
      skipped++;
    } else if (result.embedded) {
      embedded++;
    } else if (result.failed) {
      failed++;
    }

    processed++;
  }

  return { processed, embedded, skipped, failed };
}

/**
 * Poll a single repository for issue/PR updates.
 */
async function pollRepo(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  // Get watermark (last poll timestamp + ETag)
  const wmResp = await storeStub.fetch(
    new Request(
      `http://store/watermark?repo=${encodeURIComponent(repo)}`,
    ),
  );

  let since: string | undefined;
  let storedEtag: string | undefined;
  if (wmResp.ok) {
    const wm = (await wmResp.json()) as { repo: string; lastPolledAt: string; etag?: string };
    since = wm.lastPolledAt;
    storedEtag = wm.etag;
  }

  console.log(
    `Polling ${repo}${since ? ` since ${since}` : " (initial sync)"}${storedEtag ? " (with ETag)" : ""}`,
  );

  // Record poll start time before fetching (to avoid missing updates during fetch)
  const pollStartTime = new Date().toISOString();

  // Fetch issues from GitHub API (with per-run page cap and conditional request)
  const { issues, capped, notModified, responseEtag } = await fetchAllIssues(
    repo,
    env.GITHUB_TOKEN,
    since,
    MAX_PAGES_PER_RUN,
    storedEtag,
  );

  // 304 Not Modified — no changes since last poll, skip watermark update too
  if (notModified) {
    console.log(`${repo}: 304 Not Modified — no changes`);
    return;
  }

  if (issues.length === 0) {
    console.log(`No updates for ${repo}`);
    // Still update watermark to move forward (preserve new ETag if available)
    await storeStub.fetch(
      new Request("http://store/watermark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, lastPolledAt: pollStartTime, etag: responseEtag }),
      }),
    );
    return;
  }

  // Process issues (embedding + store)
  const stats = await processIssues(issues, repo, env, storeStub);

  // Watermark strategy:
  // - If all pages were fetched (not capped): use pollStartTime so next run
  //   picks up anything updated during this fetch.
  // - If pagination was capped: use the updated_at of the last fetched issue
  //   (sorted by updated asc) so the next cron continues from where we left off.
  //   Using pollStartTime here would skip the remaining unfetched issues.
  let nextWatermark: string;
  if (capped) {
    const lastIssue = issues[issues.length - 1];
    nextWatermark = lastIssue.updated_at;
    console.log(
      `${repo}: pagination was capped — watermark set to last fetched issue updated_at: ${nextWatermark}`,
    );
  } else {
    nextWatermark = pollStartTime;
  }

  // Update watermark after successful processing (with new ETag for next conditional request)
  // When pagination is capped, don't store ETag — the partial fetch means the ETag
  // wouldn't match the next request which starts from a different watermark position.
  await storeStub.fetch(
    new Request("http://store/watermark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo,
        lastPolledAt: nextWatermark,
        etag: capped ? undefined : responseEtag,
      }),
    }),
  );

  console.log(
    `${repo}: ${stats.processed} processed, ${stats.embedded} embedded, ${stats.skipped} unchanged, ${stats.failed} failed`,
  );
}

// ── Release Polling ────────────────────────────────────────

/**
 * Fetch releases from GitHub API with ETag conditional request support.
 * Returns the releases array and the response ETag.
 * When `etag` is provided, sends `If-None-Match` header.
 * If GitHub responds 304 Not Modified, returns NOT_MODIFIED sentinel.
 */
async function fetchReleases(
  repo: string,
  token: string,
  etag?: string,
): Promise<{ releases: GitHubReleaseData[]; etag?: string } | typeof NOT_MODIFIED> {
  const url = new URL(`https://api.github.com/repos/${repo}/releases`);
  url.searchParams.set("per_page", "100");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-rag-mcp/0.1.0",
  };

  if (etag) {
    headers["If-None-Match"] = etag;
  }

  const resp = await fetch(url.toString(), {
    headers,
    cache: "no-store",
  } as RequestInit);

  if (resp.status === 304) {
    return NOT_MODIFIED;
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub Releases API error ${resp.status}: ${text}`);
  }

  const releases = (await resp.json()) as GitHubReleaseData[];
  const responseEtag = resp.headers.get("etag") ?? undefined;
  return { releases, etag: responseEtag };
}

/**
 * Poll a single repository for release updates.
 */
async function pollReleases(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  // Use a separate watermark namespace for releases
  const watermarkKey = `releases:${repo}`;
  const wmResp = await storeStub.fetch(
    new Request(
      `http://store/watermark?repo=${encodeURIComponent(watermarkKey)}`,
    ),
  );

  let storedEtag: string | undefined;
  if (wmResp.ok) {
    const wm = (await wmResp.json()) as { repo: string; lastPolledAt: string; etag?: string };
    storedEtag = wm.etag;
  }

  console.log(
    `Polling releases for ${repo}${storedEtag ? " (with ETag)" : ""}`,
  );

  const result = await fetchReleases(repo, env.GITHUB_TOKEN, storedEtag);

  if (result === NOT_MODIFIED) {
    console.log(`${repo} releases: 304 Not Modified — no changes`);
    return;
  }

  const { releases, etag: responseEtag } = result;

  if (releases.length === 0) {
    console.log(`No releases for ${repo}`);
    // Update watermark with new ETag
    await storeStub.fetch(
      new Request("http://store/watermark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: watermarkKey, lastPolledAt: new Date().toISOString(), etag: responseEtag }),
      }),
    );
    return;
  }

  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  let upsertsIssued = 0;
  let upsertBudgetExhausted = false;

  for (const release of releases) {
    // Enforce per-run upsert fan-out cap to keep the LIGHT_CRON Worker
    // invocation under its 1000-subrequest budget (issue #149). This sits
    // ahead of the embedding cap because each upsert call (even for an
    // unchanged release that ends up skipped) still consumes Store DO
    // subrequests during change detection.
    if (upsertsIssued >= MAX_RELEASE_UPSERTS_PER_REPO_PER_RUN) {
      if (!upsertBudgetExhausted) {
        upsertBudgetExhausted = true;
        console.warn(
          `pollReleases: upsert budget reached for ${repo} ` +
            `(${MAX_RELEASE_UPSERTS_PER_REPO_PER_RUN} releases). ` +
            `Remaining releases will be retried next cron run.`,
        );
      }
      // Store record with empty bodyHash to trigger retry on next poll
      const name = release.name ?? release.tag_name;
      const record: ReleaseRecord = {
        repo,
        tagName: release.tag_name,
        name,
        body: release.body ?? "",
        prerelease: release.prerelease,
        bodyHash: "",
        createdAt: release.created_at,
        publishedAt: release.published_at ?? release.created_at,
      };
      await storeStub.fetch(
        new Request("http://store/upsert-release", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        }),
      );
      continue;
    }

    // Enforce per-run embedding limit
    if (embedded >= MAX_EMBEDDINGS_PER_RUN) {
      if (embedded === MAX_EMBEDDINGS_PER_RUN) {
        console.warn(
          `Release embedding batch limit reached (${MAX_EMBEDDINGS_PER_RUN}). ` +
          `Remaining releases will be retried next cron run.`,
        );
      }
      // Store record with empty bodyHash to trigger retry on next poll
      const name = release.name ?? release.tag_name;
      const record: ReleaseRecord = {
        repo,
        tagName: release.tag_name,
        name,
        body: release.body ?? "",
        prerelease: release.prerelease,
        bodyHash: "",
        createdAt: release.created_at,
        publishedAt: release.published_at ?? release.created_at,
      };
      await storeStub.fetch(
        new Request("http://store/upsert-release", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        }),
      );
      continue;
    }

    upsertsIssued++;
    const result = await processAndUpsertRelease(env, storeStub, repo, release);

    if (result.skippedUnchanged) {
      skipped++;
    } else if (result.embedded) {
      embedded++;
    } else if (result.failed) {
      failed++;
    }
  }

  // Update watermark with ETag — but skip the ETag write when the run hit
  // the per-run upsert cap, otherwise the next cron will short-circuit on
  // 304 and never reprocess the deferred (empty-bodyHash) releases (issue
  // #149).
  if (!upsertBudgetExhausted) {
    await storeStub.fetch(
      new Request("http://store/watermark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: watermarkKey, lastPolledAt: new Date().toISOString(), etag: responseEtag }),
      }),
    );
  } else {
    await storeStub.fetch(
      new Request("http://store/watermark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: watermarkKey, lastPolledAt: new Date().toISOString(), etag: storedEtag }),
      }),
    );
  }

  console.log(
    `${repo} releases: ${releases.length} total, ${embedded} embedded, ${skipped} unchanged, ${failed} failed, ` +
      `upserts_issued=${upsertsIssued}/${MAX_RELEASE_UPSERTS_PER_REPO_PER_RUN}`,
  );
}

// ── Documentation Polling ────────────────────────────────────────

/** Entry in the Git Trees API response */
interface GitTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

/** Git Trees API response shape */
interface GitTreeResponse {
  sha: string;
  tree: GitTreeEntry[];
  truncated: boolean;
}

/** Pattern to match target documentation files — all .md files in the repository */
function isDocFile(path: string): boolean {
  return path.endsWith(".md");
}

/**
 * Fetch the repository tree via Git Trees API with ETag conditional request support.
 * Returns the tree entries and the response ETag.
 * When `etag` is provided, sends `If-None-Match` header.
 * If GitHub responds 304 Not Modified, returns NOT_MODIFIED sentinel.
 */
async function fetchRepoTree(
  repo: string,
  token: string,
  ref: string,
  etag?: string,
): Promise<
  | { tree: GitTreeEntry[]; treeSha: string; truncated: boolean; etag?: string }
  | typeof NOT_MODIFIED
> {
  const url = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-rag-mcp/0.1.0",
  };

  if (etag) {
    headers["If-None-Match"] = etag;
  }

  const resp = await fetch(url, {
    headers,
    cache: "no-store",
  } as RequestInit);

  if (resp.status === 304) {
    return NOT_MODIFIED;
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub Trees API error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as GitTreeResponse;
  const responseEtag = resp.headers.get("etag") ?? undefined;
  return {
    tree: data.tree,
    treeSha: data.sha,
    truncated: data.truncated === true,
    etag: responseEtag,
  };
}

/**
 * List every `.md` blob path in the repository's current tree.
 *
 * Same filter `pollDocs` indexes from, but unconditional: no ETag is sent, so the
 * call always returns a full listing instead of the 304 short-circuit the poller
 * relies on. `truncated` is passed through because the Trees API caps its
 * response — a truncated listing means the caller saw only part of the repo.
 *
 * Exported for the legacy-vector purge (issue #204), which needs exactly the path
 * set the doc indexer works from.
 */
export async function listRepoDocPaths(
  repo: string,
  token: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const result = await fetchRepoTree(repo, token, "HEAD");
  if (result === NOT_MODIFIED) {
    // Unreachable: 304 requires an If-None-Match, which this call never sends.
    throw new Error(`Trees API answered 304 without a conditional request for ${repo}`);
  }
  return {
    paths: result.tree
      .filter((entry) => entry.type === "blob" && isDocFile(entry.path))
      .map((entry) => entry.path),
    truncated: result.truncated,
  };
}

/**
 * Fetch file content via GitHub Contents API.
 * Returns the decoded UTF-8 text content.
 */
async function fetchFileContent(
  repo: string,
  path: string,
  token: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-rag-mcp/0.1.0",
  };

  const resp = await fetch(url, {
    headers,
    cache: "no-store",
  } as RequestInit);

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub Contents API error ${resp.status} for ${path}: ${text}`);
  }

  const data = (await resp.json()) as { content: string; encoding: string };
  if (data.encoding !== "base64") {
    throw new Error(`Unexpected encoding ${data.encoding} for ${path}`);
  }

  // Decode base64 content
  const binary = atob(data.content.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Poll a single repository for documentation file updates.
 * Uses Git Trees API for change detection and Contents API for fetching changed files.
 *
 * Files present in the store but absent from the current tree are reaped from
 * Vectorize, D1 FTS5, and the structured store — each surface independently,
 * capped per repo per run, with the tree ETag held back while a backlog remains
 * so the next run can still see it (issue #203).
 *
 * Exported for tests; production callers reach it through `handleScheduled`.
 */
export async function pollDocs(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  // Use a separate watermark namespace for docs
  const watermarkKey = `docs:${repo}`;
  const wmResp = await storeStub.fetch(
    new Request(
      `http://store/watermark?repo=${encodeURIComponent(watermarkKey)}`,
    ),
  );

  let storedEtag: string | undefined;
  if (wmResp.ok) {
    const wm = (await wmResp.json()) as { repo: string; lastPolledAt: string; etag?: string };
    storedEtag = wm.etag;
  }

  console.log(
    `Polling docs for ${repo}${storedEtag ? " (with ETag)" : ""}`,
  );

  // Fetch repo tree via Trees API with conditional request
  const result = await fetchRepoTree(repo, env.GITHUB_TOKEN, "HEAD", storedEtag);

  if (result === NOT_MODIFIED) {
    console.log(`${repo} docs: 304 Not Modified — no changes`);
    return;
  }

  const { tree, etag: responseEtag } = result;

  // Filter to doc files only
  const docEntries = tree.filter(
    (entry) => entry.type === "blob" && isDocFile(entry.path),
  );

  if (docEntries.length === 0) {
    console.log(`No doc files found in ${repo}`);
    // Still update watermark with new ETag
    await storeStub.fetch(
      new Request("http://store/watermark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: watermarkKey, lastPolledAt: new Date().toISOString(), etag: responseEtag }),
      }),
    );
    return;
  }

  // Get existing doc records to detect changes via blob SHA comparison
  const existingDocsResp = await storeStub.fetch(
    new Request(`http://store/docs?repo=${encodeURIComponent(repo)}`),
  );
  const existingDocs: DocRecord[] = existingDocsResp.ok
    ? (await existingDocsResp.json()) as DocRecord[]
    : [];
  const existingDocMap = new Map(existingDocs.map((d) => [d.path, d]));

  // Detect which files changed (blob SHA mismatch) or are new
  const changedEntries = docEntries.filter((entry) => {
    const existing = existingDocMap.get(entry.path);
    return !existing || existing.blobSha !== entry.sha;
  });

  // Detect deleted files (in store but not in current tree)
  const currentPaths = new Set(docEntries.map((e) => e.path));
  const deletedDocs = existingDocs.filter((d) => !currentPaths.has(d.path));

  let embedded = 0;
  let skipped = docEntries.length - changedEntries.length;
  let failed = 0;
  let fetchesIssued = 0;
  let fetchBudgetExhausted = false;
  const now = new Date().toISOString();

  // Process changed/new doc files
  for (const entry of changedEntries) {
    // Enforce per-run fetch fan-out cap to keep the LIGHT_CRON Worker
    // invocation under its 1000-subrequest budget (issue #149). Each loop
    // iteration costs ~5 subrequests (Contents API fetch + Workers AI embed +
    // Vectorize upsert + D1 FTS upsert + Store DO call), so unbounded loops
    // on repos with many changed `.md` files exhaust the budget shared with
    // pollRepo + pollReleases.
    if (fetchesIssued >= MAX_DOC_FETCHES_PER_REPO_PER_RUN) {
      if (!fetchBudgetExhausted) {
        fetchBudgetExhausted = true;
        console.warn(
          `pollDocs: fetch budget reached for ${repo} ` +
            `(${MAX_DOC_FETCHES_PER_REPO_PER_RUN} doc fetches). ` +
            `Remaining changed docs will be retried next cron run.`,
        );
      }
      // Stop processing — unchanged blobSha in store means next poll retries
      break;
    }

    if (embedded >= MAX_EMBEDDINGS_PER_RUN) {
      console.warn(
        `Doc embedding batch limit reached (${MAX_EMBEDDINGS_PER_RUN}). ` +
        `Remaining docs will be retried next cron run.`,
      );
      // Stop processing — unchanged blobSha in store means next poll retries
      break;
    }

    try {
      // Fetch file content
      fetchesIssued++;
      const content = await fetchFileContent(repo, entry.path, env.GITHUB_TOKEN);

      const result = await processAndUpsertDoc(env, storeStub, repo, entry.path, content, entry.sha);

      if (result.embedded) {
        embedded++;
      } else if (result.failed) {
        failed++;
      }
    } catch (err) {
      console.error(
        `Failed to embed doc ${repo}/${entry.path}:`,
        err instanceof Error ? err.message : String(err),
      );
      failed++;
    }
  }

  // Handle deleted files: remove from Vectorize, D1 FTS5, and the structured
  // store. No graph-edge teardown here, unlike the wiki reap: both endpoints of
  // every `doc_edges` row are wiki vector IDs (`indexWikiEdges` is the only
  // writer, and the dst ID it computes is a `wikiDocVectorId` too), so a doc
  // vector ID is never an edge endpoint. Add the teardown here if that
  // invariant changes (issue #203).
  let removedDocs = 0;
  let deleteBudgetExhausted = false;
  for (const doc of deletedDocs) {
    if (removedDocs >= MAX_DOC_DELETIONS_PER_REPO_PER_RUN) {
      deleteBudgetExhausted = true;
      console.warn(
        `pollDocs: delete budget reached for ${repo} ` +
          `(${MAX_DOC_DELETIONS_PER_REPO_PER_RUN} deletions). ` +
          `${deletedDocs.length - removedDocs} remaining docs will be reaped next cron run.`,
      );
      break;
    }

    const dvid = await docVectorId(repo, doc.path);
    // Each surface is torn down independently: a Vectorize failure must not
    // strand the D1 rows, which are the ones users actually retrieve.
    for (const [surface, run] of [
      ["vector", () => env.VECTORIZE.deleteByIds([dvid])],
      ["FTS5 row", () => deleteFtsRow(env.DB_FTS, dvid)],
      [
        "store record",
        () =>
          storeStub.fetch(
            new Request(
              `http://store/doc?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(doc.path)}`,
              { method: "DELETE" },
            ),
          ),
      ],
    ] as Array<[string, () => Promise<unknown>]>) {
      try {
        await run();
      } catch (err) {
        console.error(
          `Failed to delete ${surface} for doc ${repo}/${doc.path}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    removedDocs++;
  }

  // Update watermark with ETag — but only when the run completed without
  // hitting a per-run cap. If either cap was hit, leftover work remains:
  // changed docs still to embed (issue #149) or deleted docs still to reap
  // (issue #203). Persisting the new ETag would cause the next cron to
  // short-circuit on 304 and never see either. Holding the prior ETag forces a
  // fresh tree fetch next run so `changedEntries` and `deletedDocs` both
  // repopulate. lastPolledAt is still bumped so observability sees the run.
  const holdEtag = fetchBudgetExhausted || deleteBudgetExhausted;
  await storeStub.fetch(
    new Request("http://store/watermark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: watermarkKey,
        lastPolledAt: now,
        etag: holdEtag ? storedEtag : responseEtag,
      }),
    }),
  );

  console.log(
    `${repo} docs: ${docEntries.length} found, ${embedded} embedded, ${skipped} unchanged, ${failed} failed, ` +
      `${removedDocs}/${deletedDocs.length} deleted, ` +
      `fetches_issued=${fetchesIssued}/${MAX_DOC_FETCHES_PER_REPO_PER_RUN}`,
  );
}

// ── Wiki doc poller ──────────────────────────────────────────

/**
 * Wiki page markup file extensions probed when no cached extension is available.
 *
 * GitHub Wiki natively supports more formats (mediawiki / org / rst / pod /
 * textile / asciidoc / creole) but the per-page extension probe is a pure
 * subrequest cost — every miss eats 1 of the Worker's 1000-per-invocation
 * subrequest budget (issue #130). Markdown is the dominant format in
 * practice; restricting the probe set to `md` + `markdown` keeps the
 * worst-case subrequest fan-out predictable while still covering every wiki
 * we currently care about. Once a page is ingested the actual extension is
 * cached on its WikiDocRecord and reused on subsequent polls regardless of
 * this probe-set narrowing.
 *
 * Follow-up: re-introduce the rarer extensions behind a per-repo opt-in flag
 * so the bulk-import worst case stays bounded. Tracked in #130 follow-up.
 */
const WIKI_EXTENSIONS = ["md", "markdown"] as const;

/** Maximum wiki pages embedded per repo per cron run.
 *  Caps Workers AI embed budget the same way MAX_EMBEDDINGS_PER_RUN does for
 *  repository docs. Remaining changed pages are picked up on the next cron. */
const MAX_WIKI_EMBEDDINGS_PER_RUN = 30;

/** Maximum raw-content *fetch attempts* the wiki poller issues per repo per
 *  cron run. Distinct from MAX_WIKI_EMBEDDINGS_PER_RUN because probing alone
 *  consumes Worker subrequests even when the page has not changed (we still
 *  fetch the raw content to compare hashes). On bulk import this is the
 *  dominant subrequest cost — cap it so 5+ repos with deep wikis cannot
 *  exhaust the per-invocation 1000-subrequest ceiling (issue #130).
 *
 *  Counted per HTTP attempt, not per page: a page whose extension is not yet
 *  known, or whose slug does not match its on-disk filename, costs more than
 *  one attempt and must not be able to exceed this ceiling by fanning out
 *  (issue #184).
 *
 *  Pages beyond the cap are deferred — but the walk **resumes from a stored
 *  cursor** rather than restarting at the head of the enumeration, so every
 *  page is reached within ceil(pages / cap) runs. Restarting at the head is
 *  what made pages past position 20 structurally unreachable (issue #184). */
const MAX_WIKI_FETCHES_PER_REPO_PER_RUN = 20;

/** Maximum wiki pages reaped (Vectorize + FTS5 + graph edges + store row) per
 *  repo per cron run. Each reap fans out to ~4 subrequests, so an unbounded
 *  loop over a mass rename could exhaust the invocation budget on its own and
 *  starve every repo behind it. Remaining orphans are reaped next run — the
 *  set only shrinks, so the drain is monotonic (issue #184). */
const MAX_WIKI_DELETIONS_PER_REPO_PER_RUN = 5;

/** Maximum pre-reap existence probes issued per repo per cron run.
 *
 *  Separate from MAX_WIKI_DELETIONS_PER_REPO_PER_RUN because a withheld
 *  candidate must not spend a delete slot. The orphan list is stably sorted, so
 *  while an enumeration stays short the same withheld candidates hold the head
 *  of it on every run, and a page that really was deleted sitting behind them
 *  is never reached — the index stays correct, but the delete stalls until the
 *  enumeration recovers (issue #197). With the budgets split, the reap loop
 *  walks the whole orphan list and stops on whichever budget runs out first:
 *  withholding costs a probe, deleting costs a probe *and* a delete slot.
 *
 *  Sized at 3x the delete budget. A probe costs at most `WIKI_EXTENSIONS.length`
 *  = 2 subrequests, so this ceiling is 30, alongside the ~4-per-delete fan-out
 *  of at most 5 deletes. Both are spent outside the walk's fetch budget and stay
 *  well inside the Worker's 1000-subrequest invocation ceiling (issue #130). */
const MAX_WIKI_REAP_PROBES_PER_REPO_PER_RUN = 15;

/** Fraction of the indexed page set which, once the reap candidate set reaches
 *  it, is logged as an anomaly. Warn-only on purpose: a ratio cannot separate a
 *  legitimate bulk cleanup (wiki tidy-up, mass rename) from an enumeration that
 *  came back short, so it must not block a delete. The per-page existence probe
 *  owns that verdict; this only leaves the shape of the run in the logs for a
 *  human to read afterwards (issue #187). */
const WIKI_ORPHAN_RATIO_WARN = 0.5;

/** Watermark namespace holding the wiki poller's resume cursor for one repo.
 *  The cursor is the last page slug probed; the next run resumes at the first
 *  slug ordering after it, wrapping at the end. Stored in the watermark row's
 *  `etag` column (an opaque per-key string) so no schema change is needed. */
const wikiCursorKey = (repo: string): string => `wiki:${repo}`;

/** Watermark namespace holding the slug the current *lap* started after.
 *  The resume cursor alone cannot answer "has every page been covered?" — it
 *  only says where the last pass stopped. The anchor pins the start of the
 *  sweep so a lap can be declared complete across several budget-limited
 *  passes, which is the only way `done` is reachable when a wiki holds more
 *  pages than one pass may fetch (issue #188). Same watermark row shape as the
 *  cursor, different key. */
const wikiLapKey = (repo: string): string => `wiki-lap:${repo}`;

/**
 * Probe whether a repo has a wiki at all.
 *
 * GitHub does not expose wiki content through the REST API, but the wiki git
 * repo is publicly addressable at `https://github.com/{repo}.wiki.git`. The
 * git smart-HTTP discovery endpoint returns 200 when the wiki exists and 404
 * when it does not (or wiki is disabled for the repo). This costs one HTTP
 * round-trip per repo per poll without parsing any git protocol bytes.
 */
async function wikiExists(repo: string): Promise<boolean> {
  const url = `https://github.com/${repo}.wiki.git/info/refs?service=git-upload-pack`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "github-rag-mcp/0.1.0" },
    });
    return resp.status === 200;
  } catch (err) {
    console.error(
      `wikiExists probe failed for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * One wiki page as the `_pages` index describes it.
 *
 * `slug` is the page's stable identity — it keys the vector ID, the store row,
 * the FTS `doc_path` column, and the rendered wiki URL. `rawName` is the
 * best-effort *filename* stem used to build the raw.githubusercontent URL; it
 * differs from the slug whenever the page title contains a character GitHub
 * collapses into `-` when routing (issue #184, `E. Li+language`).
 */
export interface WikiPageRef {
  slug: string;
  rawName: string;
}

/** Result of a `_pages` enumeration; `ok` distinguishes "wiki has no pages"
 *  from "we could not read the index". The caller must never reap orphans on
 *  a failed enumeration — an empty slug set would otherwise read as "every
 *  page was deleted" and wipe the repo's whole wiki index. */
export interface WikiPageIndex {
  pages: WikiPageRef[];
  ok: boolean;
}

/** Decode the handful of HTML entities GitHub emits inside link text. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Total order over page slugs, used both to sort the enumeration and to place
 * the resume cursor. Case-insensitive first (matching how GitHub renders the
 * index) with a case-sensitive tie-break so the order is total and stable.
 */
function compareSlugs(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Enumerate wiki pages by scraping the `/{repo}/wiki/_pages` HTML index.
 *
 * GitHub renders this page as a flat list of every wiki page, with each link
 * shaped `<a ... href="/{repo}/wiki/{page-slug}">{page title}</a>`. Slugs are
 * extracted with a tolerant href-only regex; underscore-prefixed pseudo-pages
 * (`_pages`, `_history`, `_new`, `_access`, …) are rejected so GitHub's own UI
 * links never consume a fetch from the per-run budget.
 *
 * A second pass pairs each slug with its link *text*. GitHub routes a page
 * title through a lossy slug (spaces and `+` both become `-`) while the wiki
 * git repo stores the file under the title with spaces replaced by `-`. For
 * `E. Li+language` the slug is `E.-Li-language` but the file is
 * `E.-Li+language.md`, and building the raw URL from the slug 404s forever.
 * Recovering the filename from the link text is the only signal the index
 * carries about the pre-slug title (issue #184).
 *
 * `Home` is unioned in unconditionally: GitHub omits it from `_pages` even
 * though `Home.md` serves, so an enumeration-only poller can never reach it.
 */
async function listWikiPages(repo: string): Promise<WikiPageIndex> {
  const url = `https://github.com/${repo}/wiki/_pages`;
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent": "github-rag-mcp/0.1.0",
      },
    });
    if (!resp.ok) {
      return { pages: [], ok: false };
    }
    const html = await resp.text();
    // Match `href="/{repo}/wiki/PageName"` — capture the page slug. Both the
    // repo and the slug may contain dots, dashes, and percent-escapes that we
    // unwrap with decodeURIComponent below. The character class excludes URL
    // delimiters that would terminate the slug naturally.
    const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hrefRe = new RegExp(`href="/${escapedRepo}/wiki/([^"#?]+)"`, "g");

    const decodeSlug = (encoded: string): string => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    };

    const slugs = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(html)) !== null) {
      const slug = decodeSlug(m[1]);
      if (!slug || slug.startsWith("_")) continue;
      slugs.add(slug);
    }

    // Second pass: slug -> link text. Kept separate from the slug pass on
    // purpose — an anchor whose markup this regex cannot match must still
    // yield its page, just without the filename hint.
    const titleRe = new RegExp(
      `href="/${escapedRepo}/wiki/([^"#?]+)"[^>]*>([^<]*)<`,
      "g",
    );
    const titles = new Map<string, string>();
    while ((m = titleRe.exec(html)) !== null) {
      const slug = decodeSlug(m[1]);
      const title = decodeHtmlEntities(m[2]).trim();
      if (slug && title && !titles.has(slug)) titles.set(slug, title);
    }

    slugs.add("Home");

    const pages = Array.from(slugs)
      .sort(compareSlugs)
      .map((slug) => {
        const title = titles.get(slug);
        // GitHub stores the page file under its title with spaces replaced by
        // dashes. When that differs from the slug the slug is the lossy form,
        // so the title-derived name is the better raw-URL candidate.
        const rawName = title ? title.replace(/ /g, "-") : slug;
        return { slug, rawName };
      });

    return { pages, ok: true };
  } catch (err) {
    console.error(
      `listWikiPages failed for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { pages: [], ok: false };
  }
}

/**
 * Page names currently present in the D1 FTS index for a repo's wiki.
 *
 * The reap set must be computed against what is actually *indexed*, not only
 * against the structured store: a store row that goes missing (or was never
 * written because the upsert's final store call failed after Vectorize and D1
 * had already been written) makes the page invisible to a store-only diff, and
 * its search_docs / Vectorize / doc_edges rows then survive every later run.
 * That is what left 8 renamed-away pages resolvable in search for months
 * (issue #184, cause E — verified against production D1: the surviving rows'
 * `vector_id` values match `wikiDocVectorId` exactly, so the reap key was
 * never the problem; the reap simply never fired).
 */
async function listIndexedWikiPages(
  env: Env,
  repo: string,
): Promise<{ pages: string[]; ok: boolean }> {
  try {
    const rows = await env.DB_FTS.prepare(
      `SELECT doc_path FROM search_docs WHERE type = 'wiki_doc' AND repo = ?`,
    )
      .bind(repo)
      .all<{ doc_path: string }>();
    const pages = (rows.results ?? [])
      .map((r) => String(r.doc_path ?? ""))
      .filter((p) => p.length > 0);
    return { pages, ok: true };
  } catch (err) {
    console.error(
      `listIndexedWikiPages failed for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { pages: [], ok: false };
  }
}

/** Read one wiki watermark slug; `null` when the row does not exist yet.
 *  `null` is distinct from `""`: the lap anchor treats "never stored" and
 *  "anchored at the head" differently. */
async function readWikiSlug(
  storeStub: DurableObjectStub,
  key: string,
  label: string,
): Promise<string | null> {
  try {
    const resp = await storeStub.fetch(
      new Request(`http://store/watermark?repo=${encodeURIComponent(key)}`),
    );
    if (!resp.ok) return null;
    const wm = (await resp.json()) as { etag?: string };
    return wm.etag ?? "";
  } catch (err) {
    console.error(
      `${label} failed for ${key}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Persist one wiki watermark slug. */
async function writeWikiSlug(
  storeStub: DurableObjectStub,
  key: string,
  slug: string,
  label: string,
): Promise<void> {
  try {
    await storeStub.fetch(
      new Request("http://store/watermark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: key,
          lastPolledAt: new Date().toISOString(),
          etag: slug,
        }),
      }),
    );
  } catch (err) {
    console.error(
      `${label} failed for ${key}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Read the wiki resume cursor for a repo; "" when none is stored yet. */
async function readWikiCursor(
  storeStub: DurableObjectStub,
  repo: string,
): Promise<string> {
  return (await readWikiSlug(storeStub, wikiCursorKey(repo), "readWikiCursor")) ?? "";
}

/** Persist the wiki resume cursor for a repo. */
async function writeWikiCursor(
  storeStub: DurableObjectStub,
  repo: string,
  cursor: string,
): Promise<void> {
  await writeWikiSlug(storeStub, wikiCursorKey(repo), cursor, "writeWikiCursor");
}

/** Read the lap anchor for a repo; `null` when no lap has been anchored yet. */
async function readWikiLapAnchor(
  storeStub: DurableObjectStub,
  repo: string,
): Promise<string | null> {
  return readWikiSlug(storeStub, wikiLapKey(repo), "readWikiLapAnchor");
}

/** Persist the lap anchor for a repo. */
async function writeWikiLapAnchor(
  storeStub: DurableObjectStub,
  repo: string,
  anchor: string,
): Promise<void> {
  await writeWikiSlug(storeStub, wikiLapKey(repo), anchor, "writeWikiLapAnchor");
}

/**
 * Fetch a wiki page's raw markup content.
 *
 * GitHub serves wiki content from `raw.githubusercontent.com/wiki/{repo}/{page}.{ext}`
 * (no branch segment — wiki raw URLs route directly without referencing master/main).
 * If `preferredExtension` is provided (i.e. the page is already known from a
 * previous poll), try it first to skip the multi-extension probe. Otherwise
 * iterate through every supported extension until one returns 200.
 *
 * Returns null when no extension matches (page may have been deleted, renamed,
 * or moved to an unsupported format).
 */
async function fetchWikiContent(
  repo: string,
  page: WikiPageRef,
  preferredExtension?: string,
  maxAttempts = Number.POSITIVE_INFINITY,
): Promise<{
  result: { content: string; extension: string } | null;
  attempts: number;
}> {
  const exts = preferredExtension
    ? [preferredExtension, ...WIKI_EXTENSIONS.filter((e) => e !== preferredExtension)]
    : Array.from(WIKI_EXTENSIONS);

  // Filename candidates, most likely first. For the overwhelming majority of
  // pages these collapse to a single entry, so the common path costs exactly
  // what it did before.
  const names = page.rawName && page.rawName !== page.slug
    ? [page.rawName, page.slug]
    : [page.slug];

  // Extension outer, filename inner: markdown dominates in practice, so a page
  // whose title-derived name misses is resolved by the slug on the *second*
  // attempt rather than after the whole extension set has been walked.
  let attempts = 0;
  for (const ext of exts) {
    for (const name of names) {
      if (attempts >= maxAttempts) return { result: null, attempts };
      const url = `https://raw.githubusercontent.com/wiki/${repo}/${encodeURIComponent(name)}.${ext}`;
      attempts++;
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "github-rag-mcp/0.1.0" },
        });
        if (resp.ok) {
          return {
            result: { content: await resp.text(), extension: ext },
            attempts,
          };
        }
      } catch (err) {
        console.error(
          `fetchWikiContent probe ${ext} failed for ${repo}/${name}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
  return { result: null, attempts };
}

/** Verdict of the pre-reap existence probe. `gone` is the only one that
 *  authorizes a delete. */
type WikiReapProbe = "alive" | "gone" | "inconclusive";

/**
 * Ask the wiki directly whether an orphan candidate's content still serves.
 *
 * The reap set is `store ∪ search_docs` minus the `_pages` enumeration, so an
 * enumeration that silently returns *fewer* pages than the wiki holds pushes
 * live pages into it. Issue #185 guarded the total failure (`ok: false`), but a
 * partial one is indistinguishable from a real deletion at the set level: the
 * check has to leave the set and address the page itself (issue #187).
 *
 * Only an observed 404 on every candidate extension returns `gone`. A 200
 * (`alive`) and anything else — a network error, or a status that is neither
 * 200 nor 404 (`inconclusive`) — both withhold the delete, because neither
 * proves the page is absent. Withholding never deadlocks: a page that really
 * was deleted keeps answering 404 and is reaped on this run or the next.
 *
 * The rendered URL `github.com/{repo}/wiki/{slug}` is deliberately *not* the
 * oracle here. Measured 2026-08-01: a nonexistent page 302-redirects to the
 * wiki root and lands on 200, so it can never report absence — every candidate
 * would read as alive and nothing would ever be reaped. `raw.githubusercontent`
 * is the same surface the walk already fetches from, with 200/404 semantics the
 * poller relies on elsewhere.
 *
 * Residual gap, unchanged from before this guard: the probe can only address
 * the page by its slug, and a page whose file is stored under a title-derived
 * name (`E.-Li-language` → `E.-Li+language.md`, issue #184) answers 404 to the
 * slug. The enumeration's link text is the only carrier of that name, and an
 * orphan is by definition absent from the enumeration. Such a page reaps as it
 * would have without the guard.
 *
 * Cost: at most `WIKI_EXTENSIONS.length` subrequests per candidate, and one
 * when the stored extension serves the verdict on the first attempt. The reap
 * loop caps the number of calls at `MAX_WIKI_REAP_PROBES_PER_REPO_PER_RUN`, so
 * the guard's per-run ceiling is that product. It is separate from the walk's
 * fetch budget and never consumes it.
 */
async function probeWikiPageAlive(
  repo: string,
  pageName: string,
  preferredExtension?: string,
): Promise<WikiReapProbe> {
  const exts = preferredExtension
    ? [preferredExtension, ...WIKI_EXTENSIONS.filter((e) => e !== preferredExtension)]
    : Array.from(WIKI_EXTENSIONS);

  let inconclusive = false;
  for (const ext of exts) {
    const url = `https://raw.githubusercontent.com/wiki/${repo}/${encodeURIComponent(pageName)}.${ext}`;
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "github-rag-mcp/0.1.0" },
      });
      if (resp.ok) return "alive";
      if (resp.status !== 404) inconclusive = true;
    } catch (err) {
      console.error(
        `Reap probe ${ext} failed for wiki ${repo}/${pageName}:`,
        err instanceof Error ? err.message : String(err),
      );
      inconclusive = true;
    }
  }
  return inconclusive ? "inconclusive" : "gone";
}

/** Budget / cursor overrides for one wiki poll pass. Defaults are the cron
 *  values; the admin backfill endpoint supplies its own so an operator can
 *  drain a wiki without waiting out the hourly cadence. */
export interface WikiPollOptions {
  /** Max raw-content fetch attempts this pass may issue. */
  fetchBudget?: number;
  /** Max pages this pass may embed. */
  embedBudget?: number;
  /** Max orphan pages this pass may reap. */
  deleteBudget?: number;
  /** Start the walk after this slug instead of the stored cursor. */
  cursor?: string;
  /** Persist the resulting cursor (default true). */
  persistCursor?: boolean;
}

/** Outcome of one wiki poll pass, returned so the admin endpoint can drive a
 *  drain loop and tests can assert the fetch budget was respected. */
export interface WikiPollSummary {
  repo: string;
  /** Pages in the current enumeration (0 when the index could not be read). */
  pages: number;
  /** Raw-content fetch attempts issued. Bounded by the fetch budget, except
   *  that the pass's first page always finishes its candidate list — so a
   *  budget below that page's candidate count is exceeded by at most
   *  `candidates - 1`, once per pass (issue #192). */
  fetches: number;
  /** Pages whose content was examined this pass. */
  visited: number;
  embedded: number;
  skipped: number;
  failed: number;
  removed: number;
  /** Orphan candidates the reap loop never reached, because it stopped on the
   *  delete or the probe budget. A withheld candidate *was* reached, so it is
   *  reported by `orphansWithheld` and not counted here (issue #197). */
  orphansDeferred: number;
  /** Reap candidates whose content still served (or whose probe could not
   *  complete), so the delete was withheld. Non-zero means the `_pages`
   *  enumeration came back short of the live wiki (issue #187). */
  orphansWithheld: number;
  startCursor: string;
  nextCursor: string;
  /** Slug the current lap started after ("" = the lap began at the head).
   *  Together with `nextCursor` this is the lap's progress: the walk runs from
   *  the first page after the anchor around to the anchor again. */
  lapAnchor: string;
  /** True when this pass reached the last page of the current lap, i.e. the
   *  cursor completed a full circuit of the enumeration. The lap may span
   *  several passes — a wiki with more pages than the per-pass fetch budget
   *  can never finish one in a single pass, which is exactly why this is not
   *  "covered every page in this one pass" (issue #188). */
  wrapped: boolean;
  /** False when the `_pages` index could not be read; no reaping happened. */
  enumerated: boolean;
}

/**
 * Poll a single repository's wiki for content updates.
 *
 * Strategy: enumerate pages, walk them **circularly from a stored cursor**,
 * fetch each page's raw content, hash the body, and only embed pages whose
 * hash differs from the stored value (or new pages). The walk stops on the
 * per-run fetch budget and persists the cursor, so the next run continues
 * where this one stopped and every page is reached within
 * ceil(pages / budget) runs. Restarting at the head each run is what pinned
 * coverage to the first ~20 pages forever (issue #184, cause A).
 *
 * The budget yields to the candidate list for the pass's *first* page only:
 * breaking mid-probe leaves the cursor unmoved, so a budget smaller than one
 * page's candidate count would otherwise re-probe that same page forever
 * (issue #192). Every later page keeps the strict budget check.
 *
 * A second watermark — the lap anchor — records where the current sweep began,
 * so `wrapped` reports "the cursor came back around to the anchor" rather than
 * "this one pass saw every page". The latter is unreachable whenever the wiki
 * holds more pages than one pass may fetch, which made the admin endpoint's
 * `done` flag a stop condition that never fired (issue #188).
 *
 * Pages absent from the current `_pages` index but still present in the store
 * *or in the D1 FTS index* are reaped from Vectorize, D1 FTS5, the graph edge
 * table, and the structured store. Reaping is skipped entirely when the
 * enumeration failed, capped per run, and — because a *partially* enumerated
 * index is indistinguishable from a real deletion at the set level — withheld
 * for any candidate whose raw content still serves (issue #187). The per-run
 * cap is two budgets, not one: a withheld candidate spends a probe but no
 * delete slot, so it cannot hold the head of the sorted candidate list and
 * starve the real deletions behind it (issue #197).
 */
export async function pollWiki(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
  opts: WikiPollOptions = {},
): Promise<WikiPollSummary> {
  const fetchBudget = opts.fetchBudget ?? MAX_WIKI_FETCHES_PER_REPO_PER_RUN;
  const embedBudget = opts.embedBudget ?? MAX_WIKI_EMBEDDINGS_PER_RUN;
  const deleteBudget = opts.deleteBudget ?? MAX_WIKI_DELETIONS_PER_REPO_PER_RUN;
  const probeBudget = MAX_WIKI_REAP_PROBES_PER_REPO_PER_RUN;
  const persistCursor = opts.persistCursor ?? true;

  const empty = (startCursor: string): WikiPollSummary => ({
    repo,
    pages: 0,
    fetches: 0,
    visited: 0,
    embedded: 0,
    skipped: 0,
    failed: 0,
    removed: 0,
    orphansDeferred: 0,
    orphansWithheld: 0,
    startCursor,
    nextCursor: startCursor,
    lapAnchor: startCursor,
    wrapped: false,
    enumerated: false,
  });

  // Cheap existence probe so repos without wiki incur a single HEAD-equivalent
  // round-trip per cron run instead of three (probe + index + content).
  const hasWiki = await wikiExists(repo);
  if (!hasWiki) {
    console.log(`${repo} wiki: not enabled or not accessible — skip`);
    return empty("");
  }

  const index = await listWikiPages(repo);
  const pages = index.pages;
  if (!index.ok) {
    // Could not read `_pages`. Bail before the reap: an empty slug set here
    // means "we are blind", not "every page was deleted".
    console.warn(`${repo} wiki: page index unavailable — skip this run`);
    return empty(opts.cursor ?? (await readWikiCursor(storeStub, repo)));
  }
  // No "0 pages discovered" branch: `Home` is unioned into every successful
  // enumeration, so a readable index always yields at least one page. An empty
  // set only means the scrape failed, which the guard above already returned on.

  const startCursor = opts.cursor ?? (await readWikiCursor(storeStub, repo));

  // The lap anchor marks where the current sweep began. An explicit cursor
  // override is an operator saying "start the walk here", so it opens a fresh
  // lap at that point; otherwise the stored anchor carries across passes and
  // falls back to the current cursor the first time a repo is walked.
  const storedAnchor =
    opts.cursor !== undefined ? null : await readWikiLapAnchor(storeStub, repo);
  const lapAnchor = storedAnchor ?? startCursor;

  // Snapshot the existing wiki doc records so we can detect deletes and pick
  // a per-page preferred extension on subsequent polls.
  const existingResp = await storeStub.fetch(
    new Request(`http://store/wiki-docs?repo=${encodeURIComponent(repo)}`),
  );
  const existing: WikiDocRecord[] = existingResp.ok
    ? ((await existingResp.json()) as WikiDocRecord[])
    : [];
  const existingMap = new Map(existing.map((w) => [w.pageName, w]));
  const currentSlugs = new Set(pages.map((p) => p.slug));

  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  let removed = 0;
  let orphansWithheld = 0;
  let fetches = 0;
  let visited = 0;
  let nextCursor = startCursor;
  let wrapped = false;

  // Resume at the first page ordering strictly after the cursor; wrap to the
  // head when the cursor sits at (or past) the end, or when it names a page
  // that no longer exists.
  let start = pages.findIndex((p) => compareSlugs(p.slug, startCursor) > 0);
  if (start < 0) start = 0;

  // The lap closes on the page immediately *before* the one the lap started
  // on: reaching it means the cursor has come all the way back around to the
  // anchor. Resolved by slug order rather than by a stored index so a page
  // added or deleted mid-lap cannot desync it.
  let lapStart = pages.findIndex((p) => compareSlugs(p.slug, lapAnchor) > 0);
  if (lapStart < 0) lapStart = 0;
  const lapFinalSlug = pages[(lapStart - 1 + pages.length) % pages.length].slug;

  for (let step = 0; step < pages.length; step++) {
    const page = pages[(start + step) % pages.length];

    if (embedded >= embedBudget) {
      console.warn(
        `Wiki embedding batch limit reached for ${repo} (${embedBudget}). ` +
          `Remaining wiki pages will be retried next cron run.`,
      );
      break;
    }

    if (fetches >= fetchBudget) {
      console.warn(
        `Wiki fetch batch limit reached for ${repo} (${fetchBudget}). ` +
          `Each fetch consumes a Worker subrequest; the cursor resumes here next run.`,
      );
      break;
    }

    const prior = existingMap.get(page.slug);
    // While nothing has been visited yet, the candidate list outranks the
    // budget: a pass that breaks before its first page leaves the cursor where
    // it found it, so a budget below one page's candidate count stalls the walk
    // forever instead of self-healing on the next pass (issue #192). Letting the
    // first page finish its probes costs at most `candidates - 1` extra
    // subrequests, once per pass, against an invocation budget of 1000.
    const { result: fetched, attempts } = await fetchWikiContent(
      repo,
      page,
      prior?.extension,
      visited === 0 ? Number.POSITIVE_INFINITY : fetchBudget - fetches,
    );
    fetches += attempts;

    if (!fetched && visited > 0 && fetches >= fetchBudget) {
      // The budget ran out inside this page's candidate list, so "no content"
      // is inconclusive. Leave the cursor before the page and retry next run
      // rather than recording a failure we did not actually observe.
      // Not reachable while `visited === 0`: that probe was allowed to run to
      // the end of the candidate list, so its miss *was* observed and falls
      // through to the failure path below, advancing the cursor.
      console.warn(
        `Wiki fetch batch limit reached for ${repo} (${fetchBudget}) while probing ` +
          `${page.slug}; the cursor resumes at this page next run.`,
      );
      break;
    }

    visited++;
    nextCursor = page.slug;
    if (page.slug === lapFinalSlug) wrapped = true;

    if (!fetched) {
      // The slug was discovered in `_pages` but no extension served. Treat as
      // a transient miss and skip — the next poll will retry without spending
      // an embedding budget here.
      console.warn(`No content fetched for ${repo}/wiki/${page.slug} (all candidates 404)`);
      failed++;
      continue;
    }

    const contentHash = await sha256Hex(fetched.content);
    if (prior && prior.contentHash === contentHash && prior.extension === fetched.extension) {
      skipped++;
      continue;
    }

    const result = await processAndUpsertWikiDoc(
      env,
      storeStub,
      repo,
      page.slug,
      fetched.extension,
      fetched.content,
    );

    if (result.embedded) {
      embedded++;
    } else if (result.failed) {
      failed++;
    }
  }

  // Orphan reap. The candidate set is the union of the structured store and
  // the live FTS index: a page missing from the store but still in search_docs
  // is exactly the case a store-only diff cannot see, and it is the one that
  // actually happened in production (issue #184, cause E).
  const indexed = await listIndexedWikiPages(env, repo);
  const orphanSet = new Set<string>();
  for (const w of existing) {
    if (!currentSlugs.has(w.pageName)) orphanSet.add(w.pageName);
  }
  for (const pageName of indexed.pages) {
    if (!currentSlugs.has(pageName)) orphanSet.add(pageName);
  }
  const orphans = Array.from(orphanSet).sort(compareSlugs);

  // Warn-only anomaly signal. A reap set this large against what is indexed is
  // either a legitimate bulk cleanup or an enumeration that came back short;
  // the ratio cannot tell them apart, so it decides nothing and only makes the
  // shape of the run readable in the logs (issue #187).
  const indexedTotal = new Set([
    ...existing.map((w) => w.pageName),
    ...indexed.pages,
  ]).size;
  if (indexedTotal > 0 && orphans.length / indexedTotal >= WIKI_ORPHAN_RATIO_WARN) {
    console.warn(
      `${repo} wiki: reap set is ${orphans.length}/${indexedTotal} of the indexed pages ` +
        `(>= ${WIKI_ORPHAN_RATIO_WARN}). Legitimate bulk deletion and a short ` +
        `\`_pages\` enumeration both look like this; each candidate is probed before deletion.`,
    );
  }

  // The loop walks the *whole* candidate list and stops on whichever budget
  // runs out. Slicing to the delete budget instead let a withheld candidate
  // spend a delete slot, and since the list is stably sorted the same withheld
  // heads would repeat every run while the real deletions behind them waited
  // for the enumeration to recover (issue #197).
  let probes = 0;
  for (const pageName of orphans) {
    if (removed >= deleteBudget || probes >= probeBudget) break;

    // Existence check before the delete. The candidate is only "orphaned" as
    // far as the enumeration knows, and the enumeration is exactly what may
    // have come back short (issue #187).
    probes++;
    const probe = await probeWikiPageAlive(
      repo,
      pageName,
      existingMap.get(pageName)?.extension,
    );
    if (probe !== "gone") {
      orphansWithheld++;
      console.warn(
        probe === "alive"
          ? `${repo} wiki: ${pageName} is absent from \`_pages\` but its content still ` +
              `serves — the enumeration is short of the live wiki. Reap withheld.`
          : `${repo} wiki: could not confirm ${pageName} is deleted (probe inconclusive). ` +
              `Reap withheld this run.`,
      );
      continue;
    }

    const wvid = await wikiDocVectorId(repo, pageName);
    // Each surface is torn down independently: a Vectorize failure must not
    // strand the D1 rows, which are the ones users actually retrieve.
    for (const [surface, run] of [
      ["vector", () => env.VECTORIZE.deleteByIds([wvid])],
      ["FTS5 row", () => deleteFtsRow(env.DB_FTS, wvid)],
      ["graph edges", () => deleteEdgesForVector(env.DB_FTS, wvid)],
      [
        "store record",
        () =>
          storeStub.fetch(
            new Request(
              `http://store/wiki-doc?repo=${encodeURIComponent(repo)}&page=${encodeURIComponent(pageName)}`,
              { method: "DELETE" },
            ),
          ),
      ],
    ] as Array<[string, () => Promise<unknown>]>) {
      try {
        await run();
      } catch (err) {
        console.error(
          `Failed to delete ${surface} for wiki ${repo}/${pageName}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    removed++;
  }

  // Every candidate the loop reached cost exactly one probe, so the probe count
  // is also the reached count: what is left over is what this run never looked
  // at. Withheld candidates were looked at and are reported separately.
  const orphansDeferred = Math.max(0, orphans.length - probes);
  if (orphansDeferred > 0) {
    console.warn(
      `${repo} wiki: ${orphans.length} orphans found, ${removed} reaped and ` +
        `${orphansWithheld} withheld this run ` +
        `(${orphansDeferred} not reached, deferred to the next run).`,
    );
  }

  // A completed lap re-anchors on the page that closed it, so the next lap
  // starts at the page after it and the walk keeps moving forward.
  const nextLapAnchor = wrapped ? lapFinalSlug : lapAnchor;

  if (persistCursor) {
    if (nextCursor !== startCursor) {
      await writeWikiCursor(storeStub, repo, nextCursor);
    }
    if (nextLapAnchor !== storedAnchor) {
      await writeWikiLapAnchor(storeStub, repo, nextLapAnchor);
    }
  }

  console.log(
    `${repo} wiki: ${pages.length} pages, ${visited} visited, ${fetches}/${fetchBudget} fetches, ` +
      `${embedded} embedded, ${skipped} unchanged, ${failed} failed, ${removed} deleted, ` +
      `${orphansWithheld} reap withheld, ` +
      `cursor ${startCursor || "<head>"} -> ${nextCursor || "<head>"}, ` +
      `lap ${lapAnchor || "<head>"}${wrapped ? " complete" : ` -> ${lapFinalSlug}`}`,
  );

  return {
    repo,
    pages: pages.length,
    fetches,
    visited,
    embedded,
    skipped,
    failed,
    removed,
    orphansDeferred,
    orphansWithheld,
    startCursor,
    nextCursor,
    lapAnchor,
    wrapped,
    enumerated: true,
  };
}

// ── Comment / review backfill ────────────────────────────────

/** Identify whether an issue record represents a pull request (has the PR surface) */
function isPullRequestRecord(record: IssueRecord): boolean {
  return record.type === "pull_request";
}

/** Fetch top-level comments for a single issue/PR. Returns [] on transient failures. */
async function fetchIssueComments(
  repo: string,
  number: number,
  token: string,
): Promise<GitHubCommentData[]> {
  const url = `https://api.github.com/repos/${repo}/issues/${number}/comments?per_page=100`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-rag-mcp/0.1.0",
    },
    cache: "no-store",
  } as RequestInit);

  if (!resp.ok) {
    throw new Error(`GitHub Issues Comments API error ${resp.status} for ${repo}#${number}`);
  }

  return (await resp.json()) as GitHubCommentData[];
}

/** Fetch PR reviews for a single PR. */
async function fetchPRReviews(
  repo: string,
  number: number,
  token: string,
): Promise<GitHubPRReviewData[]> {
  const url = `https://api.github.com/repos/${repo}/pulls/${number}/reviews?per_page=100`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-rag-mcp/0.1.0",
    },
    cache: "no-store",
  } as RequestInit);

  if (!resp.ok) {
    throw new Error(`GitHub PR Reviews API error ${resp.status} for ${repo}#${number}`);
  }

  return (await resp.json()) as GitHubPRReviewData[];
}

/** Fetch PR inline review comments for a single PR. */
async function fetchPRReviewComments(
  repo: string,
  number: number,
  token: string,
): Promise<GitHubPRReviewCommentData[]> {
  const url = `https://api.github.com/repos/${repo}/pulls/${number}/comments?per_page=100`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-rag-mcp/0.1.0",
    },
    cache: "no-store",
  } as RequestInit);

  if (!resp.ok) {
    throw new Error(`GitHub PR Review Comments API error ${resp.status} for ${repo}#${number}`);
  }

  return (await resp.json()) as GitHubPRReviewCommentData[];
}

/**
 * Backfill comments, reviews, and review comments for a repo.
 *
 * Strategy: iterate over the most recently updated issues/PRs in the store
 * (capped at MAX_COMMENT_BACKFILL_PARENTS), fetch their comment lists,
 * and ingest each comment via the shared pipeline (bot / min-length filter
 * + hash-based skip handle deduplication and noise).
 *
 * Embedding count is capped at MAX_COMMENTS_EMBEDDED_PER_REPO to stay within
 * Workers AI rate budgets. Remaining items are picked up on the next cron.
 */
async function pollComments(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  // Pull the most recent issues/PRs from the store; these are the most likely
  // to have fresh comments. Limit keeps fan-out bounded on busy repos.
  const recentResp = await storeStub.fetch(
    new Request(
      `http://store/issues?repo=${encodeURIComponent(repo)}&limit=${MAX_COMMENT_BACKFILL_PARENTS}`,
    ),
  );
  if (!recentResp.ok) {
    console.warn(`pollComments: unable to list recent issues for ${repo}`);
    return;
  }

  const parents = (await recentResp.json()) as IssueRecord[];
  if (parents.length === 0) {
    console.log(`${repo} comments: no parents to backfill`);
    return;
  }

  let commentsEmbedded = 0;
  let commentsSkipped = 0;
  let commentsFiltered = 0;
  let reviewsEmbedded = 0;
  let reviewsSkipped = 0;
  let reviewsFiltered = 0;
  let reviewCommentsEmbedded = 0;
  let reviewCommentsSkipped = 0;
  let reviewCommentsFiltered = 0;
  let fetchFailures = 0;
  let fetchesIssued = 0;
  let fetchBudgetExhausted = false;

  const embedBudget = (): boolean =>
    commentsEmbedded + reviewsEmbedded + reviewCommentsEmbedded < MAX_COMMENTS_EMBEDDED_PER_REPO;

  const fetchBudget = (): boolean => fetchesIssued < MAX_COMMENT_FETCHES_PER_REPO_PER_RUN;

  for (const parent of parents) {
    if (!embedBudget()) break;
    if (!fetchBudget()) {
      fetchBudgetExhausted = true;
      break;
    }

    // Top-level comments (issues and PRs both route through /issues/{N}/comments)
    try {
      fetchesIssued++;
      const comments = await fetchIssueComments(repo, parent.number, env.GITHUB_TOKEN);
      for (const c of comments) {
        if (!embedBudget()) break;
        const result = await ingestIssueComment(env, storeStub, repo, parent.number, c);
        if (result.embedded) commentsEmbedded++;
        else if (result.skippedUnchanged) commentsSkipped++;
        else if (result.filtered) commentsFiltered++;
      }
    } catch (err) {
      fetchFailures++;
      console.error(
        `pollComments: failed to fetch comments for ${repo}#${parent.number}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    // PR-only: review bodies + inline review comments
    if (!isPullRequestRecord(parent)) continue;

    if (!embedBudget()) break;
    if (!fetchBudget()) {
      fetchBudgetExhausted = true;
      break;
    }

    try {
      fetchesIssued++;
      const reviews = await fetchPRReviews(repo, parent.number, env.GITHUB_TOKEN);
      for (const r of reviews) {
        if (!embedBudget()) break;
        const result = await ingestPRReview(env, storeStub, repo, parent.number, r);
        if (result.embedded) reviewsEmbedded++;
        else if (result.skippedUnchanged) reviewsSkipped++;
        else if (result.filtered) reviewsFiltered++;
      }
    } catch (err) {
      fetchFailures++;
      console.error(
        `pollComments: failed to fetch reviews for ${repo}#${parent.number}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!embedBudget()) break;
    if (!fetchBudget()) {
      fetchBudgetExhausted = true;
      break;
    }

    try {
      fetchesIssued++;
      const inline = await fetchPRReviewComments(repo, parent.number, env.GITHUB_TOKEN);
      for (const rc of inline) {
        if (!embedBudget()) break;
        const result = await ingestPRReviewComment(env, storeStub, repo, parent.number, rc);
        if (result.embedded) reviewCommentsEmbedded++;
        else if (result.skippedUnchanged) reviewCommentsSkipped++;
        else if (result.filtered) reviewCommentsFiltered++;
      }
    } catch (err) {
      fetchFailures++;
      console.error(
        `pollComments: failed to fetch review comments for ${repo}#${parent.number}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (fetchBudgetExhausted) {
    console.warn(
      `pollComments: fetch budget reached for ${repo} ` +
        `(${MAX_COMMENT_FETCHES_PER_REPO_PER_RUN} fetches). Each parent fans out to up ` +
        `to 3 endpoints; remaining parents are deferred to the next cron run.`,
    );
  }

  console.log(
    `${repo} comments: scanned ${parents.length} parents, ` +
      `fetches_issued=${fetchesIssued}/${MAX_COMMENT_FETCHES_PER_REPO_PER_RUN}, ` +
      `top-level [embedded=${commentsEmbedded}, skipped=${commentsSkipped}, filtered=${commentsFiltered}], ` +
      `reviews [embedded=${reviewsEmbedded}, skipped=${reviewsSkipped}, filtered=${reviewsFiltered}], ` +
      `inline [embedded=${reviewCommentsEmbedded}, skipped=${reviewCommentsSkipped}, filtered=${reviewCommentsFiltered}], ` +
      `fetch_failures=${fetchFailures}`,
  );
}

/** GitHub API commit list item — subset used by the diff poller. */
interface GitHubCommitSummary {
  sha: string;
  commit: {
    message?: string;
    author?: { date?: string | null } | null;
    committer?: { date?: string | null } | null;
  };
}

/**
 * Fetch a single page of commits from `GET /repos/{repo}/commits`.
 * Supports `since` (inclusive lower bound on committer date) and `until`
 * (inclusive upper bound) filters; the two are combined by GitHub with AND.
 * Results are ordered newest-first by committer date.
 * Throws on non-2xx responses so the caller can log and fall back.
 */
async function fetchRepoCommits(
  repo: string,
  token: string,
  opts: { since?: string; until?: string; per_page: number },
): Promise<GitHubCommitSummary[]> {
  const url = new URL(`https://api.github.com/repos/${repo}/commits`);
  url.searchParams.set("per_page", String(opts.per_page));
  if (opts.since) url.searchParams.set("since", opts.since);
  if (opts.until) url.searchParams.set("until", opts.until);

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
    const text = await resp.text();
    throw new Error(
      `GitHub Commits list API error ${resp.status} for ${repo}: ${text}`,
    );
  }

  return (await resp.json()) as GitHubCommitSummary[];
}

/** Read a watermark record by its namespaced key; returns null when absent. */
async function readWatermark(
  storeStub: DurableObjectStub,
  key: string,
): Promise<{ lastPolledAt: string } | null> {
  const resp = await storeStub.fetch(
    new Request(`http://store/watermark?repo=${encodeURIComponent(key)}`),
  );
  if (!resp.ok) return null;
  const wm = (await resp.json()) as { repo: string; lastPolledAt: string };
  return { lastPolledAt: wm.lastPolledAt };
}

/** Upsert a watermark record under the given namespaced key. */
async function writeWatermark(
  storeStub: DurableObjectStub,
  key: string,
  lastPolledAt: string,
): Promise<void> {
  await storeStub.fetch(
    new Request("http://store/watermark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: key, lastPolledAt }),
    }),
  );
}

/** Extract the best-available ISO timestamp from a commit summary. */
function commitDateOf(summary: GitHubCommitSummary): string | undefined {
  return (
    summary.commit.author?.date ??
    summary.commit.committer?.date ??
    undefined
  );
}

/**
 * Per-commit ingestion outcome inside one diff-poller phase.
 *
 * - `ok`       — the commit's every indexable file landed in Vectorize.
 * - `failed`   — the detail fetch, an embedding batch, or a Vectorize upsert
 *                failed for at least one file; the commit must stay retryable.
 * - `deferred` — the commit was inside the enumerated window but was not
 *                attempted this run (per-run commit cap).
 */
export type DiffCommitStatus = "ok" | "failed" | "deferred";

/** One commit's outcome, in the order the phase walked its commits. */
export interface DiffCommitOutcome {
  sha: string;
  /** Commit timestamp; absent when GitHub returned neither author nor committer date. */
  date?: string;
  status: DiffCommitStatus;
}

/**
 * Compute the next forward (`diffs:{repo}`) watermark.
 *
 * Invariant: **the forward watermark never advances past the earliest commit
 * that has not been successfully ingested.** Before issue #178 the phase moved
 * the watermark to the poll start time unconditionally, so any commit that
 * failed — or that the per-run cap deferred — fell out of every subsequent
 * `since` window and was lost permanently (the backward phase only walks into
 * older history and never returns to that period).
 *
 * @param since      watermark the phase started from (lower bound, never regressed)
 * @param windowEnd  upper bound of the window that was fully enumerated
 * @param outcomes   every commit in the window, oldest-first
 * @returns the watermark to persist; equal to `since` when nothing may advance
 */
export function nextForwardDiffWatermark(
  since: string,
  windowEnd: string,
  outcomes: DiffCommitOutcome[],
): string {
  const boundary = outcomes.find((o) => o.status !== "ok");

  // Whole window ingested — the window end is now the proven-complete frontier.
  if (!boundary) return windowEnd;

  // A commit we could not place on the timeline cannot bound the retry window;
  // hold the watermark so the next run re-covers the same period.
  if (!boundary.date) return since;
  const boundaryTime = Date.parse(boundary.date);
  if (Number.isNaN(boundaryTime)) return since;

  const candidate = new Date(
    boundaryTime - DIFF_RETRY_BOUNDARY_BACKOFF_MS,
  ).toISOString();

  // Never regress: the boundary can sit at (or before) the current watermark
  // when the first commit of the window is the one that failed.
  const sinceTime = Date.parse(since);
  if (Number.isNaN(sinceTime)) return candidate;
  return Date.parse(candidate) > sinceTime ? candidate : since;
}

/**
 * Compute the next backward (`diffs_backfill:{repo}`) watermark.
 *
 * Mirror image of the forward invariant: **the backfill watermark never moves
 * past the newest commit that has not been successfully ingested.** The phase
 * walks newest-first, so the watermark may only advance across the contiguous
 * successful prefix; the first failure freezes it, keeping that commit inside
 * the next run's `until` window. Commits already ingested after the freeze
 * point are re-ingested next run, which is bounded by the per-run cap and
 * idempotent on (repo, commit_sha, file_path).
 *
 * @param current   watermark the phase started from (`until` bound)
 * @param outcomes  commits in the order processed, newest-first
 * @returns the watermark to persist, or `undefined` to leave it unchanged
 */
export function nextBackfillDiffWatermark(
  current: string,
  outcomes: DiffCommitOutcome[],
): string | undefined {
  let lastGood: string | undefined;
  for (const o of outcomes) {
    // Stop at the first commit that is not proven ingested, and at any commit
    // we cannot place on the timeline (it cannot serve as an `until` bound).
    if (o.status !== "ok" || !o.date || Number.isNaN(Date.parse(o.date))) break;
    lastGood = o.date;
  }
  if (!lastGood) return undefined;

  // Backfill only ever moves into older history.
  const currentTime = Date.parse(current);
  if (!Number.isNaN(currentTime) && Date.parse(lastGood) > currentTime) {
    return undefined;
  }
  return lastGood;
}

/** Midpoint between two ISO timestamps; undefined when the span is degenerate. */
function midpointIso(from: string, to: string): string | undefined {
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  if (Number.isNaN(fromTime) || Number.isNaN(toTime)) return undefined;
  if (toTime - fromTime <= 1000) return undefined;
  return new Date(fromTime + Math.floor((toTime - fromTime) / 2)).toISOString();
}

/**
 * Enumerate every commit in the forward window `(since, windowEnd]`.
 *
 * GitHub returns commits newest-first with no ascending option, so a truncated
 * page hides the *oldest* end of the window — exactly the end the forward phase
 * must process first. A page that comes back full therefore means "window not
 * enumerable"; the window is halved and retried until one page covers it.
 *
 * @returns the enumerated commits plus the (possibly shrunk) window end, or
 *          null when the shrink budget was exhausted without enumerating.
 * @throws  whatever `fetchRepoCommits` throws (caller holds the watermark)
 */
async function enumerateForwardWindow(
  repo: string,
  token: string,
  since: string,
  windowEnd: string,
): Promise<{ commits: GitHubCommitSummary[]; windowEnd: string } | null> {
  let end = windowEnd;

  for (let shrink = 0; shrink <= MAX_DIFF_FORWARD_WINDOW_SHRINKS; shrink++) {
    const page = await fetchRepoCommits(repo, token, {
      since,
      until: end,
      per_page: DIFF_FORWARD_LIST_PER_PAGE,
    });
    if (page.length < DIFF_FORWARD_LIST_PER_PAGE) {
      return { commits: page, windowEnd: end };
    }

    const mid = midpointIso(since, end);
    if (!mid) return null;
    console.warn(
      `pollDiffs: forward window ${since}..${end} for ${repo} exceeds one list ` +
        `page (${DIFF_FORWARD_LIST_PER_PAGE}) — shrinking window end to ${mid}`,
    );
    end = mid;
  }

  return null;
}

/**
 * Fetch one commit's detail and upsert its per-file diffs.
 *
 * `processAndUpsertCommitDiff` reports embedding / Vectorize failures through
 * its return value rather than by throwing, so both surfaces are folded into a
 * single outcome here — otherwise a commit whose vectors never landed would
 * still count as ingested and let the watermark pass it (issue #178).
 *
 * Ingestion is judged on the dense side only, matching the pipeline's own
 * boundary: a D1 FTS mirror or Store DO row failure is logged there and
 * deliberately not counted, because the Vectorize upsert has already landed and
 * the sparse index reconciles on reindex. Gating the watermark on the sparse
 * mirror would let an FTS-side outage stall the whole diff surface.
 */
async function ingestCommitDiff(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
  summary: GitHubCommitSummary,
): Promise<DiffCommitOutcome> {
  const date = commitDateOf(summary);
  try {
    const detail = await fetchCommitDetail(repo, summary.sha, env.GITHUB_TOKEN);
    const result = await processAndUpsertCommitDiff(env, storeStub, repo, detail);
    if (result.failed > 0) {
      console.error(
        `pollDiffs: ${repo}@${summary.sha} partially failed ` +
          `(embedded=${result.embedded}, failed=${result.failed}) — ` +
          `commit stays inside the retry window`,
      );
      return { sha: summary.sha, date, status: "failed" };
    }
    return { sha: summary.sha, date, status: "ok" };
  } catch (err) {
    console.error(
      `pollDiffs: commit ${repo}@${summary.sha} failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return { sha: summary.sha, date, status: "failed" };
  }
}

/** Per-phase counters surfaced in the run's summary log line. */
interface DiffPhaseStats {
  processed: number;
  failed: number;
  deferred: number;
  /** Watermark did not advance this run (list failure, or an unprocessed commit at the boundary). */
  held: boolean;
}

/**
 * Forward phase — webhook redundancy plus gap recovery.
 *
 * Enumerates `(watermark, pollStartTime]`, processes its **oldest**
 * MAX_DIFF_COMMITS_FORWARD_PER_RUN commits, and advances the watermark only
 * across the contiguous successfully-ingested prefix. Anything failed or
 * deferred stays inside the next run's window, so a burst larger than the
 * per-run cap drains over successive runs instead of being skipped.
 */
async function runForwardDiffPhase(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
  pollStartTime: string,
): Promise<DiffPhaseStats> {
  const fwdKey = `diffs:${repo}`;
  const fwdWm = await readWatermark(storeStub, fwdKey);
  // First run: start one hour ago so the initial forward sweep covers the
  // last cron interval without pulling the whole history into this phase.
  const since =
    fwdWm?.lastPolledAt ??
    new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const stats: DiffPhaseStats = { processed: 0, failed: 0, deferred: 0, held: false };

  if (Date.parse(since) >= Date.parse(pollStartTime)) {
    console.warn(
      `pollDiffs: forward watermark ${since} is not older than poll start ` +
        `${pollStartTime} for ${repo} — skipping forward phase`,
    );
    stats.held = true;
    return stats;
  }

  let window: { commits: GitHubCommitSummary[]; windowEnd: string } | null;
  try {
    window = await enumerateForwardWindow(
      repo,
      env.GITHUB_TOKEN,
      since,
      pollStartTime,
    );
  } catch (err) {
    // A failed list leaves the window unknown; holding the watermark keeps the
    // whole period retryable on the next run.
    console.error(
      `pollDiffs: forward list failed for ${repo} — watermark held at ${since}:`,
      err instanceof Error ? err.message : String(err),
    );
    stats.held = true;
    return stats;
  }

  if (!window) {
    console.error(
      `pollDiffs: forward window for ${repo} still exceeds one list page after ` +
        `${MAX_DIFF_FORWARD_WINDOW_SHRINKS} shrinks — watermark held at ${since}`,
    );
    stats.held = true;
    return stats;
  }

  // GitHub returns newest-first; walk oldest-first so the watermark advances
  // over a prefix that is contiguous in commit-date order.
  const ordered = [...window.commits].reverse();
  const outcomes: DiffCommitOutcome[] = [];
  for (const summary of ordered) {
    if (outcomes.length >= MAX_DIFF_COMMITS_FORWARD_PER_RUN) {
      outcomes.push({
        sha: summary.sha,
        date: commitDateOf(summary),
        status: "deferred",
      });
      stats.deferred++;
      continue;
    }
    const outcome = await ingestCommitDiff(repo, env, storeStub, summary);
    outcomes.push(outcome);
    if (outcome.status === "ok") stats.processed++;
    else stats.failed++;
  }

  const next = nextForwardDiffWatermark(since, window.windowEnd, outcomes);
  if (next !== since) {
    await writeWatermark(storeStub, fwdKey, next);
  } else {
    stats.held = true;
    const boundary = outcomes.find((o) => o.status !== "ok");
    console.warn(
      `pollDiffs: forward watermark held at ${since} for ${repo}` +
        (boundary ? ` — boundary commit ${boundary.sha} (${boundary.status})` : ""),
    );
  }

  return stats;
}

/**
 * Backward phase — historical backfill.
 *
 * Walks `until=watermark` into older history. The watermark advances only
 * across the contiguous successful prefix (newest-first), so a failed commit
 * stays inside the next run's window instead of being stepped over.
 */
async function runBackfillDiffPhase(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
  pollStartTime: string,
): Promise<DiffPhaseStats> {
  const bwdKey = `diffs_backfill:${repo}`;
  const bwdWm = await readWatermark(storeStub, bwdKey);
  // First run: start walking backward from the current time.
  const until = bwdWm?.lastPolledAt ?? pollStartTime;

  const stats: DiffPhaseStats = { processed: 0, failed: 0, deferred: 0, held: false };

  let commits: GitHubCommitSummary[];
  try {
    commits = await fetchRepoCommits(repo, env.GITHUB_TOKEN, {
      until,
      per_page: MAX_DIFF_COMMITS_BACKWARD_PER_RUN,
    });
  } catch (err) {
    console.error(
      `pollDiffs: backward list failed for ${repo} — watermark held at ${until}:`,
      err instanceof Error ? err.message : String(err),
    );
    stats.held = true;
    return stats;
  }

  const outcomes: DiffCommitOutcome[] = [];
  for (const summary of commits) {
    const outcome = await ingestCommitDiff(repo, env, storeStub, summary);
    outcomes.push(outcome);
    if (outcome.status === "ok") stats.processed++;
    else stats.failed++;
  }

  // With 0 commits returned the repo's history is exhausted (or the token lost
  // access); leaving the watermark alone avoids silently skipping a window.
  const next = nextBackfillDiffWatermark(until, outcomes);
  if (next) {
    await writeWatermark(storeStub, bwdKey, next);
  } else {
    stats.held = true;
    if (outcomes.length > 0) {
      console.warn(
        `pollDiffs: backfill watermark held at ${until} for ${repo} — ` +
          `newest attempted commit ${outcomes[0].sha} is not ingested`,
      );
    }
  }

  return stats;
}

/**
 * Poll historical and recent commit diffs for a repository and upsert them
 * through the shared commit-diff pipeline.
 *
 * Two phases run per cron tick:
 *
 * 1. **Forward** (webhook redundancy + gap recovery): enumerate the window
 *    `(diffs:{repo} watermark, pollStartTime]` and process its oldest commits
 *    first. The first run uses "one hour ago" as the initial since so the
 *    initial fetch stays bounded.
 *
 * 2. **Backward** (historical backfill): fetch commits with
 *    `until=diffs_backfill:{repo} watermark` so the poller walks backward
 *    through the repo's history one tick at a time. The first run uses "now"
 *    as the initial until. When the repo's history is exhausted the API
 *    returns 0 commits and the watermark stops advancing — subsequent runs
 *    repeatedly return 0 commits, which is acceptable idle-state behavior.
 *
 * Both phases share one watermark invariant (issue #178): **a watermark never
 * moves past a commit that has not been successfully ingested.** A failed
 * detail fetch, embedding, Vectorize or D1 write — and a commit the per-run cap
 * deferred — all keep the commit inside the next run's window, so a transient
 * failure costs a retry instead of a permanent gap.
 *
 * Each phase is capped at a small commit count (see MAX_DIFF_COMMITS_*) to
 * spread cost across many cron ticks. `processAndUpsertCommitDiff` upserts
 * on the (repo, commit_sha, file_path) primary key, so overlap with webhook,
 * with the opposite phase, or with a retried commit is idempotent.
 *
 * Liveness tradeoff: a commit that fails on every attempt (e.g. a permanently
 * 5xx-ing detail fetch) blocks its phase's watermark. That is deliberate — a
 * stall is visible in the run log, which names the boundary commit, whereas the
 * pre-#178 "advance anyway" behavior was silent. The manual escape hatch is
 * `POST /admin/diff-watermark` (see `src/index.ts`).
 */
export async function pollDiffs(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  const pollStartTime = new Date().toISOString();

  const fwd = await runForwardDiffPhase(repo, env, storeStub, pollStartTime);
  const bwd = await runBackfillDiffPhase(repo, env, storeStub, pollStartTime);

  console.log(
    `${repo} diffs: forward [processed=${fwd.processed}, failed=${fwd.failed}, ` +
      `deferred=${fwd.deferred}, watermark=${fwd.held ? "held" : "advanced"}], ` +
      `backward [processed=${bwd.processed}, failed=${bwd.failed}, ` +
      `watermark=${bwd.held ? "held" : "advanced"}]`,
  );
}

/** Cron expression that triggers the light-surface dispatch (issues / releases / docs). */
const LIGHT_CRON = "0 * * * *";
/** Cron expression that triggers the comments-only dispatch. */
const COMMENTS_CRON = "15 * * * *";
/** Cron expression that triggers the diffs-only dispatch. */
const DIFFS_CRON = "30 * * * *";
/** Cron expression that triggers the wiki-only dispatch. */
const WIKI_CRON = "45 * * * *";

/**
 * Run the lightweight surfaces (issues, releases, docs) for one repo.
 * Errors in any one call are logged but do not stop subsequent surfaces or repos.
 */
async function runLightSurfaces(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  try {
    await pollRepo(repo, env, storeStub);
  } catch (err) {
    console.error(
      `Failed to poll ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    await pollReleases(repo, env, storeStub);
  } catch (err) {
    console.error(
      `Failed to poll releases for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    await pollDocs(repo, env, storeStub);
  } catch (err) {
    console.error(
      `Failed to poll docs for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Run the comment-backfill surface for one repo.
 * Lives in its own cron invocation because each comment upsert fans out to
 * Store DO + Vectorize + D1 FTS + AI embed and the 5-repo aggregate alone
 * approaches the per-Worker subrequest ceiling (issue #122).
 */
async function runCommentsSurface(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  try {
    await pollComments(repo, env, storeStub);
  } catch (err) {
    console.error(
      `Failed to poll comments for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Run the commit-diff (forward + backward) surface for one repo.
 * Same isolation rationale as `runCommentsSurface` — each diff upsert also
 * fans out to several internal subrequests so it gets its own invocation.
 */
async function runDiffsSurface(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  try {
    await pollDiffs(repo, env, storeStub);
  } catch (err) {
    console.error(
      `Failed to poll diffs for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Run the wiki-content surface for one repo.
 * Lives in its own cron invocation because each wiki page upsert fans out to
 * Workers AI embed + Vectorize + D1 FTS + Store DO, and wiki page enumeration
 * additionally requires an HTML scrape that can be heavy on busy wikis.
 */
async function runWikiSurface(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  try {
    await pollWiki(repo, env, storeStub);
  } catch (err) {
    console.error(
      `Failed to poll wiki for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Main scheduled handler — dispatched by cron expression so each invocation
 * gets its own Cloudflare Workers subrequest budget.
 *
 * Three cron triggers fire hourly, staggered by 15 minutes:
 *
 *   - `LIGHT_CRON`    (`:00`) → issues / releases / docs across all repos
 *   - `COMMENTS_CRON` (`:15`) → issue / PR comments across all repos
 *   - `DIFFS_CRON`    (`:30`) → commit diffs (forward + backward) across all repos
 *
 * Bundling all surfaces (or even just comments + diffs) into a single
 * invocation exhausts the per-Worker subrequest limit on busy repositories
 * because every upsert fans out to Store DO + Vectorize + D1 FTS + AI embed.
 * Splitting heavy surfaces one-per-cron leaves each invocation with a fresh
 * budget for its single surface across all repos.
 *
 * Unrecognised cron expressions fall through to a no-op log so adding a
 * future cron line in `wrangler.toml` does not silently re-introduce the
 * "every surface in one invocation" pattern.
 */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  console.log(
    "[poller] Cron trigger fired:",
    controller.cron,
    new Date(controller.scheduledTime).toISOString(),
  );

  const repos = env.POLL_REPOS
    ? env.POLL_REPOS.split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0)
    : [];

  if (repos.length === 0) {
    console.warn("POLL_REPOS not configured — no repositories to poll");
    return;
  }

  if (!env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN not configured — cannot poll GitHub API");
    return;
  }

  // Use a single IssueStore DO instance (keyed by a fixed name for the global store)
  const storeId = env.ISSUE_STORE.idFromName("global");
  const storeStub = env.ISSUE_STORE.get(storeId);

  if (controller.cron === LIGHT_CRON) {
    for (const repo of repos) {
      await runLightSurfaces(repo, env, storeStub);
    }
    return;
  }

  if (controller.cron === COMMENTS_CRON) {
    for (const repo of repos) {
      await runCommentsSurface(repo, env, storeStub);
    }
    return;
  }

  if (controller.cron === DIFFS_CRON) {
    for (const repo of repos) {
      await runDiffsSurface(repo, env, storeStub);
    }
    return;
  }

  if (controller.cron === WIKI_CRON) {
    for (const repo of repos) {
      await runWikiSurface(repo, env, storeStub);
    }
    return;
  }

  console.warn(
    `[poller] Unknown cron expression "${controller.cron}" — no dispatch configured`,
  );
}
