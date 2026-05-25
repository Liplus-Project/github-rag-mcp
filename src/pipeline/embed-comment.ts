/**
 * Comment / review ingest pipelines (issue comments, PR reviews, PR inline review comments).
 *
 * Each surface has its own GitHub API shape and `ingestX` function but they
 * share a common skeleton: bot / short-body filter, hash-based change
 * detection, embed + Vectorize upsert, FTS5 mirror write, IssueStore record.
 * `CommentUpsertResult` covers all three.
 */

import type {
  Env,
  IssueCommentRecord,
  PRReviewRecord,
  PRReviewCommentRecord,
} from "../types.js";
import { upsertFtsRow } from "../fts.js";
import { isBotSender, isBodyTooShort } from "./ingest-filter.js";
import { computeBodyHash, prepareCommentEmbeddingInput } from "./hash.js";
import { generateEmbedding } from "./embedding.js";
import {
  issueCommentVectorId,
  prReviewVectorId,
  prReviewCommentVectorId,
} from "./vector-id.js";

/** GitHub API issue/PR comment shape (subset we need) */
export interface GitHubCommentData {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

/** GitHub API PR review shape (subset we need) */
export interface GitHubPRReviewData {
  id: number;
  body: string | null;
  user: { login: string } | null;
  state: string;
  submitted_at: string | null;
}

/** GitHub API PR inline review comment shape (subset we need) */
export interface GitHubPRReviewCommentData {
  id: number;
  body: string | null;
  user: { login: string } | null;
  path: string | null;
  line: number | null;
  original_line?: number | null;
  commit_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Result of a comment / review ingest operation */
export interface CommentUpsertResult {
  embedded: boolean;
  skippedUnchanged: boolean;
  /** True when the item was filtered out (bot author or body too short). */
  filtered: boolean;
  failed: boolean;
}

/**
 * Process and upsert a single issue/PR top-level comment.
 *
 * Flow mirrors processAndUpsertIssue: bot / short-body filter, hash-based
 * change detection, embedding, Vectorize upsert, FTS5 upsert, IssueStore record.
 */
export async function ingestIssueComment(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  parentNumber: number,
  comment: GitHubCommentData,
): Promise<CommentUpsertResult> {
  const author = comment.user?.login ?? "";
  const body = comment.body ?? "";

  if (isBotSender(author) || isBodyTooShort(body)) {
    return { embedded: false, skippedUnchanged: false, filtered: true, failed: false };
  }

  const bodyHash = await computeBodyHash(author, body);

  // Change detection: compare stored hash
  const existingResp = await storeStub.fetch(
    new Request(
      `http://store/comment?repo=${encodeURIComponent(repo)}&comment_id=${comment.id}`,
    ),
  );
  if (existingResp.ok) {
    const existing = (await existingResp.json()) as IssueCommentRecord;
    if (existing.bodyHash === bodyHash) {
      return { embedded: false, skippedUnchanged: true, filtered: false, failed: false };
    }
  }

  const embeddingInput = prepareCommentEmbeddingInput(author, body);

  let embeddingSucceeded = false;
  try {
    const embedding = await generateEmbedding(env.AI, embeddingInput);

    const metadata: Record<string, string | number> = {
      repo,
      number: parentNumber,
      type: "issue_comment",
      state: "active",
      labels: "",
      milestone: "",
      assignees: "",
      updated_at: comment.updated_at,
      author,
      comment_id: comment.id,
    };

    const vid = await issueCommentVectorId(repo, comment.id);
    await env.VECTORIZE.upsert([{ id: vid, values: embedding, metadata }]);

    try {
      await upsertFtsRow(env.DB_FTS, {
        vectorId: vid,
        repo,
        type: "issue_comment",
        state: "active",
        labels: "",
        milestone: "",
        assignees: "",
        updatedAt: comment.updated_at,
        number: parentNumber,
        content: embeddingInput,
      });
    } catch (ftsErr) {
      console.error(
        `Failed to upsert FTS5 row for comment ${repo}#${comment.id}:`,
        ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
      );
    }

    embeddingSucceeded = true;
  } catch (err) {
    console.error(
      `Failed to embed comment ${repo}#${comment.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const record: IssueCommentRecord = {
    repo,
    commentId: comment.id,
    number: parentNumber,
    author,
    bodyHash: embeddingSucceeded ? bodyHash : "",
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };

  await storeStub.fetch(
    new Request("http://store/upsert-comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    }),
  );

  return {
    embedded: embeddingSucceeded,
    skippedUnchanged: false,
    filtered: false,
    failed: !embeddingSucceeded,
  };
}

/**
 * Process and upsert a single PR review (approve / request_changes / comment body).
 *
 * Reviews without a body (approve-only, no prose) pass the min-length
 * filter and are skipped. Reviews with meaningful prose go through the
 * normal embed + upsert flow.
 */
export async function ingestPRReview(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  parentNumber: number,
  review: GitHubPRReviewData,
): Promise<CommentUpsertResult> {
  const author = review.user?.login ?? "";
  const body = review.body ?? "";

  if (isBotSender(author) || isBodyTooShort(body)) {
    return { embedded: false, skippedUnchanged: false, filtered: true, failed: false };
  }

  const bodyHash = await computeBodyHash(author + "\n\n" + review.state, body);

  const existingResp = await storeStub.fetch(
    new Request(
      `http://store/review?repo=${encodeURIComponent(repo)}&review_id=${review.id}`,
    ),
  );
  if (existingResp.ok) {
    const existing = (await existingResp.json()) as PRReviewRecord;
    if (existing.bodyHash === bodyHash) {
      return { embedded: false, skippedUnchanged: true, filtered: false, failed: false };
    }
  }

  const submittedAt = review.submitted_at ?? new Date().toISOString();
  const embeddingInput = prepareCommentEmbeddingInput(author, body);

  let embeddingSucceeded = false;
  try {
    const embedding = await generateEmbedding(env.AI, embeddingInput);

    const metadata: Record<string, string | number> = {
      repo,
      number: parentNumber,
      type: "pr_review",
      // Store the GitHub review state verbatim (APPROVED / CHANGES_REQUESTED / COMMENTED ...)
      state: review.state,
      labels: "",
      milestone: "",
      assignees: "",
      updated_at: submittedAt,
      author,
      review_id: review.id,
    };

    const vid = await prReviewVectorId(repo, review.id);
    await env.VECTORIZE.upsert([{ id: vid, values: embedding, metadata }]);

    try {
      await upsertFtsRow(env.DB_FTS, {
        vectorId: vid,
        repo,
        type: "pr_review",
        state: review.state,
        labels: "",
        milestone: "",
        assignees: "",
        updatedAt: submittedAt,
        number: parentNumber,
        content: embeddingInput,
      });
    } catch (ftsErr) {
      console.error(
        `Failed to upsert FTS5 row for PR review ${repo}#${review.id}:`,
        ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
      );
    }

    embeddingSucceeded = true;
  } catch (err) {
    console.error(
      `Failed to embed PR review ${repo}#${review.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const record: PRReviewRecord = {
    repo,
    reviewId: review.id,
    number: parentNumber,
    author,
    state: review.state,
    bodyHash: embeddingSucceeded ? bodyHash : "",
    submittedAt,
    updatedAt: submittedAt,
  };

  await storeStub.fetch(
    new Request("http://store/upsert-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    }),
  );

  return {
    embedded: embeddingSucceeded,
    skippedUnchanged: false,
    filtered: false,
    failed: !embeddingSucceeded,
  };
}

/**
 * Process and upsert a single PR inline review comment (per-line diff comment).
 *
 * Inline comments carry extra diff context: file path, line, commit SHA.
 * We surface these in the Vectorize metadata and FTS5 row so query-time
 * filters can narrow to a specific file or commit.
 */
export async function ingestPRReviewComment(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  parentNumber: number,
  comment: GitHubPRReviewCommentData,
): Promise<CommentUpsertResult> {
  const author = comment.user?.login ?? "";
  const body = comment.body ?? "";

  if (isBotSender(author) || isBodyTooShort(body)) {
    return { embedded: false, skippedUnchanged: false, filtered: true, failed: false };
  }

  // Line numbers can be null (outdated) or appear on original_line only; fall back.
  const line = comment.line ?? comment.original_line ?? 0;
  const filePath = comment.path ?? "";
  const commitId = comment.commit_id ?? "";

  const bodyHash = await computeBodyHash(
    `${author}\n${filePath}:${line}`,
    body,
  );

  const existingResp = await storeStub.fetch(
    new Request(
      `http://store/review-comment?repo=${encodeURIComponent(repo)}&comment_id=${comment.id}`,
    ),
  );
  if (existingResp.ok) {
    const existing = (await existingResp.json()) as PRReviewCommentRecord;
    if (existing.bodyHash === bodyHash) {
      return { embedded: false, skippedUnchanged: true, filtered: false, failed: false };
    }
  }

  const embeddingInput = prepareCommentEmbeddingInput(author, body);

  let embeddingSucceeded = false;
  try {
    const embedding = await generateEmbedding(env.AI, embeddingInput);

    const metadata: Record<string, string | number> = {
      repo,
      number: parentNumber,
      type: "pr_review_comment",
      state: "active",
      labels: "",
      milestone: "",
      assignees: "",
      updated_at: comment.updated_at,
      author,
      comment_id: comment.id,
      file_path: filePath,
      line,
      commit_sha: commitId,
    };

    const vid = await prReviewCommentVectorId(repo, comment.id);
    await env.VECTORIZE.upsert([{ id: vid, values: embedding, metadata }]);

    try {
      await upsertFtsRow(env.DB_FTS, {
        vectorId: vid,
        repo,
        type: "pr_review_comment",
        state: "active",
        labels: "",
        milestone: "",
        assignees: "",
        updatedAt: comment.updated_at,
        number: parentNumber,
        filePath,
        commitSha: commitId,
        content: embeddingInput,
      });
    } catch (ftsErr) {
      console.error(
        `Failed to upsert FTS5 row for PR review comment ${repo}#${comment.id}:`,
        ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
      );
    }

    embeddingSucceeded = true;
  } catch (err) {
    console.error(
      `Failed to embed PR review comment ${repo}#${comment.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const record: PRReviewCommentRecord = {
    repo,
    commentId: comment.id,
    number: parentNumber,
    author,
    filePath,
    line,
    commitId,
    bodyHash: embeddingSucceeded ? bodyHash : "",
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };

  await storeStub.fetch(
    new Request("http://store/upsert-review-comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    }),
  );

  return {
    embedded: embeddingSucceeded,
    skippedUnchanged: false,
    filtered: false,
    failed: !embeddingSucceeded,
  };
}
