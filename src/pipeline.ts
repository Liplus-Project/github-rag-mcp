/**
 * Shared embedding pipeline — reusable by both the cron poller and webhook handler.
 *
 * Provides per-item embedding + upsert functions for issues/PRs, releases, and docs.
 * The cron poller calls these in a batch loop; the webhook handler calls them for
 * individual items as events arrive.
 */

import type {
  Env,
  IssueRecord,
  ReleaseRecord,
  DocRecord,
  DiffRecord,
  DiffFileStatus,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────

/** Maximum characters for embedding input (BGE-M3 context limit ~8192 tokens, conservative char limit) */
export const MAX_EMBEDDING_INPUT_CHARS = 8000;

/**
 * Maximum number of inputs per Workers AI batch embed call.
 * Cloudflare Workers AI does not publish a hard cap on batched embedding inputs,
 * so we split large commits into multiple calls. 20 × 8000 chars ≈ 160k chars per
 * call keeps payload size comfortably inside observed request limits.
 */
export const MAX_EMBEDDING_BATCH_SIZE = 20;

/**
 * Maximum number of vectors per single Vectorize.upsert call.
 * We mirror MAX_EMBEDDING_BATCH_SIZE so each embed batch maps 1:1 onto one upsert.
 */
export const MAX_VECTORIZE_UPSERT_BATCH_SIZE = 20;

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

/**
 * Generate embeddings for multiple text inputs in one batched Workers AI call.
 * Input order is preserved in the returned array.
 *
 * Workers AI does not publish a hard limit on the number of inputs per call,
 * so callers must chunk by MAX_EMBEDDING_BATCH_SIZE before invoking this
 * function. Throws if the returned vector count does not match the input count.
 */
export async function generateEmbeddingBatch(
  ai: Ai,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const result = await ai.run("@cf/baai/bge-m3", { text: texts });
  const vectors = (result as { data: Array<number[]> }).data;

  if (!vectors || vectors.length !== texts.length) {
    throw new Error(
      `Workers AI returned ${vectors?.length ?? 0} vectors for ${texts.length} inputs`,
    );
  }
  return vectors;
}

// ── Vector ID builders ───────────────────────────────────────
//
// Vectorize enforces a 64-byte cap on vector IDs. The previous scheme embedded
// the repo name + path/tag/sha as plain text and overflowed for long paths
// (e.g. `owner/repo#doc-docs/long-filename.md` hit 74 bytes). We now derive a
// deterministic fixed-length ID by hashing the scheme parts with SHA-256 and
// encoding as base64url (43 chars). A short type prefix preserves surface
// separation and keeps the total under 46 bytes, well inside the 64-byte cap.
//
// Per-surface prefixes:
//   "i" — issue / pull request
//   "d" — doc
//   "r" — release
//   "c" — commit diff (file inside a commit)

/**
 * Encode an arbitrary string to URL-safe base64 (RFC 4648 §5) without padding.
 * Retained because `stableVectorId` uses it to encode the SHA-256 digest.
 */
export function base64UrlEncode(input: string): string {
  // Encode UTF-8 -> binary string -> base64 via btoa
  const utf8Bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Encode raw bytes as URL-safe base64 (RFC 4648 §5) without padding.
 * Used to render the SHA-256 digest directly without going through UTF-8.
 */
function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Build a deterministic fixed-length Vectorize vector ID from a type prefix and
 * an ordered list of string parts. Parts are joined with a NUL separator (0x00)
 * so that no legitimate component can forge a collision across surfaces.
 *
 * Output format: `{prefix}:{base64url(sha256(part1\0part2\0...))}`
 * Output length: 1–2 byte prefix + 1 byte separator + 43 byte digest = 45–46 bytes.
 */
async function stableVectorId(
  prefix: string,
  ...parts: string[]
): Promise<string> {
  const input = parts.join("\u0000");
  const bytes = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const digest = base64UrlEncodeBytes(new Uint8Array(hashBuffer));
  return `${prefix}:${digest}`;
}

/**
 * Build Vectorize vector ID from repo and issue number.
 * Deterministic SHA-256-based ID under the "i" prefix.
 */
export function vectorId(repo: string, number: number): Promise<string> {
  return stableVectorId("i", repo, String(number));
}

/**
 * Build Vectorize vector ID for a release.
 * Deterministic SHA-256-based ID under the "r" prefix.
 */
export function releaseVectorId(
  repo: string,
  tagName: string,
): Promise<string> {
  return stableVectorId("r", repo, tagName);
}

/**
 * Build Vectorize vector ID for a document.
 * Deterministic SHA-256-based ID under the "d" prefix.
 */
export function docVectorId(repo: string, path: string): Promise<string> {
  return stableVectorId("d", repo, path);
}

/**
 * Build Vectorize vector ID for a commit diff (one file inside one commit).
 * Deterministic SHA-256-based ID under the "c" prefix.
 */
export function diffVectorId(
  repo: string,
  commitSha: string,
  filePath: string,
): Promise<string> {
  return stableVectorId("c", repo, commitSha, filePath);
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
  /** Whether Vectorize metadata was updated without re-embedding (state/labels/assignees change) */
  metadataUpdated: boolean;
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
  let existing: IssueRecord | null = null;
  if (existingResp.ok) {
    existing = (await existingResp.json()) as IssueRecord;
    if (existing.bodyHash === bodyHash) {
      needsEmbedding = false;
    }
  }

  if (!needsEmbedding) {
    // Hash matched — skip embedding but update IssueStore (metadata may have changed)
    const labelNames = issue.labels.map((l) => l.name);
    const assigneeLogins = issue.assignees.map((a) => a.login);
    const milestoneTitle = issue.milestone?.title ?? "";

    const record: IssueRecord = {
      repo,
      number: issue.number,
      type,
      state: issue.state,
      title,
      labels: labelNames,
      milestone: milestoneTitle,
      assignees: assigneeLogins,
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

    // Check if metadata changed — if so, update Vectorize metadata too
    // (Vectorize state/labels/assignees must stay in sync with GitHub)
    const sortedLabels = [...labelNames].sort();
    const metadataChanged = existing !== null && (
      existing.state !== issue.state ||
      existing.title !== title ||
      [...existing.labels].sort().join(",") !== sortedLabels.join(",") ||
      existing.milestone !== milestoneTitle ||
      [...existing.assignees].sort().join(",") !== [...assigneeLogins].sort().join(",")
    );

    if (metadataChanged) {
      try {
        // Retrieve existing vector values to re-upsert with updated metadata
        const vid = await vectorId(repo, issue.number);
        const vectors = await env.VECTORIZE.getByIds([vid]);

        if (vectors.length > 0 && vectors[0].values) {
          const metadata: Record<string, string | number> = {
            repo,
            number: issue.number,
            type,
            state: issue.state,
            labels: sortedLabels.join(","),
            milestone: milestoneTitle,
            assignees: assigneeLogins.join(","),
            updated_at: issue.updated_at,
            label_0: sortedLabels[0] ?? "",
            label_1: sortedLabels[1] ?? "",
            label_2: sortedLabels[2] ?? "",
            label_3: sortedLabels[3] ?? "",
            assignee_0: assigneeLogins[0] ?? "",
            assignee_1: assigneeLogins[1] ?? "",
          };

          await env.VECTORIZE.upsert([
            {
              id: vid,
              values: vectors[0].values as number[],
              metadata,
            },
          ]);

          return { embedded: false, skippedUnchanged: false, metadataUpdated: true, failed: false };
        }
      } catch (err) {
        console.error(
          `Failed to update Vectorize metadata for ${repo}#${issue.number}:`,
          err instanceof Error ? err.message : String(err),
        );
        // IssueStore was already updated — Vectorize metadata will catch up on next body change
      }
    }

    return { embedded: false, skippedUnchanged: true, metadataUpdated: false, failed: false };
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

    const vid = await vectorId(repo, issue.number);
    await env.VECTORIZE.upsert([
      {
        id: vid,
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
    metadataUpdated: false,
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

    return { embedded: false, skippedUnchanged: true, metadataUpdated: false, failed: false };
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

    const rvid = await releaseVectorId(repo, release.tag_name);
    await env.VECTORIZE.upsert([
      {
        id: rvid,
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
    metadataUpdated: false,
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
    const dvid = await docVectorId(repo, path);
    await env.VECTORIZE.upsert([
      {
        id: dvid,
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

    return { embedded: true, skippedUnchanged: false, metadataUpdated: false, failed: false };
  } catch (err) {
    console.error(
      `Failed to embed doc ${repo}/${path}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { embedded: false, skippedUnchanged: false, metadataUpdated: false, failed: true };
  }
}

// ── Commit diff surface ──────────────────────────────────────

/** GitHub API commit detail response — subset needed for diff indexing */
export interface GitHubCommitDetail {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string | null; email?: string | null; date?: string | null } | null;
    committer?: { date?: string | null } | null;
  };
  author?: { login?: string | null } | null;
  files?: Array<{
    filename: string;
    status: string;
    patch?: string;
    sha?: string;
    previous_filename?: string;
  }>;
}

/** Result of a commit diff batch upsert */
export interface DiffUpsertResult {
  /** Number of file-in-commit entries successfully embedded and upserted */
  embedded: number;
  /** Number of file-in-commit entries skipped (no patch available, e.g., binary) */
  skipped: number;
  /** Number of file-in-commit entries that failed to embed/upsert */
  failed: number;
  /** Number of Workers AI batch calls issued (for observability) */
  batches: number;
}

/**
 * Normalise GitHub's file status string to our DiffFileStatus union.
 * Unknown values fall through to "changed" (the generic GitHub bucket).
 */
function normaliseFileStatus(status: string): DiffFileStatus {
  switch (status) {
    case "added":
    case "modified":
    case "removed":
    case "renamed":
    case "copied":
    case "changed":
    case "unchanged":
      return status;
    default:
      return "changed";
  }
}

/**
 * Build the embedding input for a single file-in-commit.
 * Format: "{commitMessage}\n\n{filePath}\n\n{patch}", truncated to MAX_EMBEDDING_INPUT_CHARS.
 * The file path is included inline so semantic search can match against it
 * even when the patch body alone does not mention it.
 */
export function prepareDiffEmbeddingInput(
  commitMessage: string,
  filePath: string,
  patch: string,
): string {
  const text = `${commitMessage}\n\n${filePath}\n\n${patch}`;
  if (text.length <= MAX_EMBEDDING_INPUT_CHARS) return text;
  return text.slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

/**
 * Process and upsert a commit's per-file diffs: one vector per (commit × file).
 *
 * Flow:
 *   1. Filter `files[]` to those with a textual `patch` (binary / oversized files are skipped).
 *   2. Build embedding inputs = commit message + file path + patch, truncated.
 *   3. Batch-embed inputs via Workers AI (chunked by MAX_EMBEDDING_BATCH_SIZE).
 *   4. Upsert all vectors into Vectorize in the same chunks.
 *   5. Record DiffRecord rows into the Durable Object store for each indexed file.
 *
 * Failures inside a chunk do not halt subsequent chunks — counts are tallied and
 * returned so the caller can log/escalate without losing partial progress.
 *
 * @param env - Worker env bindings (AI, VECTORIZE)
 * @param storeStub - Durable Object stub for IssueStore
 * @param repo - Repository in "owner/repo" format
 * @param commit - Commit detail from GitHub (from GET /repos/{repo}/commits/{sha})
 * @returns Summary of embeddings/upserts produced
 */
export async function processAndUpsertCommitDiff(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  commit: GitHubCommitDetail,
): Promise<DiffUpsertResult> {
  const commitSha = commit.sha;
  const commitMessage = commit.commit.message ?? "";
  const commitDate =
    commit.commit.author?.date ??
    commit.commit.committer?.date ??
    new Date().toISOString();
  const commitAuthor =
    commit.author?.login ?? commit.commit.author?.name ?? "";
  const files = commit.files ?? [];
  const now = new Date().toISOString();

  // Keep only files with a textual patch. Binary blobs, submodule changes, and
  // oversized diffs arrive without a patch field and cannot be embedded.
  const indexable = files.filter(
    (f): f is typeof f & { patch: string } =>
      typeof f.patch === "string" && f.patch.length > 0,
  );
  const skipped = files.length - indexable.length;

  if (indexable.length === 0) {
    return { embedded: 0, skipped, failed: 0, batches: 0 };
  }

  let embedded = 0;
  let failed = 0;
  let batches = 0;

  // Chunk to respect Workers AI / Vectorize batch limits.
  for (let offset = 0; offset < indexable.length; offset += MAX_EMBEDDING_BATCH_SIZE) {
    const chunk = indexable.slice(offset, offset + MAX_EMBEDDING_BATCH_SIZE);
    batches++;

    const inputs = chunk.map((f) =>
      prepareDiffEmbeddingInput(commitMessage, f.filename, f.patch),
    );

    let embeddings: number[][];
    try {
      embeddings = await generateEmbeddingBatch(env.AI, inputs);
    } catch (err) {
      console.error(
        `Failed to batch-embed diffs for ${repo}@${commitSha} chunk offset ${offset}:`,
        err instanceof Error ? err.message : String(err),
      );
      failed += chunk.length;
      continue;
    }

    // Vector IDs are async (SHA-256 digest). Generate them in parallel so the
    // chunk still maps to a single Vectorize.upsert call below.
    const vectors = await Promise.all(
      chunk.map(async (f, i) => {
        const fileStatus = normaliseFileStatus(f.status);
        const blobShaAfter = f.sha ?? "";
        // GitHub's files API does not return the previous blob SHA directly —
        // we leave it empty for now. blob_sha_after is enough to locate the
        // post-commit object; history lookup can use the commit SHA itself.
        const blobShaBefore = "";

        const metadata: Record<string, string | number> = {
          repo,
          number: 0,
          type: "diff",
          state: "active",
          labels: "",
          milestone: "",
          assignees: "",
          updated_at: commitDate,
          commit_sha: commitSha,
          file_path: f.filename,
          file_status: fileStatus,
          commit_date: commitDate,
          commit_author: commitAuthor,
          blob_sha_before: blobShaBefore,
          blob_sha_after: blobShaAfter,
        };

        return {
          id: await diffVectorId(repo, commitSha, f.filename),
          values: embeddings[i],
          metadata,
        };
      }),
    );

    try {
      await env.VECTORIZE.upsert(vectors);
    } catch (err) {
      console.error(
        `Failed to upsert diff vectors for ${repo}@${commitSha} chunk offset ${offset}:`,
        err instanceof Error ? err.message : String(err),
      );
      failed += chunk.length;
      continue;
    }

    // Record store rows for each successfully upserted file. We issue these
    // sequentially (the DO is single-threaded per stub anyway) and swallow
    // individual failures — the Vectorize upsert has already landed, so the
    // search surface is correct even if a store insert is lost.
    for (let i = 0; i < chunk.length; i++) {
      const f = chunk[i];
      const fileStatus = normaliseFileStatus(f.status);
      const record: DiffRecord = {
        repo,
        commitSha,
        filePath: f.filename,
        fileStatus,
        commitDate,
        commitAuthor,
        blobShaBefore: null,
        blobShaAfter: f.sha ?? null,
        indexedAt: now,
      };

      try {
        await storeStub.fetch(
          new Request("http://store/upsert-diff", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(record),
          }),
        );
      } catch (err) {
        console.error(
          `Failed to record diff row for ${repo}@${commitSha}/${f.filename}:`,
          err instanceof Error ? err.message : String(err),
        );
        // Do not count as failed: Vectorize already has the vector.
      }
    }

    embedded += chunk.length;
  }

  return { embedded, skipped, failed, batches };
}
