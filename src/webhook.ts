/**
 * GitHub webhook receiver — signature verification, IP allowlist, and event routing.
 *
 * Verifies incoming webhook requests using HMAC-SHA256 signature
 * and GitHub IP allowlist, then routes to per-event handlers for
 * issues, pull requests, releases, and push (docs) events.
 */

import type { Env } from "./types.js";
import { isGitHubWebhookIP } from "./github-ip.js";
import {
  processAndUpsertIssue,
  processAndUpsertRelease,
  processAndUpsertDoc,
  processAndUpsertCommitDiff,
  vectorId,
  releaseVectorId,
  docVectorId,
  type GitHubIssueData,
  type GitHubReleaseData,
  type GitHubCommitDetail,
} from "./pipeline.js";

/**
 * Verify GitHub webhook signature using WebCrypto HMAC-SHA256.
 *
 * Compares the X-Hub-Signature-256 header value against the
 * computed HMAC of the request body.
 */
export async function verifyGitHubSignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return expected === signature;
}

/**
 * Handle incoming GitHub webhook request.
 *
 * Auth chain: IP allowlist -> signature verification -> event routing.
 * Routes to per-event handlers for issues, PRs, releases, and push events.
 * Unknown event types return 202 with `action: "ignored"`.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  // 1. IP allowlist check
  const ipAllowed = await isGitHubWebhookIP(request);
  if (!ipAllowed) {
    return new Response("Forbidden", { status: 403 });
  }

  // 2. Signature verification
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const signature = request.headers.get("X-Hub-Signature-256");
  if (!signature) {
    return new Response("Missing signature", { status: 401 });
  }

  const body = await request.text();
  const valid = await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, body, signature);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  // 3. Parse event and route to handler
  const eventType = request.headers.get("X-GitHub-Event") ?? "unknown";
  const payload = JSON.parse(body);

  // Obtain IssueStore Durable Object stub
  const storeId = env.ISSUE_STORE.idFromName("global");
  const storeStub = env.ISSUE_STORE.get(storeId);

  switch (eventType) {
    case "issues":
    case "pull_request":
      return handleIssueOrPREvent(eventType, payload, env, storeStub);
    case "release":
      return handleReleaseEvent(payload, env, storeStub);
    case "push":
      return handlePushEvent(payload, env, storeStub);
    default:
      return jsonResponse(202, {
        received: true,
        event: eventType,
        action: "ignored",
      });
  }
}

// ── Helpers ──────────────────────────────────────────────────

/** Build a JSON response with the given status and body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Check whether a file path matches the doc file pattern.
 * Matches all .md files in the repository.
 */
function isDocFile(path: string): boolean {
  return path.endsWith(".md");
}

/**
 * Fetch file content via GitHub Contents API.
 * Returns decoded UTF-8 text. Mirrors the poller implementation.
 */
async function fetchFileContent(
  repo: string,
  path: string,
  token: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;

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
    const text = await resp.text();
    throw new Error(`GitHub Contents API error ${resp.status} for ${path}: ${text}`);
  }

  const data = (await resp.json()) as { content: string; encoding: string };
  if (data.encoding !== "base64") {
    throw new Error(`Unexpected encoding ${data.encoding} for ${path}`);
  }

  const binary = atob(data.content.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Fetch a commit with per-file patches via the GitHub REST API.
 * Returns the commit detail including `files[]` with inline `patch` fields.
 * Throws on non-2xx responses.
 */
async function fetchCommitDetail(
  repo: string,
  sha: string,
  token: string,
): Promise<GitHubCommitDetail> {
  const url = `https://api.github.com/repos/${repo}/commits/${sha}`;

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
    const text = await resp.text();
    throw new Error(
      `GitHub Commits API error ${resp.status} for ${repo}@${sha}: ${text}`,
    );
  }

  return (await resp.json()) as GitHubCommitDetail;
}

// ── Per-event handlers ──────────────────────────────────────

/**
 * Handle `issues.*` and `pull_request.*` webhook events.
 *
 * For deleted events: removes the vector from Vectorize.
 * For all other actions: upserts via the shared pipeline.
 */
async function handleIssueOrPREvent(
  eventType: "issues" | "pull_request",
  payload: Record<string, unknown>,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<Response> {
  const action = payload.action as string;
  const repo = (payload.repository as { full_name: string }).full_name;

  // Extract the issue/PR object — key differs by event type
  const raw = eventType === "pull_request"
    ? (payload.pull_request as Record<string, unknown>)
    : (payload.issue as Record<string, unknown>);

  const number = raw.number as number;

  // Handle deletion: remove vector and acknowledge
  if (action === "deleted") {
    try {
      await env.VECTORIZE.deleteByIds([vectorId(repo, number)]);
    } catch (err) {
      console.error(
        `Failed to delete vector ${vectorId(repo, number)}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return jsonResponse(202, {
      received: true,
      event: eventType,
      action,
      repo,
      number,
      result: "deleted",
    });
  }

  // Map webhook payload to GitHubIssueData shape expected by pipeline
  const issueData: GitHubIssueData = {
    number,
    title: raw.title as string,
    body: (raw.body as string | null) ?? null,
    state: raw.state as "open" | "closed",
    labels: ((raw.labels as Array<{ name: string }>) ?? []),
    milestone: (raw.milestone as { title: string } | null) ?? null,
    assignees: ((raw.assignees as Array<{ login: string }>) ?? []),
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
    pull_request: eventType === "pull_request"
      ? { url: (raw.url as string) }
      : (raw.pull_request as { url: string } | undefined),
    html_url: raw.html_url as string,
  };

  const result = await processAndUpsertIssue(env, storeStub, repo, issueData);

  return jsonResponse(202, {
    received: true,
    event: eventType,
    action,
    repo,
    number,
    result: {
      embedded: result.embedded,
      skippedUnchanged: result.skippedUnchanged,
      metadataUpdated: result.metadataUpdated,
      failed: result.failed,
    },
  });
}

/**
 * Handle `release.*` webhook events.
 *
 * For deleted events: removes the vector from Vectorize.
 * For all other actions: upserts via the shared pipeline.
 */
async function handleReleaseEvent(
  payload: Record<string, unknown>,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<Response> {
  const action = payload.action as string;
  const repo = (payload.repository as { full_name: string }).full_name;
  const raw = payload.release as Record<string, unknown>;
  const tagName = raw.tag_name as string;

  // Handle deletion
  if (action === "deleted") {
    try {
      await env.VECTORIZE.deleteByIds([releaseVectorId(repo, tagName)]);
    } catch (err) {
      console.error(
        `Failed to delete release vector ${releaseVectorId(repo, tagName)}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return jsonResponse(202, {
      received: true,
      event: "release",
      action,
      repo,
      tagName,
      result: "deleted",
    });
  }

  const releaseData: GitHubReleaseData = {
    id: raw.id as number,
    tag_name: tagName,
    name: (raw.name as string | null) ?? null,
    body: (raw.body as string | null) ?? null,
    prerelease: (raw.prerelease as boolean) ?? false,
    created_at: raw.created_at as string,
    published_at: (raw.published_at as string | null) ?? null,
    html_url: raw.html_url as string,
  };

  const result = await processAndUpsertRelease(env, storeStub, repo, releaseData);

  return jsonResponse(202, {
    received: true,
    event: "release",
    action,
    repo,
    tagName,
    result: {
      embedded: result.embedded,
      skippedUnchanged: result.skippedUnchanged,
      metadataUpdated: result.metadataUpdated,
      failed: result.failed,
    },
  });
}

/**
 * Handle `push` webhook events — processes doc file changes.
 *
 * Only processes pushes to the default branch.
 * Filters commit file lists for `docs/**\/*.md` and `README.md`.
 * Added/modified files are fetched and embedded; removed files are deleted.
 */
async function handlePushEvent(
  payload: Record<string, unknown>,
  env: Env,
  storeStub: DurableObjectStub,
): Promise<Response> {
  const repo = (payload.repository as { full_name: string; default_branch: string }).full_name;
  const defaultBranch = (payload.repository as { default_branch: string }).default_branch;
  const ref = payload.ref as string;

  // Only process pushes to the default branch
  if (ref !== `refs/heads/${defaultBranch}`) {
    return jsonResponse(202, {
      received: true,
      event: "push",
      action: "ignored",
      reason: "non-default branch",
      ref,
    });
  }

  // Collect unique file paths from all commits, categorised by change type
  const commits = (payload.commits as Array<{
    id?: string;
    added: string[];
    modified: string[];
    removed: string[];
  }>) ?? [];

  const addedOrModified = new Set<string>();
  const removed = new Set<string>();

  for (const commit of commits) {
    for (const path of commit.added) {
      if (isDocFile(path)) {
        addedOrModified.add(path);
        removed.delete(path);     // override earlier removal
      }
    }
    for (const path of commit.modified) {
      if (isDocFile(path)) {
        addedOrModified.add(path);
        removed.delete(path);
      }
    }
    for (const path of commit.removed) {
      if (isDocFile(path)) {
        removed.add(path);
        addedOrModified.delete(path);  // override earlier add
      }
    }
  }

  // ── Per-commit diff indexing ────────────────────────────────
  // Runs alongside the .md live-doc path above. Each commit becomes N vectors
  // (one per file-with-patch). Failures on one commit do not interrupt the
  // others — counts are aggregated into the response.
  let diffsEmbedded = 0;
  let diffsSkipped = 0;
  let diffsFailed = 0;
  let diffCommitsProcessed = 0;
  let diffCommitsFailed = 0;

  for (const commit of commits) {
    const sha = commit.id;
    if (!sha) continue;

    try {
      const detail = await fetchCommitDetail(repo, sha, env.GITHUB_TOKEN);
      const result = await processAndUpsertCommitDiff(env, storeStub, repo, detail);
      diffsEmbedded += result.embedded;
      diffsSkipped += result.skipped;
      diffsFailed += result.failed;
      diffCommitsProcessed++;
    } catch (err) {
      console.error(
        `Webhook: failed to index diff for ${repo}@${sha}:`,
        err instanceof Error ? err.message : String(err),
      );
      diffCommitsFailed++;
      // continue — other commits should still be processed
    }
  }

  // Nothing doc-related in this push — but diff indexing may still have work.
  if (addedOrModified.size === 0 && removed.size === 0) {
    return jsonResponse(202, {
      received: true,
      event: "push",
      action: diffCommitsProcessed > 0 ? "processed" : "ignored",
      reason:
        diffCommitsProcessed > 0
          ? undefined
          : "no doc file changes and no diff commits",
      repo,
      diffs: {
        commitsProcessed: diffCommitsProcessed,
        commitsFailed: diffCommitsFailed,
        filesEmbedded: diffsEmbedded,
        filesSkipped: diffsSkipped,
        filesFailed: diffsFailed,
      },
    });
  }

  let embedded = 0;
  let failed = 0;

  // Process added/modified doc files
  for (const path of addedOrModified) {
    try {
      const content = await fetchFileContent(repo, path, env.GITHUB_TOKEN);

      // Use HEAD commit SHA as blob SHA stand-in. The pipeline's
      // processAndUpsertDoc always embeds (caller decides freshness),
      // so any unique-ish value works for the record.
      const headSha = (payload.head_commit as { id: string } | null)?.id ?? "unknown";
      const result = await processAndUpsertDoc(env, storeStub, repo, path, content, headSha);

      if (result.embedded) embedded++;
      if (result.failed) failed++;
    } catch (err) {
      console.error(
        `Webhook: failed to process doc ${repo}/${path}:`,
        err instanceof Error ? err.message : String(err),
      );
      failed++;
    }
  }

  // Delete removed doc files
  let deleted = 0;
  for (const path of removed) {
    try {
      await env.VECTORIZE.deleteByIds([docVectorId(repo, path)]);
      await storeStub.fetch(
        new Request(
          `http://store/doc?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
          { method: "DELETE" },
        ),
      );
      deleted++;
    } catch (err) {
      console.error(
        `Webhook: failed to delete doc vector ${repo}/${path}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return jsonResponse(202, {
    received: true,
    event: "push",
    action: "processed",
    repo,
    docs: {
      addedOrModified: addedOrModified.size,
      removed: removed.size,
      embedded,
      deleted,
      failed,
    },
    diffs: {
      commitsProcessed: diffCommitsProcessed,
      commitsFailed: diffCommitsFailed,
      filesEmbedded: diffsEmbedded,
      filesSkipped: diffsSkipped,
      filesFailed: diffsFailed,
    },
  });
}
