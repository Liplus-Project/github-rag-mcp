/**
 * Cron Poller — scheduled handler for GitHub issue/PR polling and embedding pipeline.
 *
 * Runs hourly as a fallback sync (primary updates arrive via webhook).
 * Fetches issue/PR updates from GitHub API using `since` parameter for incremental updates.
 * Generates embeddings via Workers AI BGE-M3 and upserts into Vectorize.
 * Stores structured metadata in IssueStore Durable Object.
 */

import type { Env, IssueRecord, ReleaseRecord, DocRecord } from "./types.js";
import {
  docVectorId,
  processAndUpsertIssue,
  processAndUpsertRelease,
  processAndUpsertDoc,
  type GitHubIssueData,
  type GitHubReleaseData,
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

/**
 * Main scheduled handler — called by Cron Trigger hourly as fallback.
 * Polls all configured repositories for issue/PR updates.
 */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  console.log("[poller] Running hourly fallback sync");
  console.log(
    "Cron trigger fired:",
    controller.cron,
    new Date(controller.scheduledTime).toISOString(),
  );

  // Parse repository list from env
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

  // Poll each repository sequentially to stay within rate limits
  for (const repo of repos) {
    try {
      await pollRepo(repo, env, storeStub);
    } catch (err) {
      console.error(
        `Failed to poll ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      // Continue polling other repos even if one fails
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
}
