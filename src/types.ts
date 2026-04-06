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
}
