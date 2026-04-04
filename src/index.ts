/**
 * Cloudflare Worker entrypoint for github-rag-mcp
 *
 * Durable Objects:
 *   RagMcpAgent  — MCP server (tools: search_issues, get_issue_context, list_recent_activity)
 *   IssueStore   — Issue/PR state store (SQLite-backed)
 *
 * Cron Trigger:
 *   Every 5 minutes — poll GitHub API for issue/PR updates, generate embeddings, upsert vectors
 *
 * OAuth:
 *   GitHub App OAuth 2.1 (same pattern as github-webhook-mcp)
 */

import type { Env } from "./types.js";

// Durable Object: issue/PR state store (SQLite-backed)
export { IssueStore } from "./store.js";

// Durable Object stub — implementation in subsequent sub-issues
export class RagMcpAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    return new Response("RagMcpAgent: not yet implemented", { status: 501 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // TODO: OAuth provider wrapping (sub-issue #5)
    // TODO: MCP endpoint routing (sub-issue #4)

    return new Response("github-rag-mcp: not yet implemented", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // TODO: Cron poller implementation (sub-issue #6)
    // Poll GitHub API for issue/PR updates since last watermark
    // Generate embeddings via Workers AI (BGE-M3)
    // Upsert vectors into Vectorize
    // Update structured state in IssueStore DO
    console.log("Cron trigger fired:", controller.cron, new Date(controller.scheduledTime).toISOString());
  },
} satisfies ExportedHandler<Env>;
