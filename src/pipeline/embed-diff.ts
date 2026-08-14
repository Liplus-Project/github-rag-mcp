/**
 * Commit diff embedding + upsert pipeline.
 *
 * Owns the GitHub commit-detail shape, the `fetchCommitDetail` REST helper,
 * the file-status normaliser, and `processAndUpsertCommitDiff` which produces
 * one vector per (commit × file) using Workers AI batch embed under the "c"
 * prefix. Failures inside one chunk do not halt subsequent chunks.
 */

import type { Env, DiffRecord, DiffFileStatus } from "../types.js";
import { upsertFtsRow } from "../fts.js";
import { prepareDiffEmbeddingInput } from "./hash.js";
import {
  generateEmbeddingBatch,
  planEmbeddingBatches,
} from "./embedding.js";
import { diffVectorId } from "./vector-id.js";

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
  /** Files the caller's `indexedFilePaths` set already listed, so this call left
   *  them alone. Zero when the caller passed no resume set. */
  alreadyIndexed: number;
  /** Files with a patch, not in the resume set, that `maxFiles` kept this call
   *  from attempting. Non-zero means the commit is *partially* indexed and the
   *  caller must not treat it as done. Zero when the caller set no bound. */
  deferred: number;
}

/** Bounds a single `processAndUpsertCommitDiff` call. Both fields absent = index
 *  every file with a patch, which is what the webhook path wants: it handles one
 *  push per invocation and has the whole subrequest budget to itself. */
export interface DiffUpsertOptions {
  /** Upper bound on files this call indexes. Files past it are reported as
   *  `deferred` rather than dropped — the caller resumes them on a later run. */
  maxFiles?: number;
  /** File paths already on the index for this commit. Passing them is what makes
   *  a bounded call *resume* instead of re-indexing the same prefix forever. */
  indexedFilePaths?: ReadonlySet<string>;
}

/**
 * Fetch a single commit with per-file patches via the GitHub REST API.
 * Returns the commit detail including `files[]` with inline `patch` fields.
 * Throws on non-2xx responses. Shared between webhook (new-commit path) and
 * poller (historical backfill path).
 */
export async function fetchCommitDetail(
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
 * Process and upsert a commit's per-file diffs: one vector per (commit × file).
 *
 * Flow:
 *   1. Filter `files[]` to those with a textual `patch` (binary / oversized files are skipped).
 *   2. Drop files the caller's `indexedFilePaths` resume set already lists, then
 *      take at most `options.maxFiles` of what remains.
 *   3. Build embedding inputs = commit message + file path + patch, truncated.
 *   4. Batch-embed inputs via Workers AI (chunked by `planEmbeddingBatches`, which
 *      splits on a character budget rather than a file count).
 *   5. Upsert all vectors into Vectorize in the same chunks.
 *   6. Record DiffRecord rows into the Durable Object store for each indexed file.
 *
 * Failures inside a chunk do not halt subsequent chunks — counts are tallied and
 * returned so the caller can log/escalate without losing partial progress.
 *
 * `maxFiles` splits a commit across runs; it never thins one. Every file with a
 * patch is either indexed by this call or counted in `deferred` for the caller to
 * resume, and the two step 2 filters are what make repeated calls converge:
 * without the resume set a bounded call re-indexes the same prefix every run and
 * the commit never finishes (issue #238).
 *
 * @param env - Worker env bindings (AI, VECTORIZE)
 * @param storeStub - Durable Object stub for IssueStore
 * @param repo - Repository in "owner/repo" format
 * @param commit - Commit detail from GitHub (from GET /repos/{repo}/commits/{sha})
 * @param options - Per-call file bound and resume set; unbounded when omitted
 * @returns Summary of embeddings/upserts produced
 */
export async function processAndUpsertCommitDiff(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  commit: GitHubCommitDetail,
  options: DiffUpsertOptions = {},
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
  const withPatch = files.filter(
    (f): f is typeof f & { patch: string } =>
      typeof f.patch === "string" && f.patch.length > 0,
  );
  const skipped = files.length - withPatch.length;

  // Resume: an earlier run of a split commit already landed these.
  const indexedPaths = options.indexedFilePaths;
  const pending = indexedPaths
    ? withPatch.filter((f) => !indexedPaths.has(f.filename))
    : withPatch;
  const alreadyIndexed = withPatch.length - pending.length;

  // Bound what this call attempts. The remainder is reported, not dropped.
  const limit = Math.max(0, options.maxFiles ?? pending.length);
  const indexable = pending.slice(0, limit);
  const deferred = pending.length - indexable.length;

  if (indexable.length === 0) {
    return { embedded: 0, skipped, failed: 0, batches: 0, alreadyIndexed, deferred };
  }

  let embedded = 0;
  let failed = 0;
  let batches = 0;

  const allInputs = indexable.map((f) =>
    prepareDiffEmbeddingInput(commitMessage, f.filename, f.patch),
  );

  // Chunk on the character total of the inputs, not on how many files the commit
  // touched. A file count bounds a call only if every patch is assumed to be
  // small, and a commit that breaks that assumption used to fail the whole chunk —
  // which the poller reads as an uningested commit and holds the diff watermark on,
  // so the surface stalls there rather than skipping past it (#236). Characters
  // rather than estimated tokens because the estimate ran 2.1x low on diff patches
  // and let the same two commits over the ceiling three cron cycles running (#241).
  for (const { start, end } of planEmbeddingBatches(allInputs)) {
    const chunk = indexable.slice(start, end);
    const inputs = allInputs.slice(start, end);
    batches++;

    let embeddings: number[][];
    try {
      embeddings = await generateEmbeddingBatch(env.AI, inputs);
    } catch (err) {
      console.error(
        `Failed to batch-embed diffs for ${repo}@${commitSha} chunk offset ${start}:`,
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
        `Failed to upsert diff vectors for ${repo}@${commitSha} chunk offset ${start}:`,
        err instanceof Error ? err.message : String(err),
      );
      failed += chunk.length;
      continue;
    }

    // Mirror each diff into D1 FTS5 (trigram tokenizer via tokenizer_kind='code').
    // Failures are logged but do not invalidate the successful Vectorize upsert —
    // the dense side still surfaces the vector, and the next reindex can catch up.
    for (let i = 0; i < chunk.length; i++) {
      const f = chunk[i];
      const v = vectors[i];
      try {
        await upsertFtsRow(env.DB_FTS, {
          vectorId: v.id,
          repo,
          type: "diff",
          state: "active",
          labels: "",
          milestone: "",
          assignees: "",
          updatedAt: commitDate,
          commitSha,
          filePath: f.filename,
          fileStatus: normaliseFileStatus(f.status),
          commitDate,
          commitAuthor,
          content: inputs[i],
        });
      } catch (ftsErr) {
        // Keep the high-level line for log searchability, then surface the underlying
        // D1 error shape on a second line so the next cron run produces actionable
        // context (error name, vector_id, content/path sizes). See #135.
        console.error(
          `Failed to upsert FTS5 row for diff ${repo}@${commitSha}/${f.filename}:`,
          ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
        );
        console.error(
          `FTS5 diff upsert detail (#135):`,
          JSON.stringify({
            errorName: ftsErr instanceof Error ? ftsErr.name : typeof ftsErr,
            vectorId: v.id,
            tokenizerKind: "code",
            contentChars: inputs[i].length,
            filePathChars: f.filename.length,
            fileStatus: normaliseFileStatus(f.status),
            commitSha,
            repo,
          }),
        );
      }
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

  return { embedded, skipped, failed, batches, alreadyIndexed, deferred };
}
