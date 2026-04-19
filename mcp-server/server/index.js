#!/usr/bin/env node
/**
 * GitHub RAG MCP — Cloudflare Worker bridge
 *
 * Thin stdio MCP server that proxies tool calls to a remote
 * Cloudflare Worker + Durable Object backend via Streamable HTTP.
 * Authenticates via OAuth 2.1 with PKCE (localhost callback).
 *
 * Tools are proxied to the Worker's MCP endpoint:
 *   search_issues       — semantic + structured search via Vectorize + Workers AI
 *   get_issue_context   — aggregated issue view with related PRs, branch, CI
 *   get_doc_content     — retrieve .md document content from a repository
 *   list_recent_activity — recent changes across tracked repositories
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json");

const WORKER_URL =
  process.env.RAG_WORKER_URL ||
  "https://github-rag-mcp.liplus.workers.dev";

// ── OAuth Token Storage ──────────────────────────────────────────────────────

const TOKEN_DIR = join(homedir(), ".github-rag-mcp");
const TOKEN_FILE = join(TOKEN_DIR, "oauth-tokens.json");
const CLIENT_REG_FILE = join(TOKEN_DIR, "oauth-client.json");

async function loadTokens() {
  try {
    const data = await readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveTokens(tokens) {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

let _cachedTokens = null;

// ── PKCE Utilities ───────────────────────────────────────────────────────────

function generateCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ── OAuth Discovery & Registration ───────────────────────────────────────────

async function discoverOAuthMetadata() {
  const res = await fetch(`${WORKER_URL}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    throw new Error(`OAuth discovery failed: ${res.status}`);
  }
  return await res.json();
}

async function loadClientRegistration() {
  try {
    const data = await readFile(CLIENT_REG_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveClientRegistration(reg) {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(CLIENT_REG_FILE, JSON.stringify(reg, null, 2), { mode: 0o600 });
}

async function ensureClientRegistration(metadata, redirectUris) {
  const existing = await loadClientRegistration();
  if (existing) return existing;

  if (!metadata.registration_endpoint) {
    throw new Error("OAuth server does not support dynamic client registration");
  }

  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "github-rag-mcp-cli",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!res.ok) {
    throw new Error(`Client registration failed: ${res.status} ${await res.text()}`);
  }

  const reg = await res.json();
  await saveClientRegistration(reg);
  return reg;
}

// ── OAuth Localhost Callback Flow ────────────────────────────────────────────

let _pendingOAuth = null;

class OAuthPendingError extends Error {
  constructor(authUrl) {
    super("OAuth authentication required");
    this.authUrl = authUrl;
  }
}

function openBrowser(url) {
  if (process.platform === "win32") {
    exec(`start "" "${url}"`);
  } else {
    const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
    exec(`${openCmd} "${url}"`);
  }
}

async function startOAuthFlow() {
  const metadata = await discoverOAuthMetadata();

  const callbackServer = createServer();
  await new Promise((resolve) => {
    callbackServer.listen(0, "127.0.0.1", () => resolve());
  });
  const port = callbackServer.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const client = await ensureClientRegistration(metadata, [
    redirectUri,
    `http://localhost:${port}/callback`,
  ]);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const tokenPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      callbackServer.close();
      _pendingOAuth = null;
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    callbackServer.on("request", async (req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authorization failed</h1><p>You can close this tab.</p></body></html>");
        clearTimeout(timeout);
        callbackServer.close();
        _pendingOAuth = null;
        reject(new Error(`OAuth authorization failed: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Invalid callback</h1></body></html>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authorization successful</h1><p>You can close this tab.</p></body></html>");
      clearTimeout(timeout);
      callbackServer.close();

      try {
        const tokenRes = await fetch(metadata.token_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: client.client_id,
            code_verifier: codeVerifier,
          }),
        });

        if (!tokenRes.ok) {
          _pendingOAuth = null;
          reject(new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`));
          return;
        }

        const tokenData = await tokenRes.json();
        const tokens = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: tokenData.expires_in
            ? Date.now() + tokenData.expires_in * 1000
            : undefined,
        };

        await saveTokens(tokens);
        _pendingOAuth = null;
        resolve(tokens);
      } catch (err) {
        _pendingOAuth = null;
        reject(err);
      }
    });
  });

  openBrowser(authUrl.toString());
  process.stderr.write(
    `\n[github-rag-mcp] Opening browser for authentication...\n`,
  );

  _pendingOAuth = { authUrl: authUrl.toString(), tokenPromise };
  return _pendingOAuth;
}

async function performOAuthFlow() {
  if (_pendingOAuth) {
    const result = await Promise.race([
      _pendingOAuth.tokenPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (result && result.access_token) return result;
    throw new OAuthPendingError(_pendingOAuth.authUrl);
  }

  const pending = await startOAuthFlow();

  const result = await Promise.race([
    pending.tokenPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (result && result.access_token) return result;

  throw new OAuthPendingError(pending.authUrl);
}

async function refreshAccessToken(refreshToken) {
  const metadata = await discoverOAuthMetadata();
  const client = await loadClientRegistration();
  if (!client) throw new Error("No client registration found");

  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.client_id,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = await res.json();

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };

  await saveTokens(tokens);
  return tokens;
}

async function getAccessToken() {
  if (!_cachedTokens) {
    _cachedTokens = await loadTokens();
  }

  if (_cachedTokens) {
    if (!_cachedTokens.expires_at || _cachedTokens.expires_at > Date.now() + 60_000) {
      return _cachedTokens.access_token;
    }

    if (_cachedTokens.refresh_token) {
      try {
        _cachedTokens = await refreshAccessToken(_cachedTokens.refresh_token);
        return _cachedTokens.access_token;
      } catch {
        // Refresh failed, fall through to full OAuth flow
      }
    }
  }

  _cachedTokens = await performOAuthFlow();
  return _cachedTokens.access_token;
}

/** Build common headers with OAuth Bearer auth */
async function authHeaders(extra) {
  const h = { ...extra };
  const token = await getAccessToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

// ── Remote MCP Session (lazy, reused) ────────────────────────────────────────

let _sessionId = null;

async function getSessionId() {
  if (_sessionId) return _sessionId;

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: await authHeaders({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "github-rag-mcp-bridge", version: PACKAGE_VERSION },
      },
      id: "init",
    }),
  });

  _sessionId = res.headers.get("mcp-session-id") || "";
  return _sessionId;
}

async function callRemoteTool(name, args) {
  const sessionId = await getSessionId();

  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: "POST",
    headers: await authHeaders({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id: crypto.randomUUID(),
    }),
  });

  // 401 = token expired or revoked, re-authenticate and retry
  if (res.status === 401) {
    _cachedTokens = null;
    _sessionId = null;
    return callRemoteTool(name, args);
  }

  const text = await res.text();

  // Streamable HTTP may return SSE format
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);

  if (json.error) {
    // Session expired — retry once with a fresh session
    if (json.error.code === -32600 || json.error.code === -32001) {
      _sessionId = null;
      return callRemoteTool(name, args);
    }
    return { content: [{ type: "text", text: JSON.stringify(json.error) }] };
  }

  return json.result;
}

// ── MCP Server Setup ─────────────────────────────────────────────────────────

const server = new Server(
  { name: "github-rag-mcp", version: PACKAGE_VERSION },
  { capabilities: { tools: {} } },
);

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_issues",
    title: "Search Issues",
    description:
      "3-tier hybrid search (dense + sparse BM25 + cross-encoder rerank) for GitHub issues, PRs, releases, " +
      "documentation, and commit diffs with structured filters. " +
      "Dense uses BGE-M3 over Vectorize; sparse uses BM25 over D1 FTS5; " +
      "the two are fused via Reciprocal Rank Fusion (RRF, k=60), then re-scored by " +
      "@cf/baai/bge-reranker-base (toggle with rerank: false to skip).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        repo: {
          type: "string",
          description: "Filter by repository (owner/repo)",
        },
        state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Filter by state (default: all)",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Filter by label names (AND logic)",
        },
        milestone: {
          type: "string",
          description: "Filter by milestone title",
        },
        assignee: {
          type: "string",
          description: "Filter by assignee login",
        },
        type: {
          type: "string",
          enum: ["issue", "pull_request", "release", "doc", "diff", "all"],
          description:
            "Filter by type (default: all). Use \"diff\" to search per-file commit diffs (judgment history).",
        },
        top_k: {
          type: "number",
          description: "Max results (default: 10, max: 50)",
        },
        fusion: {
          type: "string",
          enum: ["rrf", "dense_only", "sparse_only"],
          description:
            "Fusion strategy (default: rrf). dense_only / sparse_only for debugging or single-ranker queries.",
        },
        rerank: {
          type: "boolean",
          description:
            "Cross-encoder reranking with @cf/baai/bge-reranker-base (default: true). " +
            "Set false to skip — faster, no rerank cost; recommended for short identifier queries or debugging.",
        },
      },
      required: ["query"],
    },
    annotations: {
      title: "Search Issues",
      readOnlyHint: true,
    },
  },
  {
    name: "get_issue_context",
    title: "Get Issue Context",
    description:
      "Get aggregated context for a single issue/PR including related PRs, branch status, and CI status.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository (owner/repo)",
        },
        number: {
          type: "number",
          description: "Issue or PR number",
        },
      },
      required: ["repo", "number"],
    },
    annotations: {
      title: "Get Issue Context",
      readOnlyHint: true,
    },
  },
  {
    name: "get_doc_content",
    title: "Get Document Content",
    description:
      "Retrieve the content of a document file (.md) from a GitHub repository. " +
      "Use this to read documents found via search_issues with type: \"doc\". " +
      "Returns the raw file content fetched from the repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository (owner/repo)",
        },
        path: {
          type: "string",
          description:
            'File path in the repository (e.g. "docs/0-requirements.md")',
        },
        ref: {
          type: "string",
          description:
            "Git ref (branch, tag, or commit SHA) to fetch from. Defaults to the repository's default branch.",
        },
      },
      required: ["repo", "path"],
    },
    annotations: {
      title: "Get Document Content",
      readOnlyHint: true,
    },
  },
  {
    name: "list_recent_activity",
    title: "List Recent Activity",
    description:
      "List recent issue/PR activity across tracked repositories. " +
      "Returns changes classified as created, updated, or closed.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Filter by repository (owner/repo)",
        },
        since: {
          type: "string",
          description: "ISO 8601 timestamp for activity start (default: last 24 hours)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 20, max: 100)",
        },
      },
    },
    annotations: {
      title: "List Recent Activity",
      readOnlyHint: true,
    },
  },
];

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
