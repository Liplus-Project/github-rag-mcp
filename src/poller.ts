/**
 * Cron Poller — scheduled handler for GitHub issue/PR polling and embedding pipeline.
 *
 * Runs every 5 minutes via Cloudflare Cron Triggers.
 * Fetches issue/PR updates from GitHub API using `since` parameter for incremental updates.
 * Generates embeddings via Workers AI BGE-M3 and upserts into Vectorize.
 * Stores structured metadata in IssueStore Durable Object.
 */

import type { Env, IssueRecord } from "./types.js";

/** GitHub API issue/PR response shape (subset of fields we need) */
interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  milestone: { title: string } | null;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  pull_request?: { url: string };
  html_url: string;
}

/** Maximum characters for embedding input (BGE-M3 context limit ~8192 tokens, conservative char limit) */
const MAX_EMBEDDING_INPUT_CHARS = 8000;

/** GitHub API page size */
const PER_PAGE = 100;

/** Maximum number of embeddings to generate per single cron run.
 *  Prevents Workers AI rate-limit errors on large repos.
 *  Remaining issues are stored with empty bodyHash and retried next cron. */
const MAX_EMBEDDINGS_PER_RUN = 50;

/** Maximum number of API pages to fetch per single cron run.
 *  Prevents Cloudflare Worker CPU time limit on large repos (e.g. 900+ issues initial sync).
 *  At PER_PAGE=100, this caps a single run at 500 issues.
 *  When capped, the watermark is set to the last fetched issue's updated_at
 *  so the next cron continues from where it left off. */
const MAX_PAGES_PER_RUN = 5;

/**
 * Compute SHA-256 hash of title + body for change detection.
 * Returns hex-encoded hash string.
 */
async function computeBodyHash(title: string, body: string): Promise<string> {
  const input = title + "\n\n" + body;
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Prepare embedding input text from issue title and body.
 * Concatenates title + "\n\n" + body, truncated to MAX_EMBEDDING_INPUT_CHARS.
 */
function prepareEmbeddingInput(title: string, body: string | null): string {
  const text = title + "\n\n" + (body ?? "");
  if (text.length <= MAX_EMBEDDING_INPUT_CHARS) return text;
  return text.slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

/**
 * Build Vectorize vector ID from repo and issue number.
 * Format: "owner/repo#123"
 */
function vectorId(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/**
 * Fetch a single page of issues from GitHub API.
 * Returns the issues array and a flag indicating whether more pages exist.
 */
async function fetchIssuePage(
  repo: string,
  token: string,
  opts: { since?: string; page: number; state?: string },
): Promise<{ issues: GitHubIssue[]; hasMore: boolean }> {
  const url = new URL(`https://api.github.com/repos/${repo}/issues`);
  url.searchParams.set("state", opts.state ?? "all");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(opts.page));
  if (opts.since) {
    url.searchParams.set("since", opts.since);
  }

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-rag-mcp/0.1.0",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API error ${resp.status}: ${text}`);
  }

  const issues = (await resp.json()) as GitHubIssue[];
  const hasMore = issues.length === PER_PAGE;
  return { issues, hasMore };
}

/**
 * Fetch issues (with pagination) from GitHub API since a given timestamp.
 * When maxPages is provided, stops after that many pages to stay within
 * Cloudflare Worker CPU time limits. Returns a `capped` flag indicating
 * whether pagination was truncated before exhausting all results.
 */
async function fetchAllIssues(
  repo: string,
  token: string,
  since?: string,
  maxPages?: number,
): Promise<{ issues: GitHubIssue[]; capped: boolean }> {
  const allIssues: GitHubIssue[] = [];
  let page = 1;

  while (true) {
    const { issues, hasMore } = await fetchIssuePage(repo, token, {
      since,
      page,
    });
    allIssues.push(...issues);

    if (!hasMore) break;
    page++;

    // Stop if we've reached the per-run page cap
    if (maxPages && page > maxPages) {
      console.warn(
        `Pagination capped at ${maxPages} pages (${allIssues.length} issues) for ${repo}. ` +
        `Remaining issues will be fetched in subsequent cron runs.`,
      );
      return { issues: allIssues, capped: true };
    }

    // Safety: absolute cap to prevent runaway loops
    if (page > 50) {
      console.warn(`Absolute pagination cap reached for ${repo} at page ${page}`);
      return { issues: allIssues, capped: true };
    }
  }

  return { issues: allIssues, capped: false };
}

/**
 * Generate embedding for a text input using Workers AI BGE-M3.
 * Returns 1024-dimensional float array.
 */
async function generateEmbedding(
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
 * Process a batch of issues: compute hashes, generate embeddings for changed items,
 * upsert into Vectorize and IssueStore.
 */
async function processIssues(
  issues: GitHubIssue[],
  repo: string,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<{ processed: number; embedded: number; skipped: number; failed: number }> {
  let processed = 0;
  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  // Process in batches to manage memory and rate limits
  for (const issue of issues) {
    const body = issue.body ?? "";
    const title = issue.title;
    const bodyHash = await computeBodyHash(title, body);

    const type: IssueRecord["type"] = issue.pull_request
      ? "pull_request"
      : "issue";

    // Check if body has changed by comparing hash with stored value
    const existingResp = await storeStub.fetch(
      new Request(
        `http://store/issue?repo=${encodeURIComponent(repo)}&number=${issue.number}`,
      ),
    );

    let needsEmbedding = true;
    if (existingResp.ok) {
      const existing = (await existingResp.json()) as IssueRecord;
      if (existing.bodyHash === bodyHash) {
        needsEmbedding = false;
        skipped++;
      }
    }

    // Track whether embedding succeeded — determines whether bodyHash is saved
    let embeddingSucceeded = false;

    // Enforce per-run embedding limit to avoid Workers AI rate limits
    if (needsEmbedding && embedded >= MAX_EMBEDDINGS_PER_RUN) {
      if (embedded === MAX_EMBEDDINGS_PER_RUN) {
        console.warn(
          `Embedding batch limit reached (${MAX_EMBEDDINGS_PER_RUN}). ` +
          `Remaining issues will be retried next cron run.`,
        );
      }
      // Skip embedding — store with empty bodyHash so next poll retries
      needsEmbedding = true; // keep flag for bodyHash logic below
    }

    // Generate embedding if content changed and within batch limit
    if (needsEmbedding && embedded < MAX_EMBEDDINGS_PER_RUN) {
      try {
        const embeddingInput = prepareEmbeddingInput(title, issue.body);
        const embedding = await generateEmbedding(env.AI, embeddingInput);

        const metadata: Record<string, string | number> = {
          repo,
          number: issue.number,
          type,
          state: issue.state,
          labels: issue.labels.map((l) => l.name).join(","),
          milestone: issue.milestone?.title ?? "",
          assignees: issue.assignees.map((a) => a.login).join(","),
          updated_at: issue.updated_at,
        };

        // Upsert vector into Vectorize
        await env.VECTORIZE.upsert([
          {
            id: vectorId(repo, issue.number),
            values: embedding,
            metadata,
          },
        ]);

        embeddingSucceeded = true;
        embedded++;
      } catch (err) {
        console.error(
          `Failed to embed ${repo}#${issue.number}:`,
          err instanceof Error ? err.message : String(err),
        );
        failed++;
        // Continue processing other issues even if one fails
      }
    }

    // Build record — save bodyHash only when embedding succeeded (or was skipped
    // because it already exists). When embedding fails, store empty bodyHash so
    // the next poll will detect a mismatch and retry embedding.
    const record: IssueRecord = {
      repo,
      number: issue.number,
      type,
      state: issue.state,
      title,
      labels: issue.labels.map((l) => l.name),
      milestone: issue.milestone?.title ?? "",
      assignees: issue.assignees.map((a) => a.login),
      bodyHash: needsEmbedding && !embeddingSucceeded ? "" : bodyHash,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    };

    // Upsert structured data into IssueStore (always, even if embedding skipped)
    await storeStub.fetch(
      new Request("http://store/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }),
    );

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
  // Get watermark (last poll timestamp)
  const wmResp = await storeStub.fetch(
    new Request(
      `http://store/watermark?repo=${encodeURIComponent(repo)}`,
    ),
  );

  let since: string | undefined;
  if (wmResp.ok) {
    const wm = (await wmResp.json()) as { repo: string; lastPolledAt: string };
    since = wm.lastPolledAt;
  }

  console.log(
    `Polling ${repo}${since ? ` since ${since}` : " (initial sync)"}`,
  );

  // Record poll start time before fetching (to avoid missing updates during fetch)
  const pollStartTime = new Date().toISOString();

  // Fetch issues from GitHub API (with per-run page cap)
  const { issues, capped } = await fetchAllIssues(
    repo,
    env.GITHUB_TOKEN,
    since,
    MAX_PAGES_PER_RUN,
  );

  if (issues.length === 0) {
    console.log(`No updates for ${repo}`);
    // Still update watermark to move forward
    await storeStub.fetch(
      new Request("http://store/watermark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, lastPolledAt: pollStartTime }),
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

  // Update watermark after successful processing
  await storeStub.fetch(
    new Request("http://store/watermark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, lastPolledAt: nextWatermark }),
    }),
  );

  console.log(
    `${repo}: ${stats.processed} processed, ${stats.embedded} embedded, ${stats.skipped} unchanged, ${stats.failed} failed`,
  );
}

/**
 * Main scheduled handler — called by Cron Trigger every 5 minutes.
 * Polls all configured repositories for issue/PR updates.
 */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
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
  }
}
