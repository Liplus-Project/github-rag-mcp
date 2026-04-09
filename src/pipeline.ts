/**
 * Shared embedding pipeline — reusable by both the cron poller and webhook handler.
 *
 * Provides per-item embedding + upsert functions for issues/PRs, releases, and docs.
 * The cron poller calls these in a batch loop; the webhook handler calls them for
 * individual items as events arrive.
 */

import type { Env, IssueRecord, ReleaseRecord, DocRecord } from "./types.js";

// ── Constants ────────────────────────────────────────────────

/** Maximum characters for embedding input (BGE-M3 context limit ~8192 tokens, conservative char limit) */
export const MAX_EMBEDDING_INPUT_CHARS = 8000;

// ── Pure utility functions ───────────────────────────────────

/**
 * Compute SHA-256 hash of title + body for change detection.
 * Returns hex-encoded hash string.
 */
export async function computeBodyHash(title: string, body: string): Promise<string> {
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
export function prepareEmbeddingInput(title: string, body: string | null): string {
  const text = title + "\n\n" + (body ?? "");
  if (text.length <= MAX_EMBEDDING_INPUT_CHARS) return text;
  return text.slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

/**
 * Generate embedding for a text input using Workers AI BGE-M3.
 * Returns 1024-dimensional float array.
 */
export async function generateEmbedding(
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

// ── Vector ID builders ───────────────────────────────────────

/**
 * Build Vectorize vector ID from repo and issue number.
 * Format: "owner/repo#123"
 */
export function vectorId(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/**
 * Build Vectorize vector ID for a release.
 * Format: "owner/repo#release-v1.0.0"
 */
export function releaseVectorId(repo: string, tagName: string): string {
  return `${repo}#release-${tagName}`;
}

/**
 * Build Vectorize vector ID for a document.
 * Format: "owner/repo#doc-docs/0-requirements.md"
 */
export function docVectorId(repo: string, path: string): string {
  return `${repo}#doc-${path}`;
}

// ── Per-item upsert functions ────────────────────────────────

/** GitHub API issue/PR response shape (subset of fields we need) */
export interface GitHubIssueData {
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

/** GitHub API release response shape (subset of fields we need) */
export interface GitHubReleaseData {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  html_url: string;
}

/** Result of a single-item upsert operation */
export interface UpsertResult {
  /** Whether embedding was generated (vs skipped because hash unchanged) */
  embedded: boolean;
  /** Whether embedding was skipped because content hash matched existing record */
  skippedUnchanged: boolean;
  /** Whether embedding failed (item stored with empty bodyHash for retry) */
  failed: boolean;
}

/**
 * Process and upsert a single issue/PR: check hash, embed if changed, upsert to Vectorize + Store.
 *
 * @param env - Worker env bindings (AI, VECTORIZE)
 * @param storeStub - Durable Object stub for IssueStore
 * @param repo - Repository in "owner/repo" format
 * @param issue - GitHub issue/PR data
 * @returns UpsertResult indicating what happened
 */
export async function processAndUpsertIssue(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  issue: GitHubIssueData,
): Promise<UpsertResult> {
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
    }
  }

  if (!needsEmbedding) {
    // Hash matched — store record (metadata may have changed) but skip embedding
    const record: IssueRecord = {
      repo,
      number: issue.number,
      type,
      state: issue.state,
      title,
      labels: issue.labels.map((l) => l.name),
      milestone: issue.milestone?.title ?? "",
      assignees: issue.assignees.map((a) => a.login),
      bodyHash,
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

    return { embedded: false, skippedUnchanged: true, failed: false };
  }

  // Content changed — generate embedding
  let embeddingSucceeded = false;
  try {
    const embeddingInput = prepareEmbeddingInput(title, issue.body);
    const embedding = await generateEmbedding(env.AI, embeddingInput);

    // Expand labels into individual metadata fields (first 4, sorted)
    // for potential Vectorize pre-filtering. Sorted order ensures deterministic
    // slot assignment across upserts.
    const labelNames = issue.labels.map((l) => l.name).sort();
    const assigneeLogins = issue.assignees.map((a) => a.login);

    const metadata: Record<string, string | number> = {
      repo,
      number: issue.number,
      type,
      state: issue.state,
      labels: labelNames.join(","),
      milestone: issue.milestone?.title ?? "",
      assignees: assigneeLogins.join(","),
      updated_at: issue.updated_at,
      // Expanded label fields (first 4, sorted alphabetically)
      label_0: labelNames[0] ?? "",
      label_1: labelNames[1] ?? "",
      label_2: labelNames[2] ?? "",
      label_3: labelNames[3] ?? "",
      // Expanded assignee fields (first 2)
      assignee_0: assigneeLogins[0] ?? "",
      assignee_1: assigneeLogins[1] ?? "",
    };

    await env.VECTORIZE.upsert([
      {
        id: vectorId(repo, issue.number),
        values: embedding,
        metadata,
      },
    ]);

    embeddingSucceeded = true;
  } catch (err) {
    console.error(
      `Failed to embed ${repo}#${issue.number}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Store record — save bodyHash only when embedding succeeded.
  // When embedding fails, store empty bodyHash so next attempt retries.
  const record: IssueRecord = {
    repo,
    number: issue.number,
    type,
    state: issue.state,
    title,
    labels: issue.labels.map((l) => l.name),
    milestone: issue.milestone?.title ?? "",
    assignees: issue.assignees.map((a) => a.login),
    bodyHash: embeddingSucceeded ? bodyHash : "",
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

  return {
    embedded: embeddingSucceeded,
    skippedUnchanged: false,
    failed: !embeddingSucceeded,
  };
}

/**
 * Process and upsert a single release: check hash, embed if changed, upsert to Vectorize + Store.
 *
 * @param env - Worker env bindings (AI, VECTORIZE)
 * @param storeStub - Durable Object stub for IssueStore
 * @param repo - Repository in "owner/repo" format
 * @param release - GitHub release data
 * @returns UpsertResult indicating what happened
 */
export async function processAndUpsertRelease(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  release: GitHubReleaseData,
): Promise<UpsertResult> {
  const body = release.body ?? "";
  const name = release.name ?? release.tag_name;
  const bodyHash = await computeBodyHash(name, body);

  // Check if release body has changed
  const existingResp = await storeStub.fetch(
    new Request(
      `http://store/release?repo=${encodeURIComponent(repo)}&tag_name=${encodeURIComponent(release.tag_name)}`,
    ),
  );

  let needsEmbedding = true;
  if (existingResp.ok) {
    const existing = (await existingResp.json()) as ReleaseRecord;
    if (existing.bodyHash === bodyHash) {
      needsEmbedding = false;
    }
  }

  if (!needsEmbedding) {
    // Hash matched — store record but skip embedding
    const record: ReleaseRecord = {
      repo,
      tagName: release.tag_name,
      name,
      body,
      prerelease: release.prerelease,
      bodyHash,
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

    return { embedded: false, skippedUnchanged: true, failed: false };
  }

  // Content changed — generate embedding
  let embeddingSucceeded = false;
  try {
    const embeddingInput = prepareEmbeddingInput(name, body);
    const embedding = await generateEmbedding(env.AI, embeddingInput);

    const metadata: Record<string, string | number> = {
      repo,
      number: 0,
      type: "release",
      state: "published",
      labels: "",
      milestone: "",
      assignees: "",
      updated_at: release.published_at ?? release.created_at,
      tag_name: release.tag_name,
    };

    await env.VECTORIZE.upsert([
      {
        id: releaseVectorId(repo, release.tag_name),
        values: embedding,
        metadata,
      },
    ]);

    embeddingSucceeded = true;
  } catch (err) {
    console.error(
      `Failed to embed release ${repo}#${release.tag_name}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Store record
  const record: ReleaseRecord = {
    repo,
    tagName: release.tag_name,
    name,
    body,
    prerelease: release.prerelease,
    bodyHash: embeddingSucceeded ? bodyHash : "",
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

  return {
    embedded: embeddingSucceeded,
    skippedUnchanged: false,
    failed: !embeddingSucceeded,
  };
}

/**
 * Process and upsert a single doc: embed content and upsert to Vectorize + Store.
 *
 * Unlike issues/releases, docs use blob SHA for change detection (handled by the caller).
 * This function always generates an embedding — the caller is responsible for determining
 * whether the doc content has changed.
 *
 * @param env - Worker env bindings (AI, VECTORIZE)
 * @param storeStub - Durable Object stub for IssueStore
 * @param repo - Repository in "owner/repo" format
 * @param path - File path within the repo (e.g. "docs/0-requirements.md")
 * @param content - Decoded file content
 * @param blobSha - Git blob SHA for this version of the file
 * @returns UpsertResult indicating what happened
 */
export async function processAndUpsertDoc(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  path: string,
  content: string,
  blobSha: string,
): Promise<UpsertResult> {
  const now = new Date().toISOString();

  try {
    // Generate embedding (use path as title, content as body)
    const embeddingInput = prepareEmbeddingInput(path, content);
    const embedding = await generateEmbedding(env.AI, embeddingInput);

    const metadata: Record<string, string | number> = {
      repo,
      number: 0,
      type: "doc",
      state: "active",
      labels: "",
      milestone: "",
      assignees: "",
      updated_at: now,
      doc_path: path,
    };

    // Upsert vector into Vectorize
    await env.VECTORIZE.upsert([
      {
        id: docVectorId(repo, path),
        values: embedding,
        metadata,
      },
    ]);

    // Upsert doc record into store
    const record: DocRecord = {
      repo,
      path,
      blobSha,
      updatedAt: now,
    };

    await storeStub.fetch(
      new Request("http://store/upsert-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }),
    );

    return { embedded: true, skippedUnchanged: false, failed: false };
  } catch (err) {
    console.error(
      `Failed to embed doc ${repo}/${path}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { embedded: false, skippedUnchanged: false, failed: true };
  }
}
