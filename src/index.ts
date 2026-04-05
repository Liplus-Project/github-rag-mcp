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
 *   GET /oauth/authorize  -- Start GitHub OAuth flow
 *   GET /oauth/callback   -- GitHub OAuth callback
 *
 * Durable Objects:
 *   RagMcpAgent  -- MCP server (tools: search_issues, get_issue_context, list_recent_activity)
 *   IssueStore   -- Issue/PR state store (SQLite-backed)
 *
 * Cron Trigger:
 *   Every 5 minutes -- poll GitHub API for issue/PR updates, generate embeddings, upsert vectors
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
import { RagMcpAgent } from "./mcp.js";

// Durable Object: issue/PR state store (SQLite-backed)
export { IssueStore } from "./store.js";

// Durable Object: MCP server (tools: search_issues, get_issue_context, list_recent_activity)
export { RagMcpAgent } from "./mcp.js";

// McpAgent.serve() returns a fetch handler for MCP protocol.
// It reads ctx.props (set by OAuthProvider) and passes them to the DO.
const mcpHandler = RagMcpAgent.serve("/mcp");

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

    // -- MCP endpoint (OAuth-protected, ctx.props set by OAuthProvider) --
    if (url.pathname.startsWith("/mcp")) {
      const props = (ctx as unknown as { props: GitHubUserProps }).props;
      if (!props?.githubUserId) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Rewrite ctx.props to McpProps shape expected by RagMcpAgent.
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
