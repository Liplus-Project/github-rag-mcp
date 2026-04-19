# github-rag-mcp Installation Guide

Language: English | [Japanese](installation.ja.md)

## Prerequisites

- Cloudflare account
- GitHub account with access to the target repositories
- Node.js 18+
- npm
- Wrangler CLI

Install Wrangler if needed:

```bash
npm install -g wrangler
```

## 1. Clone and install dependencies

```bash
git clone https://github.com/Liplus-Project/github-rag-mcp.git
cd github-rag-mcp
npm install
```

## 2. Log in to Cloudflare

```bash
wrangler login
```

## 3. Create Cloudflare resources

### 3.1 Vectorize index

```bash
wrangler vectorize create github-rag-issues --dimensions 1024 --metric cosine
```

### 3.2 Metadata indexes

Create metadata indexes before relying on structured filters.

```bash
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name repo
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name type
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name state
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name milestone
# Expanded label/assignee fields (stored for future Vectorize OR-filter support)
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name label_0
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name label_1
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name label_2
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name label_3
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name assignee_0
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name assignee_1
```

### 3.3 KV namespace

```bash
wrangler kv namespace create OAUTH_KV
```

Update `wrangler.toml` with the returned namespace ID.

### 3.4 D1 database (FTS5 sparse side of hybrid retrieval)

Create a D1 database for the BM25 / FTS5 sparse index.

```bash
wrangler d1 create github-rag-fts
```

Update `wrangler.toml` with the returned `database_id`:

```toml
[[d1_databases]]
binding = "DB_FTS"
database_name = "github-rag-fts"
database_id = "<paste-the-id-here>"
migrations_dir = "migrations"
```

Apply the initial migration (creates `search_docs` + the two FTS5 virtual tables):

```bash
wrangler d1 migrations apply github-rag-fts
```

For the first deploy against a brand-new D1 database, also run the same command with `--remote`:

```bash
wrangler d1 migrations apply github-rag-fts --remote
```

## 4. Create the GitHub App

Create a GitHub App for OAuth and repository access.

Recommended settings:

| Field | Value |
|---|---|
| Homepage URL | `https://<your-worker>.workers.dev` |
| Callback URL | `https://<your-worker>.workers.dev/oauth/callback` |
| Webhook URL | `https://<your-worker>.workers.dev/webhooks/github` |
| Webhook active | enabled |

Recommended repository permissions:

- Issues: read
- Pull requests: read
- Checks: read
- Commit statuses: read
- Contents: read
- Metadata: read

Subscribe to these events:

- Issues
- Pull requests
- Push
- Release

Install the app on the repositories you want to track.

## 5. Configure secrets

Set these secrets in Cloudflare:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_TOKEN`
- `GITHUB_WEBHOOK_SECRET`

Example:

```bash
echo "<client-id>" | wrangler secret put GITHUB_CLIENT_ID
echo "<client-secret>" | wrangler secret put GITHUB_CLIENT_SECRET
echo "<github-token>" | wrangler secret put GITHUB_TOKEN
echo "<webhook-secret>" | wrangler secret put GITHUB_WEBHOOK_SECRET
```

## 6. Configure variables

Set `POLL_REPOS` to a comma-separated list of repositories.

Example:

```toml
[vars]
POLL_REPOS = "owner/repo1,owner/repo2"
```

## 7. Deploy the worker

```bash
wrangler deploy
```

## 8. Verify the deployment

Check the following:

- OAuth callback works
- webhook deliveries return success
- cron runs appear in Cloudflare logs
- the MCP endpoint is reachable

Recommended verification flow:

1. Open the worker URL and complete OAuth.
2. Edit an issue in a tracked repository.
3. Confirm a webhook delivery reaches the worker.
4. Confirm the record appears in search results.

## 9. Re-index if metadata filtering was added later

If metadata indexes were created after vectors already existed, reset stored hashes so the next cron run re-embeds everything.

Admin endpoint:

```text
POST /admin/reset-hashes?repo=owner/repo
```

Authentication:

- send the same `GITHUB_TOKEN` value in the `GITHUB_TOKEN` header

## Troubleshooting

### `GITHUB_TOKEN not configured`

The worker secret is missing or misconfigured.

### `POLL_REPOS not configured`

The plain-text variable is missing.

### GitHub API 401 or 403

The token is expired or missing required scopes.

### OAuth callback fails

The GitHub App callback URL does not exactly match the worker callback URL.

### Webhook verification fails

`GITHUB_WEBHOOK_SECRET` does not match the value configured in the GitHub App.
