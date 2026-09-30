#!/usr/bin/env node
/**
 * GitHub RAG MCP — Cloudflare Worker bridge
 *
 * Thin stdio MCP server that proxies tool calls to a remote
 * Cloudflare Worker backend. Authenticates via OAuth 2.1 with PKCE
 * (localhost callback).
 *
 * Tools are proxied to the Worker's MCP endpoint:
 *   search — unified hybrid search / time-ordered activity scan /
 *                   inline doc content fetch via Vectorize + Workers AI
 *
 * The bridge has two independent protocol faces (issue #224):
 *
 *   Claude Desktop -> bridge : SDK v1 stdio server, 2025-era. Unchanged.
 *   bridge -> Worker         : SDK v2 client pinned to protocol revision
 *                              2026-07-28. Stateless — no `initialize`
 *                              handshake and no `mcp-session-id`; every
 *                              request carries the per-request `_meta`
 *                              envelope the revision requires.
 *
 * The Worker's revision is a private contract between the two artifacts of
 * this repository, so the Desktop face is not bound by it. Moving the Desktop
 * face to SDK v2 is issue #228.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { createOAuthProvider, OAuthPendingError } from "./oauth.js";
import { createRemoteClient } from "./remote-client.js";
import { TOOLS } from "./tools.js";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json");

const WORKER_URL =
  process.env.RAG_WORKER_URL ||
  "https://github-rag-mcp.liplus.workers.dev";

const oauth = createOAuthProvider({ workerUrl: WORKER_URL });

// ── Remote MCP Client (lazy, reused) ─────────────────────────────────────────
// Construction and caching live in ./remote-client.js so they can be tested
// without importing this module (which connects the stdio transport on import).

const remote = createRemoteClient({
  workerUrl: WORKER_URL,
  clientVersion: PACKAGE_VERSION,
  authProvider: oauth,
  fetch: oauth.fetch,
});

async function callRemoteTool(name, args) {
  // Resolve credentials first so an interactive-auth requirement surfaces as
  // OAuthPendingError from here, where the caller already handles it, rather
  // than from inside the transport wrapped as a network failure.
  await oauth.token();

  return await remote.callTool(name, args);
}

// ── MCP Server Setup (Claude Desktop face — SDK v1, unchanged) ───────────────

const server = new Server(
  { name: "github-rag-mcp", version: PACKAGE_VERSION },
  { capabilities: { tools: {} } },
);

// ── Tool Definitions ─────────────────────────────────────────────────────────
// Schema lives in ./tools.js so it can be asserted in tests without importing
// this module (which connects the stdio transport on import).

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    return await callRemoteTool(name, args ?? {});
  } catch (err) {
    if (err instanceof OAuthPendingError) {
      return {
        content: [
          {
            type: "text",
            text: `Authentication required. A browser window should have opened for authorization. After authorizing in the browser, retry the tool call.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Failed to reach worker: ${err}` }],
      isError: true,
    };
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
