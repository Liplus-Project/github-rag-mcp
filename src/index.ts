/**
 * Cloudflare Worker entrypoint for github-rag-mcp
 *
 * Routes (handled by OAuthProvider wrapper):
 *   /.well-known/oauth-authorization-server -- RFC 8414 metadata discovery
 *   /oauth/register  -- RFC 7591 dynamic client registration
 *   /oauth/token     -- Token issuance and refresh
 *
 * Routes (OAuth-protected API, validated by OAuthProvider):
 *   POST /mcp  -- MCP server (Streamable HTTP MCP protocol)
 *
 * Routes (defaultHandler, no OAuth token required):
 *   POST /webhooks/github -- GitHub webhook receiver (IP allowlist + signature verification)
 *   GET /oauth/authorize  -- Start GitHub OAuth flow
 *   GET /oauth/callback   -- GitHub OAuth callback
 *   POST /admin/reset-hashes?repo=owner/repo  -- Reset hashes and watermarks to trigger full re-embedding (requires GITHUB_TOKEN header)
 *
 * Durable Objects:
 *   RagMcpAgentV2  -- MCP server (tools: search_issues, get_issue_context, list_recent_activity)
 *   IssueStore   -- Issue/PR state store (SQLite-backed)
 *
 * Cron Trigger:
 *   Hourly (fallback) -- poll GitHub API for issue/PR updates, generate embeddings, upsert vectors
 */

import type { Env } from "./types.js";
import {
  createOAuthProvider,
  handleAuthorize,
  handleGitHubCallback,
  type OAuthEnv,
  type GitHubUserProps,
} from "./oauth.js";
import { handleScheduled } from "./poller.js";
import { handleWebhook } from "./webhook.js";
import { RagMcpAgentV2 } from "./mcp.js";

// Durable Object: issue/PR state store (SQLite-backed)
export { IssueStore } from "./store.js";

// Durable Object: MCP server (tools: search_issues, get_issue_context, list_recent_activity)
export { RagMcpAgentV2 } from "./mcp.js";

// McpAgent.serve() returns a fetch handler for MCP protocol.
// It reads ctx.props (set by OAuthProvider) and passes them to the DO.
const mcpHandler = RagMcpAgentV2.serve("/mcp");

/**
 * Inner handler -- processes requests after OAuthProvider routing.
 *
 * For API routes (/mcp): OAuthProvider has already validated the
 * access token and set ctx.props with GitHubUserProps.
 *
 * For default routes: OAuthProvider passes through without token validation.
 * env.OAUTH_PROVIDER is set with OAuthHelpers for the authorize/callback flow.
 */
const innerHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // -- GitHub webhook receiver (IP allowlist + signature verification) --
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      return handleWebhook(request, env);
    }

    // -- Admin: reset hashes and watermarks to trigger full re-embedding on next cron --
    // POST /admin/reset-hashes?repo=owner/repo
    // Resets: issue body_hash, release body_hash, docs (deleted), watermarks, and
    //         D1 FTS5 search_docs rows for the repo.
    // Requires GITHUB_TOKEN header for authentication.
    if (request.method === "POST" && url.pathname === "/admin/reset-hashes") {
      const authHeader = request.headers.get("GITHUB_TOKEN");
      if (!authHeader || authHeader !== env.GITHUB_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const repo = url.searchParams.get("repo");
      if (!repo) {
        return new Response("missing repo query parameter", { status: 400 });
      }

      // Proxy to IssueStore Durable Object POST /reset-hashes
      const storeId = env.ISSUE_STORE.idFromName("global");
      const storeStub = env.ISSUE_STORE.get(storeId);
      const storeResp = await storeStub.fetch(
        new Request(
          `http://store/reset-hashes?repo=${encodeURIComponent(repo)}`,
          { method: "POST" },
        ),
      );
      const storeBody = await storeResp.text();

      // Also clear the D1 FTS5 sparse index for this repo. The delete trigger on
      // search_docs fans out to the FTS5 virtual tables automatically.
      let ftsDeleted = 0;
      try {
        const ftsResult = await env.DB_FTS
          .prepare(`DELETE FROM search_docs WHERE repo = ?`)
          .bind(repo)
          .run();
        ftsDeleted = ftsResult.meta?.changes ?? 0;
      } catch (err) {
        console.error(
          `Failed to clear D1 FTS5 rows for ${repo}:`,
          err instanceof Error ? err.message : String(err),
        );
      }

      // Merge the FTS5 reset count into the JSON response when possible.
      let mergedBody: string = storeBody;
      try {
        const parsed = JSON.parse(storeBody) as Record<string, unknown>;
        parsed.ftsRowsDeleted = ftsDeleted;
        mergedBody = JSON.stringify(parsed);
      } catch {
        // storeBody was not JSON — just return it verbatim.
      }

      return new Response(mergedBody, {
        status: storeResp.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // -- MCP endpoint (OAuth-protected, ctx.props set by OAuthProvider) --
    if (url.pathname.startsWith("/mcp")) {
      const props = (ctx as unknown as { props: GitHubUserProps }).props;
      if (!props?.githubUserId) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Rewrite ctx.props to McpProps shape expected by RagMcpAgentV2.
      // Pass the GitHub access token so the agent can make API calls.
      (ctx as unknown as { props: { githubUserId: number; githubLogin: string; accessToken: string } }).props = {
        githubUserId: props.githubUserId,
        githubLogin: props.githubLogin,
        accessToken: props.githubAccessToken,
      };

      return mcpHandler.fetch(request, env, ctx);
    }

    // -- OAuth authorize (redirect to GitHub) --
    if (url.pathname === "/oauth/authorize") {
      const oauthHelpers = (
        env as unknown as { OAUTH_PROVIDER: Parameters<typeof handleAuthorize>[2] }
      ).OAUTH_PROVIDER;
      return handleAuthorize(request, env, oauthHelpers);
    }

    // -- OAuth callback (GitHub redirects back here) --
    if (url.pathname === "/oauth/callback") {
      const oauthHelpers = (
        env as unknown as { OAUTH_PROVIDER: Parameters<typeof handleGitHubCallback>[2] }
      ).OAUTH_PROVIDER;
      return handleGitHubCallback(request, env, oauthHelpers);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(controller, env, ctx);
  },
};

// OAuthProvider wraps the inner handler, adding OAuth endpoints
// and protecting /mcp route with access token validation.
// Note: OAuthProvider only wraps fetch. We re-export scheduled separately.
const oauthWrapped = createOAuthProvider(
  innerHandler as unknown as ExportedHandler<OAuthEnv & Record<string, unknown>>,
);

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    oauthWrapped.fetch(req, env as unknown as OAuthEnv & Record<string, unknown>, ctx),
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(controller, env, ctx);
  },
};
