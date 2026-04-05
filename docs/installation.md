# github-rag-mcp Installation Guide

## Prerequisites

- Cloudflare account (Free plan sufficient)
- GitHub account with organization access
- Node.js 18+ and npm
- wrangler CLI (`npm install -g wrangler`)

## 1. Clone and Install

```bash
git clone https://github.com/Liplus-Project/github-rag-mcp.git
cd github-rag-mcp
npm install
```

## 2. Create Cloudflare Resources

### 2.1 Login to Cloudflare

```bash
wrangler login
```

### 2.2 Create Vectorize Index

```bash
wrangler vectorize create github-rag-issues --dimensions 1024 --metric cosine
```

### 2.3 Create KV Namespace (if not exists)

```bash
wrangler kv namespace create OAUTH_KV
```

Update `wrangler.toml` with the returned KV namespace ID:

```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<your-kv-namespace-id>"
```

## 3. Create GitHub App

### 3.1 Register the App

1. Go to **GitHub Settings > Developer settings > GitHub Apps > New GitHub App**
2. Fill in:

| Field | Value |
|---|---|
| GitHub App name | `<your-app-name>` (e.g. `liplus-rag-mcp`) |
| Homepage URL | `https://<your-worker>.workers.dev` |
| Callback URL | `https://<your-worker>.workers.dev/oauth/callback` |
| Webhook Active | **OFF** (uncheck) |

3. Set **Repository permissions** (all Read-only):
   - Issues
   - Pull requests
   - Checks
   - Commit statuses
   - Metadata (mandatory, auto-selected)

4. Under "Where can this GitHub App be installed?":
   - **Only on this account** if private use only
   - **Any account** if installing on an organization

5. Click **Create GitHub App**

### 3.2 Generate Client Secret

1. On the App settings page, under **Client secrets**, click **Generate a new client secret**
2. **Copy and save the secret immediately** - it will not be shown again

### 3.3 Note the Client ID

The **Client ID** is shown on the App settings page under "About" (e.g. `Iv23li75gaUIHHDg5qtt`).

### 3.4 Install the App on Your Organization

If installing on an organization:

1. Go to **Install App** in the left sidebar of the App settings
2. Click **Install** next to the target organization
3. Select **All repositories** or choose specific repositories
4. Click **Install**

If the App is private and the target is an organization you don't own via the current account:

1. Go to **Advanced** in the App settings
2. Click **Transfer ownership** and transfer to the target organization
3. Approve the transfer from the organization owner's account
4. The App is now org-owned and can be installed on the org directly

## 4. Deploy the Worker

```bash
wrangler deploy
```

The Worker URL will be displayed (e.g. `https://github-rag-mcp.liplus.workers.dev`).

## 5. Configure Secrets

Set secrets via Cloudflare Dashboard or wrangler CLI.

### Via Cloudflare Dashboard

1. Go to **Cloudflare Dashboard > Workers & Pages > github-rag-mcp > Settings**
2. Under **Variables and Secrets**, click **+ Add**
3. Add the following:

| Type | Name | Value |
|---|---|---|
| Secret | `GITHUB_CLIENT_ID` | Client ID from step 3.3 |
| Secret | `GITHUB_CLIENT_SECRET` | Client secret from step 3.2 |
| Secret | `GITHUB_TOKEN` | GitHub PAT with repo read access |
| Plain text | `POLL_REPOS` | Comma-separated repos (e.g. `owner/repo1,owner/repo2`) |

4. Click **Deploy**

### Via wrangler CLI

```bash
echo "<client-id>" | wrangler secret put GITHUB_CLIENT_ID
echo "<client-secret>" | wrangler secret put GITHUB_CLIENT_SECRET
echo "<github-pat>" | wrangler secret put GITHUB_TOKEN
echo "owner/repo1,owner/repo2" | wrangler secret put POLL_REPOS
```

## 6. Verify Deployment

### Check Cron Trigger

The Worker polls GitHub every 5 minutes via Cron Triggers. After deployment:

1. Wait up to 5 minutes for the first cron execution
2. Check Worker logs in Cloudflare Dashboard:
   - Go to **Workers & Pages > github-rag-mcp > Logs > Real-time Logs**
   - Look for messages like `Polling Liplus-Project/... (initial sync)`

### Check MCP Endpoint

Visit `https://<your-worker>.workers.dev/` in a browser - it should respond (may redirect to OAuth).

## Troubleshooting

### Cron errors: "GITHUB_TOKEN not configured"

The `GITHUB_TOKEN` secret is not set or was set incorrectly. Re-check the secret in Cloudflare Dashboard.

### Cron errors: "POLL_REPOS not configured"

The `POLL_REPOS` variable is missing. Add it as a plain text variable.

### GitHub API 401/403 errors

The PAT may have expired or lacks the required scopes. Generate a new PAT with `repo` scope (for private repos) or `public_repo` scope (for public repos only).

### OAuth callback errors

Ensure the callback URL in the GitHub App settings exactly matches `https://<your-worker>.workers.dev/oauth/callback`.
