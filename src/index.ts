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
 *   POST /admin/diff-watermark?repo=owner/repo&since=ISO8601[&phase=forward|backfill] -- Rewind the commit-diff poller watermark (requires GITHUB_TOKEN header)
 *   POST /admin/backfill-fts-segments[?repo=owner/repo][&cursor=N][&limit=N] -- Re-segment one batch of natural-language FTS rows (requires GITHUB_TOKEN header)
 *   POST /admin/backfill-wiki?repo=owner/repo[&limit=N][&cursor=SLUG] -- Walk one batch of a repo's wiki without waiting for the :45 cron (requires GITHUB_TOKEN header)
 *   POST /admin/purge-legacy-vectors?repo=owner/repo[&dry_run=true][&surface=doc][&limit=N][&cursor=N] -- Delete pre-migration doc vectors the reap cannot name (requires GITHUB_TOKEN header)
 *   POST /admin/backfill-issue-state?repo=owner/repo[&dry_run=true][&limit=N][&cursor=N] -- Close indexed issue/PR rows GitHub no longer lists as open (requires GITHUB_TOKEN header)
 *
 * Durable Objects:
 *   RagMcpAgentV2  -- MCP server (tools: search, get_issue_context, list_recent_activity)
 *   IssueStore   -- Issue/PR/wiki state store (SQLite-backed)
 *
 * Cron Trigger:
 *   Hourly (fallback) -- poll GitHub API for issue/PR updates, generate embeddings, upsert vectors
 */

import type { Env } from "./types.js";
import {
  createOAuthProvider,
  handleAuthorize,
  handleGitHubCallback,
  readGitHubProps,
  readOAuthHelpers,
  writeMcpProps,
} from "./oauth.js";
import { handleScheduled, pollWiki } from "./poller.js";
import { handleWebhook } from "./webhook.js";
import { RagMcpAgentV2 } from "./mcp.js";
import { indexWikiEdges } from "./graph.js";
import { backfillNatSegments } from "./fts.js";
import {
  DEFAULT_PURGE_LIMIT,
  MAX_PURGE_LIMIT,
  purgeLegacyDocVectors,
} from "./purge-legacy.js";
import {
  DEFAULT_ISSUE_STATE_LIMIT,
  MAX_ISSUE_STATE_LIMIT,
  backfillIssueState,
} from "./backfill-issue-state.js";

// Durable Object: issue/PR state store (SQLite-backed)
export { IssueStore } from "./store.js";

// Durable Object: MCP server — legacy stub (retained for migration compatibility only).
export { RagMcpAgent } from "./mcp.js";

// Durable Object: MCP server (tools: search, get_issue_context, list_recent_activity)
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

    // -- Admin: backfill graph edges for a repo's already-indexed wiki pages --
    // POST /admin/backfill-edges?repo=owner/repo  (requires GITHUB_TOKEN header)
    // Re-extracts mention edges from each wiki_doc row's stored content (no GitHub
    // refetch) and writes them to doc_edges. One-off after deploy; live indexing
    // keeps edges current thereafter.
    if (request.method === "POST" && url.pathname === "/admin/backfill-edges") {
      const authHeader = request.headers.get("GITHUB_TOKEN");
      if (!authHeader || authHeader !== env.GITHUB_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const repo = url.searchParams.get("repo");
      if (!repo) {
        return new Response("missing repo query parameter", { status: 400 });
      }

      let pages = 0;
      let edges = 0;
      try {
        const rows = await env.DB_FTS
          .prepare(
            `SELECT vector_id, doc_path, content FROM search_docs WHERE type = 'wiki_doc' AND repo = ?`,
          )
          .bind(repo)
          .all<{ vector_id: string; doc_path: string; content: string }>();
        for (const r of rows.results ?? []) {
          const n = await indexWikiEdges(
            env.DB_FTS,
            repo,
            String(r.doc_path ?? ""),
            String(r.vector_id ?? ""),
            String(r.content ?? ""),
          );
          pages++;
          edges += n;
        }
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ repo, wikiPagesProcessed: pages, edgesWritten: edges }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // -- Admin: re-segment the natural-language FTS rows (one batch per call) --
    // POST /admin/backfill-fts-segments[?repo=owner/repo][&cursor=N][&limit=N]
    // Migration 0006 seeds `content_fts` with a copy of the raw content because the
    // Intl.Segmenter split only exists in JS. This walks the nat rows in rowid order
    // and rewrites the ones that are still unsegmented. Call it repeatedly, passing
    // the returned `nextCursor` back, until `done` is true. Safe to restart from the
    // beginning: rows already segmented are skipped without a write.
    // Requires GITHUB_TOKEN header for authentication.
    if (request.method === "POST" && url.pathname === "/admin/backfill-fts-segments") {
      const authHeader = request.headers.get("GITHUB_TOKEN");
      if (!authHeader || authHeader !== env.GITHUB_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const repo = url.searchParams.get("repo") ?? undefined;

      const rawCursor = url.searchParams.get("cursor");
      const cursor = rawCursor === null ? 0 : Number(rawCursor);
      if (!Number.isInteger(cursor) || cursor < 0) {
        return new Response("cursor must be a non-negative integer", { status: 400 });
      }

      // Capped because each row carries up to MAX_EMBEDDING_INPUT_CHARS of text and
      // every rewrite fans out to the FTS5 index through the UPDATE trigger.
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return new Response("limit must be an integer in 1..200", { status: 400 });
      }

      try {
        const result = await backfillNatSegments(env.DB_FTS, { limit, cursor, repo });
        return new Response(
          JSON.stringify({
            repo: repo ?? null,
            cursor,
            limit,
            scanned: result.scanned,
            updated: result.updated,
            nextCursor: result.nextCursor,
            done: result.nextCursor === null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // -- Admin: walk one batch of a repo's wiki immediately --
    // POST /admin/backfill-wiki?repo=owner/repo[&limit=N][&cursor=SLUG]
    // The `:45` cron reaches every page eventually (the poller resumes from a
    // stored cursor), but a fresh index or a bulk wiki import would take
    // ceil(pages / 20) hours to land. This runs the same poll pass on demand
    // with an explicit fetch budget, sharing the cron's cursor so the two
    // advance one another. Call it repeatedly until `done` is true — `done`
    // means the cursor completed a lap of the enumeration, which takes
    // ceil(pages / limit) calls rather than one (issue #188). Passing
    // `cursor=` (empty) restarts the walk *and the lap* at the head.
    // Each call is its own Worker invocation, hence its own subrequest budget.
    // Requires GITHUB_TOKEN header for authentication.
    if (request.method === "POST" && url.pathname === "/admin/backfill-wiki") {
      const authHeader = request.headers.get("GITHUB_TOKEN");
      if (!authHeader || authHeader !== env.GITHUB_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const repo = url.searchParams.get("repo");
      if (!repo) {
        return new Response("missing repo query parameter", { status: 400 });
      }

      // Bounded for the same reason the cron cap exists: every fetch spends
      // one of the invocation's 1000 subrequests, and each changed page fans
      // out further through embed + Vectorize + D1 + store (issue #130).
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 20 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 40) {
        return new Response("limit must be an integer in 1..40", { status: 400 });
      }

      // Absent = continue from the stored cursor. Present (even empty) = start
      // the walk there, so `cursor=` means "restart from the head".
      const cursor = url.searchParams.get("cursor") ?? undefined;

      const storeId = env.ISSUE_STORE.idFromName("global");
      const storeStub = env.ISSUE_STORE.get(storeId);
      try {
        const summary = await pollWiki(repo, env, storeStub, {
          fetchBudget: limit,
          cursor,
        });
        return new Response(
          JSON.stringify({ ...summary, done: summary.wrapped }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // -- Admin: move a commit-diff poller watermark (gap recovery / stall release) --
    // POST /admin/diff-watermark?repo=owner/repo&since=2026-07-06T00:00:00Z[&phase=forward|backfill]
    // Rewinds (or advances) the diff poller's watermark so the next `:30` cron
    // re-covers the period from `since`. The forward phase then walks that
    // period oldest-first, MAX_DIFF_COMMITS_FORWARD_PER_RUN commits per run,
    // without skipping anything (issue #178).
    // Requires GITHUB_TOKEN header for authentication.
    if (request.method === "POST" && url.pathname === "/admin/diff-watermark") {
      const authHeader = request.headers.get("GITHUB_TOKEN");
      if (!authHeader || authHeader !== env.GITHUB_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const repo = url.searchParams.get("repo");
      if (!repo) {
        return new Response("missing repo query parameter", { status: 400 });
      }

      const since = url.searchParams.get("since");
      if (!since) {
        return new Response("missing since query parameter", { status: 400 });
      }
      const sinceTime = Date.parse(since);
      if (Number.isNaN(sinceTime)) {
        return new Response("since is not a parseable timestamp", { status: 400 });
      }
      const lastPolledAt = new Date(sinceTime).toISOString();

      const phase = url.searchParams.get("phase") ?? "forward";
      if (phase !== "forward" && phase !== "backfill") {
        return new Response("phase must be forward or backfill", { status: 400 });
      }
      const key = phase === "backfill" ? `diffs_backfill:${repo}` : `diffs:${repo}`;

      const storeId = env.ISSUE_STORE.idFromName("global");
      const storeStub = env.ISSUE_STORE.get(storeId);
      const storeResp = await storeStub.fetch(
        new Request("http://store/watermark", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: key, lastPolledAt }),
        }),
      );
      if (!storeResp.ok) {
        return new Response(
          JSON.stringify({ error: await storeResp.text() }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ repo, phase, watermarkKey: key, lastPolledAt }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // -- Admin: purge pre-migration doc vectors that no delete path can name --
    // POST /admin/purge-legacy-vectors?repo=owner/repo[&dry_run=true][&surface=doc][&limit=N][&cursor=N]
    // Body (optional): {"paths": ["path/one.md", ...]} — files already gone from
    // the tree, whose legacy IDs nothing left in the worker can enumerate.
    // Rebuilds the pre-`215e2e2` ID (`{repo}#doc-{path}`) for each candidate path
    // and deletes it. No re-embedding: this is a cleanup, not a rebuild
    // (issue #204).
    // Requires GITHUB_TOKEN header for authentication.
    if (request.method === "POST" && url.pathname === "/admin/purge-legacy-vectors") {
      const authHeader = request.headers.get("GITHUB_TOKEN");
      if (!authHeader || authHeader !== env.GITHUB_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const repo = url.searchParams.get("repo");
      if (!repo) {
        return new Response("missing repo query parameter", { status: 400 });
      }

      // doc is the only surface with confirmed legacy orphans. The migration
      // changed every surface's ID scheme, but `updated_at` means something
      // different per type, so the other surfaces could not be judged from the
      // observed data — they stay out of scope until measured (issue #204).
      const surface = url.searchParams.get("surface") ?? "doc";
      if (surface !== "doc") {
        return new Response(
          "surface must be doc — the only surface with confirmed legacy orphans",
          { status: 400 },
        );
      }

      const dryRun = url.searchParams.get("dry_run") === "true";

      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? DEFAULT_PURGE_LIMIT : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PURGE_LIMIT) {
        return new Response(`limit must be an integer in 1..${MAX_PURGE_LIMIT}`, {
          status: 400,
        });
      }

      const rawCursor = url.searchParams.get("cursor");
      const cursor = rawCursor === null ? 0 : Number(rawCursor);
      if (!Number.isInteger(cursor) || cursor < 0) {
        return new Response("cursor must be a non-negative integer", { status: 400 });
      }

      let paths: string[] = [];
      const rawBody = await request.text();
      if (rawBody.trim() !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          return new Response("body must be JSON when present", { status: 400 });
        }
        const candidate = (parsed as { paths?: unknown }).paths;
        if (candidate !== undefined) {
          if (
            !Array.isArray(candidate) ||
            candidate.some((p) => typeof p !== "string" || p === "")
          ) {
            return new Response("paths must be an array of non-empty strings", {
              status: 400,
            });
          }
          paths = candidate as string[];
        }
      }

      try {
        const summary = await purgeLegacyDocVectors(repo, env, {
          dryRun,
          limit,
          cursor,
          paths,
        });
        return new Response(JSON.stringify(summary), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // -- Admin: close indexed issue / PR rows GitHub no longer lists as open --
    // POST /admin/backfill-issue-state?repo=owner/repo[&dry_run=true][&limit=N][&cursor=N]
    // Repairs rows indexed while the item was open, whose state mirror never landed
    // (issue #209). No embedding: the state comes from one `state=open` listing, the
    // sparse side is an UPDATE, and the dense side re-upserts the existing values with
    // only `state` replaced. `/admin/reset-hashes` cannot be used for this — it would
    // trigger a full re-embedding of the repo.
    // Call repeatedly, passing the returned `nextCursor` back, until `done` is true.
    // Requires GITHUB_TOKEN header for authentication.
    if (request.method === "POST" && url.pathname === "/admin/backfill-issue-state") {
      const authHeader = request.headers.get("GITHUB_TOKEN");
      if (!authHeader || authHeader !== env.GITHUB_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const repo = url.searchParams.get("repo");
      if (!repo) {
        return new Response("missing repo query parameter", { status: 400 });
      }

      const dryRun = url.searchParams.get("dry_run") === "true";

      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? DEFAULT_ISSUE_STATE_LIMIT : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ISSUE_STATE_LIMIT) {
        return new Response(`limit must be an integer in 1..${MAX_ISSUE_STATE_LIMIT}`, {
          status: 400,
        });
      }

      const rawCursor = url.searchParams.get("cursor");
      const cursor = rawCursor === null ? 0 : Number(rawCursor);
      if (!Number.isInteger(cursor) || cursor < 0) {
        return new Response("cursor must be a non-negative integer", { status: 400 });
      }

      try {
        const summary = await backfillIssueState(repo, env, { dryRun, limit, cursor });
        return new Response(JSON.stringify(summary), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // -- MCP endpoint (OAuth-protected, ctx.props set by OAuthProvider) --
    if (url.pathname.startsWith("/mcp")) {
      const props = readGitHubProps(ctx);
      if (!props?.githubUserId) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Rewrite ctx.props to McpProps shape expected by RagMcpAgentV2.
      // Pass the GitHub access token so the agent can make API calls.
      writeMcpProps(ctx, {
        githubUserId: props.githubUserId,
        githubLogin: props.githubLogin,
        accessToken: props.githubAccessToken,
      });

      return mcpHandler.fetch(request, env, ctx);
    }

    // -- OAuth authorize (redirect to GitHub) --
    if (url.pathname === "/oauth/authorize") {
      return handleAuthorize(request, env, readOAuthHelpers(env));
    }

    // -- OAuth callback (GitHub redirects back here) --
    if (url.pathname === "/oauth/callback") {
      return handleGitHubCallback(request, env, readOAuthHelpers(env));
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
const oauthWrapped = createOAuthProvider(innerHandler);

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    oauthWrapped.fetch(req, env, ctx),
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(controller, env, ctx);
  },
};
