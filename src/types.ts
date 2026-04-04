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

/** Polling watermark per repository */
export interface PollWatermark {
  repo: string;
  lastPolledAt: string;
}

/** Metadata stored alongside vectors in Vectorize */
export interface VectorMetadata {
  repo: string;
  number: number;
  type: "issue" | "pull_request";
  state: "open" | "closed";
  labels: string;
  milestone: string;
  assignees: string;
  updated_at: string;
}

/** Env bindings for the Worker */
export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  ISSUE_STORE: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  VECTORIZE: Vectorize;
  AI: Ai;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}
