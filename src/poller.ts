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
 *  worst-case bounded; remaining parents are picked up on the next cron. */
const MAX_COMMENT_FETCHES_PER_REPO_PER_RUN = 30;

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

  for (const release of releases) {
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

    const result = await processAndUpsertRelease(env, storeStub, repo, release);

    if (result.skippedUnchanged) {
      skipped++;
    } else if (result.embedded) {
      embedded++;
    } else if (result.failed) {
      failed++;
    }
  }

  // Update watermark with ETag
  await storeStub.fetch(
    new Request("http://store/watermark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: watermarkKey, lastPolledAt: new Date().toISOString(), etag: responseEtag }),
    }),
  );

  console.log(
    `${repo} releases: ${releases.length} total, ${embedded} embedded, ${skipped} unchanged, ${failed} failed`,
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
): Promise<{ tree: GitTreeEntry[]; treeSha: string; etag?: string } | typeof NOT_MODIFIED> {
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
  return { tree: data.tree, treeSha: data.sha, etag: responseEtag };
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
 */
async function pollDocs(
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
  const now = new Date().toISOString();

  // Process changed/new doc files
  for (const entry of changedEntries) {
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

  // Handle deleted files: remove from Vectorize, D1 FTS5, and the structured store.
  for (const doc of deletedDocs) {
    try {
      const dvid = await docVectorId(repo, doc.path);
      await env.VECTORIZE.deleteByIds([dvid]);
      try {
        await deleteFtsRow(env.DB_FTS, dvid);
      } catch (ftsErr) {
        console.error(
          `Failed to delete FTS5 row for doc ${repo}/${doc.path}:`,
          ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
        );
      }
      await storeStub.fetch(
        new Request(
          `http://store/doc?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(doc.path)}`,
          { method: "DELETE" },
        ),
      );
    } catch (err) {
      console.error(
        `Failed to delete doc vector ${repo}/${doc.path}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Update watermark with ETag
  await storeStub.fetch(
    new Request("http://store/watermark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: watermarkKey, lastPolledAt: now, etag: responseEtag }),
    }),
  );

  console.log(
    `${repo} docs: ${docEntries.length} found, ${embedded} embedded, ${skipped} unchanged, ${failed} failed, ${deletedDocs.length} deleted`,
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

/** Maximum wiki pages whose content we *probe* (HTTP fetch) per repo per cron
 *  run. Distinct from MAX_WIKI_EMBEDDINGS_PER_RUN because probing alone
 *  consumes Worker subrequests even when the page has not changed (we still
 *  fetch the raw content to compare hashes). On bulk import this is the
 *  dominant subrequest cost — cap it so 5+ repos with deep wikis cannot
 *  exhaust the per-invocation 1000-subrequest ceiling (issue #130). Pages
 *  beyond the cap are deferred to the next cron run. */
const MAX_WIKI_PAGES_PROBED_PER_REPO_PER_RUN = 20;

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
 * Enumerate wiki page slugs by scraping the `/{repo}/wiki/_pages` HTML index.
 *
 * GitHub renders this page as a flat list of every wiki page, with each link
 * shaped `<a ... href="/{repo}/wiki/{page-slug}">`. We extract the slugs with
 * a tolerant regex and reject the special pseudo-pages (`_pages`, `_history`,
 * `_new`, `_access`, etc.) that share the underscore prefix convention.
 *
 * If the index is empty or the request fails, we return [] so the caller can
 * fall through to the no-op path.
 */
async function listWikiPages(repo: string): Promise<string[]> {
  const url = `https://github.com/${repo}/wiki/_pages`;
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent": "github-rag-mcp/0.1.0",
      },
    });
    if (!resp.ok) {
      return [];
    }
    const html = await resp.text();
    // Match `href="/{repo}/wiki/PageName"` — capture the page slug. Both the
    // repo and the slug may contain dots, dashes, and percent-escapes that we
    // unwrap with decodeURIComponent below. The character class excludes URL
    // delimiters that would terminate the slug naturally.
    const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`href="/${escapedRepo}/wiki/([^"#?]+)"`, "g");
    const pages = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      let slug: string;
      try {
        slug = decodeURIComponent(m[1]);
      } catch {
        slug = m[1];
      }
      if (!slug || slug.startsWith("_")) continue;
      pages.add(slug);
    }
    return Array.from(pages);
  } catch (err) {
    console.error(
      `listWikiPages failed for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
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
  pageName: string,
  preferredExtension?: string,
): Promise<{ content: string; extension: string } | null> {
  const probes = preferredExtension
    ? [preferredExtension, ...WIKI_EXTENSIONS.filter((e) => e !== preferredExtension)]
    : Array.from(WIKI_EXTENSIONS);

  for (const ext of probes) {
    const url = `https://raw.githubusercontent.com/wiki/${repo}/${encodeURIComponent(pageName)}.${ext}`;
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "github-rag-mcp/0.1.0" },
      });
      if (resp.ok) {
        return { content: await resp.text(), extension: ext };
      }
    } catch (err) {
      console.error(
        `fetchWikiContent probe ${ext} failed for ${repo}/${pageName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return null;
}

/**
 * Poll a single repository's wiki for content updates.
 *
 * Strategy: enumerate page slugs, fetch each page's raw content, hash the
 * body, and only embed pages whose hash differs from the stored value
 * (or new pages). Deleted pages — present in the store but absent from the
 * current `_pages` index — are removed from Vectorize, D1 FTS5, and the
 * structured store, mirroring the doc poller's deletion path.
 */
async function pollWiki(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  // Cheap existence probe so repos without wiki incur a single HEAD-equivalent
  // round-trip per cron run instead of three (probe + index + content).
  const hasWiki = await wikiExists(repo);
  if (!hasWiki) {
    console.log(`${repo} wiki: not enabled or not accessible — skip`);
    return;
  }

  const pageSlugs = await listWikiPages(repo);
  if (pageSlugs.length === 0) {
    console.log(`${repo} wiki: 0 pages discovered`);
  }

  // Snapshot the existing wiki doc records so we can detect deletes and pick
  // a per-page preferred extension on subsequent polls.
  const existingResp = await storeStub.fetch(
    new Request(`http://store/wiki-docs?repo=${encodeURIComponent(repo)}`),
  );
  const existing: WikiDocRecord[] = existingResp.ok
    ? ((await existingResp.json()) as WikiDocRecord[])
    : [];
  const existingMap = new Map(existing.map((w) => [w.pageName, w]));
  const currentSlugs = new Set(pageSlugs);
  const deleted = existing.filter((w) => !currentSlugs.has(w.pageName));

  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  let removed = 0;
  let probed = 0;

  for (const pageName of pageSlugs) {
    if (embedded >= MAX_WIKI_EMBEDDINGS_PER_RUN) {
      console.warn(
        `Wiki embedding batch limit reached for ${repo} (${MAX_WIKI_EMBEDDINGS_PER_RUN}). ` +
          `Remaining wiki pages will be retried next cron run.`,
      );
      break;
    }

    if (probed >= MAX_WIKI_PAGES_PROBED_PER_REPO_PER_RUN) {
      console.warn(
        `Wiki probe batch limit reached for ${repo} (${MAX_WIKI_PAGES_PROBED_PER_REPO_PER_RUN}). ` +
          `Each probe consumes a Worker subrequest; bulk imports spread across multiple cron runs.`,
      );
      break;
    }

    const prior = existingMap.get(pageName);
    probed++;
    const fetched = await fetchWikiContent(repo, pageName, prior?.extension);
    if (!fetched) {
      // The slug was discovered in `_pages` but no extension served. Treat as
      // a transient miss and skip — the next poll will retry without spending
      // an embedding budget here.
      console.warn(`No content fetched for ${repo}/wiki/${pageName} (all extensions 404)`);
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
      pageName,
      fetched.extension,
      fetched.content,
    );

    if (result.embedded) {
      embedded++;
    } else if (result.failed) {
      failed++;
    }
  }

  // Handle deleted pages: remove from Vectorize, FTS5, and the store.
  for (const wikiDoc of deleted) {
    try {
      const wvid = await wikiDocVectorId(repo, wikiDoc.pageName);
      await env.VECTORIZE.deleteByIds([wvid]);
      try {
        await deleteFtsRow(env.DB_FTS, wvid);
      } catch (ftsErr) {
        console.error(
          `Failed to delete FTS5 row for wiki ${repo}/${wikiDoc.pageName}:`,
          ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
        );
      }
      await storeStub.fetch(
        new Request(
          `http://store/wiki-doc?repo=${encodeURIComponent(repo)}&page=${encodeURIComponent(wikiDoc.pageName)}`,
          { method: "DELETE" },
        ),
      );
      removed++;
    } catch (err) {
      console.error(
        `Failed to delete wiki vector ${repo}/${wikiDoc.pageName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log(
    `${repo} wiki: ${pageSlugs.length} pages, ${embedded} embedded, ${skipped} unchanged, ${failed} failed, ${removed} deleted`,
  );
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
 * Poll historical and recent commit diffs for a repository and upsert them
 * through the shared commit-diff pipeline.
 *
 * Two phases run per cron tick:
 *
 * 1. **Forward** (webhook redundancy): fetch commits with `since=lastPolledAt`
 *    so the poller re-covers any commits missed while webhook delivery was
 *    stalled. The first run uses "one hour ago" as the initial since so the
 *    initial fetch stays bounded; subsequent runs advance the forward
 *    watermark to the current poll start time unconditionally.
 *
 * 2. **Backward** (historical backfill): fetch commits with
 *    `until=oldestUnprocessedDate` so the poller walks backward through the
 *    repo's history one tick at a time. The first run uses "now" as the
 *    initial until; subsequent runs advance the backward watermark to the
 *    commit_date of the oldest commit processed in this run. When the repo's
 *    history is exhausted the API returns 0 commits and the watermark stops
 *    advancing — subsequent runs will repeatedly return 0 commits, which is
 *    acceptable idle-state behavior.
 *
 * Each phase is capped at a small commit count (see MAX_DIFF_COMMITS_*) to
 * spread cost across many cron ticks. `processAndUpsertCommitDiff` upserts
 * on the (repo, commit_sha, file_path) primary key, so overlap with webhook
 * or with the opposite phase is idempotent.
 */
export async function pollDiffs(
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<void> {
  const pollStartTime = new Date().toISOString();

  // ── Forward phase ───────────────────────────────────────────
  const fwdKey = `diffs:${repo}`;
  const fwdWm = await readWatermark(storeStub, fwdKey);
  // First run: start one hour ago so the initial forward sweep covers the
  // last cron interval without pulling the whole history into this phase.
  const sinceFwd =
    fwdWm?.lastPolledAt ??
    new Date(Date.now() - 60 * 60 * 1000).toISOString();

  let fwdProcessed = 0;
  let fwdFailed = 0;
  try {
    const fwdCommits = await fetchRepoCommits(repo, env.GITHUB_TOKEN, {
      since: sinceFwd,
      per_page: MAX_DIFF_COMMITS_FORWARD_PER_RUN,
    });
    for (const summary of fwdCommits) {
      try {
        const detail = await fetchCommitDetail(
          repo,
          summary.sha,
          env.GITHUB_TOKEN,
        );
        await processAndUpsertCommitDiff(env, storeStub, repo, detail);
        fwdProcessed++;
      } catch (err) {
        fwdFailed++;
        console.error(
          `pollDiffs: forward commit ${repo}@${summary.sha} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    console.error(
      `pollDiffs: forward list failed for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  // Advance the forward watermark regardless of partial failures so the next
  // run continues from pollStartTime instead of reprocessing the same window.
  // Upstream upsert is idempotent on (repo, commit_sha, file_path).
  await writeWatermark(storeStub, fwdKey, pollStartTime);

  // ── Backward phase ──────────────────────────────────────────
  const bwdKey = `diffs_backfill:${repo}`;
  const bwdWm = await readWatermark(storeStub, bwdKey);
  // First run: start walking backward from the current time.
  const untilBwd = bwdWm?.lastPolledAt ?? pollStartTime;

  let bwdProcessed = 0;
  let bwdFailed = 0;
  let oldestSeenDate: string | undefined;
  try {
    const bwdCommits = await fetchRepoCommits(repo, env.GITHUB_TOKEN, {
      until: untilBwd,
      per_page: MAX_DIFF_COMMITS_BACKWARD_PER_RUN,
    });
    // GitHub returns commits newest-first; the last entry is the oldest in
    // this page and becomes the next-run watermark.
    for (const summary of bwdCommits) {
      try {
        const detail = await fetchCommitDetail(
          repo,
          summary.sha,
          env.GITHUB_TOKEN,
        );
        await processAndUpsertCommitDiff(env, storeStub, repo, detail);
        bwdProcessed++;
        const d = commitDateOf(summary);
        if (d) oldestSeenDate = d;
      } catch (err) {
        bwdFailed++;
        console.error(
          `pollDiffs: backward commit ${repo}@${summary.sha} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    console.error(
      `pollDiffs: backward list failed for ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  // Only advance the backward watermark when we actually saw a commit. If the
  // API returned 0 commits the repo's history is exhausted (or the token lost
  // access); leaving the watermark alone avoids silently skipping a window.
  if (oldestSeenDate) {
    await writeWatermark(storeStub, bwdKey, oldestSeenDate);
  }

  console.log(
    `${repo} diffs: forward [processed=${fwdProcessed}, failed=${fwdFailed}], ` +
      `backward [processed=${bwdProcessed}, failed=${bwdFailed}]`,
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
