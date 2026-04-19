# github-rag-mcp

Stdio MCP proxy that bridges local MCP clients (Claude Desktop, Claude Code, etc.) to a remote [github-rag-mcp](https://github.com/Liplus-Project/github-rag-mcp) Cloudflare Worker for semantic and structured search over GitHub issues, pull requests, releases, documentation, and commit diffs.

This package is the **client-side proxy only**. The actual indexing pipeline (Vectorize + D1 FTS5 + Workers AI BGE-M3 + cross-encoder rerank) runs on the Worker. See the [main repository](https://github.com/Liplus-Project/github-rag-mcp) for architecture and self-hosting instructions.

## What this proxy does

- Speaks stdio MCP locally to your client.
- Forwards `tools/call` to the Worker's Streamable HTTP MCP endpoint (`/mcp`).
- Handles OAuth 2.1 with PKCE against the Worker (browser-based localhost callback).
- Caches access and refresh tokens under `~/.github-rag-mcp/` (mode `0600`).

## Requirements

- Node.js >= 18
- A reachable github-rag-mcp Worker (the public default is `https://github-rag-mcp.liplus.workers.dev`; you can also point at your own deployment)
- A web browser on the same machine (used once for OAuth authorization)

## Install / Run

The proxy is published to npm and exposes a `github-rag-mcp` binary.

Run directly with `npx` (no global install required):

```bash
npx github-rag-mcp
```

Or install globally:

```bash
npm install -g github-rag-mcp
github-rag-mcp
```

The first run opens a browser window to complete OAuth against the Worker. After authorization, tokens are stored under `~/.github-rag-mcp/` and refreshed automatically.

## Client configuration

### Claude Desktop / Claude Code

Add the server to your MCP client configuration. Example for Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "github-rag": {
      "command": "npx",
      "args": ["-y", "github-rag-mcp"]
    }
  }
}
```

To target a self-hosted Worker, set the `RAG_WORKER_URL` environment variable:

```json
{
  "mcpServers": {
    "github-rag": {
      "command": "npx",
      "args": ["-y", "github-rag-mcp"],
      "env": {
        "RAG_WORKER_URL": "https://your-worker.example.workers.dev"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `RAG_WORKER_URL` | No | `https://github-rag-mcp.liplus.workers.dev` | Base URL of the Cloudflare Worker that exposes the MCP endpoint and OAuth metadata. |

OAuth client registration and tokens are stored in:

- `~/.github-rag-mcp/oauth-client.json` (dynamic client registration)
- `~/.github-rag-mcp/oauth-tokens.json` (access + refresh tokens)

Delete these files to force a fresh authorization flow.

## Tools exposed

| Tool | Description |
|---|---|
| `search_issues` | 3-tier hybrid search (dense BGE-M3 + sparse BM25 + cross-encoder rerank) over issues, pull requests, releases, documentation, and commit diffs, with structured filters (`repo`, `state`, `labels`, `milestone`, `assignee`, `type`, `top_k`, `fusion`, `rerank`). |
| `get_issue_context` | Aggregated state for a single issue or PR, including related PRs, branch, and CI status. |
| `get_doc_content` | Fetch the raw content of a `.md` document from a tracked repository (use after `search_issues` with `type: "doc"`). |
| `list_recent_activity` | Recent created / updated / closed activity across tracked repositories. |

All tools are read-only.

## Authentication flow

1. On first tool call, the proxy discovers OAuth metadata at `${RAG_WORKER_URL}/.well-known/oauth-authorization-server`.
2. It performs Dynamic Client Registration (RFC 7591) if no client is cached.
3. It starts a one-shot localhost HTTP listener on a random port and opens the browser to the Worker's authorization endpoint.
4. After you approve, the Worker redirects to `http://127.0.0.1:<port>/callback` with an authorization code.
5. The proxy exchanges the code for tokens (PKCE S256) and saves them.
6. Subsequent calls reuse the access token and silently refresh when it nears expiry. On `401` from the Worker, the proxy invalidates its cached tokens and re-authenticates.

The browser callback never leaves your machine; the authorization code is delivered directly to the local listener.

## Troubleshooting

- **Browser does not open.** The proxy logs the authorization URL to stderr; copy it into a browser manually.
- **`OAuth callback timed out after 5 minutes`.** Re-invoke any tool to restart the flow.
- **`Failed to reach worker`.** Check that `RAG_WORKER_URL` is correct and reachable from your machine.
- **Stale credentials.** Remove `~/.github-rag-mcp/oauth-tokens.json` (and optionally `oauth-client.json`) and retry.

## Links

- Source and architecture: <https://github.com/Liplus-Project/github-rag-mcp>
- Self-hosting the Worker: [docs/installation.md](https://github.com/Liplus-Project/github-rag-mcp/blob/main/docs/installation.md)
- Requirements spec: [docs/0-requirements.md](https://github.com/Liplus-Project/github-rag-mcp/blob/main/docs/0-requirements.md)
- Issue tracker: <https://github.com/Liplus-Project/github-rag-mcp/issues>

## License

Apache-2.0. See the [LICENSE](https://github.com/Liplus-Project/github-rag-mcp/blob/main/LICENSE) and [NOTICE](https://github.com/Liplus-Project/github-rag-mcp/blob/main/NOTICE) files in the main repository.
