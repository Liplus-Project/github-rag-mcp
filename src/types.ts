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
  type: "issue" | "pull_request" | "release" | "doc";
  state: "open" | "closed" | "published" | "active";
  labels: string;
  milestone: string;
  assignees: string;
  updated_at: string;
  /** Release tag name (releases only) */
  tag_name?: string;
  /** Document file path (docs only) */
  doc_path?: string;
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
