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

## 6. Webhook セットアップ

Webhook を設定すると、issue/PR/release の変更がリアルタイムでインデックスに反映される。Cron Poller は 1 時間ごとのフォールバックとして引き続き動作する。

### 6.1 Webhook シークレットの生成

ランダムな文字列を生成し、webhook リクエストの署名検証に使用する。

```bash
openssl rand -hex 32
```

生成した値を Cloudflare Workers のシークレットとして設定する。

```bash
echo "<generated-secret>" | wrangler secret put GITHUB_WEBHOOK_SECRET
```

### 6.2 GitHub リポジトリに Webhook を登録

対象リポジトリごとに以下の手順で Webhook を登録する。

1. **GitHub > リポジトリ > Settings > Webhooks > Add webhook**
2. 以下を設定:

| Field | Value |
|---|---|
| Payload URL | `https://<your-worker>.workers.dev/webhooks/github` |
| Content type | `application/json` |
| Secret | 6.1 で生成したシークレット |

3. **Which events would you like to trigger this webhook?** で **Let me select individual events** を選択し、以下を有効にする:
   - **Issues** — issue の作成・更新・クローズ
   - **Pull requests** — PR の作成・更新・マージ
   - **Releases** — リリースの公開・更新
   - **Pushes** — ドキュメントファイルの変更検出

4. **Active** にチェックが入っていることを確認し、**Add webhook** をクリック

### 6.3 動作確認

Webhook 登録後、対象リポジトリで issue を更新すると、Worker ログにリアルタイムでイベント処理のログが表示される。

## 7. Verify Deployment

### Check Cron Trigger

Cron Poller は 1 時間ごとのフォールバックとして動作する。デプロイ後:

1. 最大 1 時間で最初の cron 実行が行われる
2. Cloudflare Dashboard で Worker ログを確認:
   - **Workers & Pages > github-rag-mcp > Logs > Real-time Logs** を開く
   - `Polling Liplus-Project/... (initial sync)` のようなメッセージを確認

### Check Webhook

Webhook が正しく設定されている場合、対象リポジトリの **Settings > Webhooks** で最近の配信履歴と応答ステータスを確認できる。

### Check MCP Endpoint

`https://<your-worker>.workers.dev/` にブラウザでアクセスし、応答があることを確認する（OAuth にリダイレクトされる場合がある）。

## Troubleshooting

### Cron errors: "GITHUB_TOKEN not configured"

`GITHUB_TOKEN` シークレットが未設定または設定が正しくない。Cloudflare Dashboard でシークレットを再確認する。

### Cron errors: "POLL_REPOS not configured"

`POLL_REPOS` 変数が未設定。プレーンテキスト変数として追加する。

### GitHub API 401/403 errors

PAT の有効期限が切れているか、必要なスコープが不足している。`repo`（プライベートリポジトリ用）または `public_repo`（パブリックリポジトリ用）スコープで新しい PAT を生成する。

### OAuth callback errors

GitHub App 設定のコールバック URL が `https://<your-worker>.workers.dev/oauth/callback` と完全に一致していることを確認する。

### Webhook 403 errors

`GITHUB_WEBHOOK_SECRET` が正しく設定されていないか、GitHub の Webhook 設定と一致していない。両方の値が同一であることを確認する。
