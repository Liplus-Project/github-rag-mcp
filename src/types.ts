/**
 * Common type definitions for github-rag-mcp
 */

/** Stored issue/PR record in Durable Object SQLite */
export interface IssueRecord {
  repo: string;
  number: number;
  type: "issue" | "pull_request";
  state: "open" | "closed";
  title: string;
  labels: string[];
  milestone: string;
  assignees: string[];
  bodyHash: string;
  createdAt: string;
  updatedAt: string;
}

/** Stored release record in Durable Object SQLite */
export interface ReleaseRecord {
  repo: string;
  tagName: string;
  name: string;
  body: string;
  prerelease: boolean;
  bodyHash: string;
  createdAt: string;
  publishedAt: string;
}

/** Stored document record in Durable Object SQLite */
export interface DocRecord {
  repo: string;
  path: string;
  blobSha: string;
  updatedAt: string;
}

/**
 * Stored wiki page record in Durable Object SQLite.
 *
 * GitHub Wiki content lives in a separate git repo (`{repo}.wiki.git`) and is
 * not exposed through the GitHub REST API. We enumerate pages by scraping the
 * `/{repo}/wiki/_pages` HTML index and fetch raw content via
 * `https://raw.githubusercontent.com/wiki/{repo}/master/{page}.{ext}`.
 *
 * `pageName` matches the GitHub Wiki page identifier (URL slug, dash-separated
 * for spaces). `extension` records which markup file extension actually serves
 * the page so subsequent polls can hit the right raw URL directly without
 * trying every supported extension. `contentHash` is a SHA-256 over the raw
 * content body and drives change detection (no git blob SHA is available
 * without invoking the git smart-HTTP protocol).
 */
export interface WikiDocRecord {
  repo: string;
  pageName: string;
  extension: string;
  contentHash: string;
  updatedAt: string;
}

/**
 * Stored top-level comment record (issues + PRs) in Durable Object SQLite.
 * `number` is the parent issue or PR number (issues and PRs share the same number space).
 */
export interface IssueCommentRecord {
  repo: string;
  commentId: number;
  number: number;
  author: string;
  bodyHash: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Stored PR review record (approve / request_changes / comment bodies).
 * `state` carries the GitHub review state enum verbatim.
 */
export interface PRReviewRecord {
  repo: string;
  reviewId: number;
  number: number;
  author: string;
  /** GitHub review state: APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string;
  bodyHash: string;
  submittedAt: string;
  updatedAt: string;
}

/**
 * Stored PR inline review comment record (per-line comments on a diff).
 * `filePath` / `line` pinpoint the diff location; `commitId` ties the
 * comment to the reviewed commit SHA.
 */
export interface PRReviewCommentRecord {
  repo: string;
  commentId: number;
  number: number;
  author: string;
  filePath: string;
  line: number;
  commitId: string;
  bodyHash: string;
  createdAt: string;
  updatedAt: string;
}

/** File change status reported by GitHub for a file inside a commit */
export type DiffFileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

/** Stored commit diff record in Durable Object SQLite (one row per file-in-commit) */
export interface DiffRecord {
  repo: string;
  commitSha: string;
  filePath: string;
  fileStatus: DiffFileStatus;
  commitDate: string;
  commitAuthor: string;
  blobShaBefore: string | null;
  blobShaAfter: string | null;
  indexedAt: string;
}

/** Polling watermark per repository */
export interface PollWatermark {
  repo: string;
  lastPolledAt: string;
  /** ETag from GitHub API for conditional requests (page 1 only) */
  etag?: string;
}

/** Metadata stored alongside vectors in Vectorize */
export interface VectorMetadata {
  repo: string;
  number: number;
  type:
    | "issue"
    | "pull_request"
    | "release"
    | "doc"
    | "wiki_doc"
    | "diff"
    | "issue_comment"
    | "pr_review"
    | "pr_review_comment";
  state: string;
  labels: string;
  milestone: string;
  assignees: string;
  updated_at: string;
  /** Release tag name (releases only) */
  tag_name?: string;
  /** Document file path (docs only) */
  doc_path?: string;
  /** Wiki page name / slug (wiki_doc only) */
  wiki_path?: string;
  /** Wiki page file extension (wiki_doc only, e.g., "md", "markdown", "org", "rst") */
  wiki_extension?: string;
  /** Commit SHA (diffs only) */
  commit_sha?: string;
  /** File path inside the commit (diffs only) */
  file_path?: string;
  /** File change status (diffs only) */
  file_status?: DiffFileStatus;
  /** Commit date ISO 8601 (diffs only) */
  commit_date?: string;
  /** Commit author login (diffs only) */
  commit_author?: string;
  /** Git blob SHA before the commit, empty when file was added (diffs only) */
  blob_sha_before?: string;
  /** Git blob SHA after the commit, empty when file was removed (diffs only) */
  blob_sha_after?: string;
  /** Comment / review author login (comments + reviews + review comments only) */
  author?: string;
  /** GitHub comment id (issue_comment + pr_review_comment only) */
  comment_id?: number;
  /** GitHub review id (pr_review only) */
  review_id?: number;
  /** Review-comment inline line number (pr_review_comment only) */
  line?: number;
  /**
   * Expanded label fields for Vectorize pre-filtering (first 4 labels, sorted).
   * Empty string when slot is unused.
   *
   * Limitation: Vectorize filters only support AND between fields, not OR.
   * A query like `label_0 = "bug" OR label_1 = "bug"` cannot be expressed.
   * These fields are stored for future Vectorize improvements and to support
   * the overfetch+post-filter strategy that improves recall.
   */
  label_0?: string;
  label_1?: string;
  label_2?: string;
  label_3?: string;
  /**
   * Expanded assignee fields for Vectorize pre-filtering (first 2 assignees).
   * Empty string when slot is unused.
   *
   * Same AND-only limitation as labels — see label_0 comment.
   */
  assignee_0?: string;
  assignee_1?: string;
}

/** Env bindings for the Worker */
export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  ISSUE_STORE: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  VECTORIZE: Vectorize;
  /** D1 database for full-text search (sparse side of hybrid retrieval, BM25 via FTS5) */
  DB_FTS: D1Database;
  AI: Ai;
  /** GitHub App OAuth client ID (set via `wrangler secret put`) */
  GITHUB_CLIENT_ID: string;
  /** GitHub App OAuth client secret (set via `wrangler secret put`) */
  GITHUB_CLIENT_SECRET: string;
  /** GitHub personal access token or installation token for API access (set via `wrangler secret put`) */
  GITHUB_TOKEN: string;
  /** Comma-separated list of repos to poll, e.g. "owner/repo1,owner/repo2" */
  POLL_REPOS: string;
  /** GitHub webhook secret for HMAC-SHA256 signature verification (set via `wrangler secret put`) */
  GITHUB_WEBHOOK_SECRET: string;
}
