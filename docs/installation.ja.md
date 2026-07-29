# github-rag-mcp インストールガイド

言語: [English](installation.md) | 日本語

## Prerequisites

- Cloudflare account
- 対象 repository に access できる GitHub account
- Node.js 18+
- npm
- Wrangler CLI

Wrangler が未導入なら:

```bash
npm install -g wrangler
```

## 1. Clone と dependency install

```bash
git clone https://github.com/Liplus-Project/github-rag-mcp.git
cd github-rag-mcp
npm install
```

## 2. Cloudflare に login

```bash
wrangler login
```

## 3. Cloudflare resource を作成

### 3.1 Vectorize index

```bash
wrangler vectorize create github-rag-issues --dimensions 1024 --metric cosine
```

### 3.2 Metadata index

structured filter を使う前に metadata index を作る。

```bash
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name repo
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name type
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name state
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name milestone
# label/assignee 展開フィールド (将来の Vectorize OR フィルター対応に備えて格納)
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

返された namespace ID を `wrangler.toml` に反映する。

### 3.4 D1 database（hybrid retrieval の FTS5 sparse 側）

BM25 / FTS5 sparse index 用の D1 database を作成する。

```bash
wrangler d1 create github-rag-fts
```

返された `database_id` を `wrangler.toml` に反映する:

```toml
[[d1_databases]]
binding = "DB_FTS"
database_name = "github-rag-fts"
database_id = "<ここに ID を貼る>"
migrations_dir = "migrations"
```

初回 migration を適用する（`search_docs` と 2 つの FTS5 virtual table を作成）:

```bash
wrangler d1 migrations apply github-rag-fts
```

新規 D1 database への初回デプロイ時は `--remote` も実行する:

```bash
wrangler d1 migrations apply github-rag-fts --remote
```

## 4. GitHub App を作成

OAuth と repository access 用の GitHub App を作成する。

推奨設定:

| Field | Value |
|---|---|
| Homepage URL | `https://<your-worker>.workers.dev` |
| Callback URL | `https://<your-worker>.workers.dev/oauth/callback` |
| Webhook URL | `https://<your-worker>.workers.dev/webhooks/github` |
| Webhook active | enabled |

推奨 repository permission:

- Issues: read
- Pull requests: read
- Checks: read
- Commit statuses: read
- Contents: read
- Metadata: read

購読 event:

- Issues
- Pull requests
- Push
- Release

追跡したい repository に App を install する。

## 5. Secret を設定

Cloudflare に次の secret を設定する。

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_TOKEN`
- `GITHUB_WEBHOOK_SECRET`

例:

```bash
echo "<client-id>" | wrangler secret put GITHUB_CLIENT_ID
echo "<client-secret>" | wrangler secret put GITHUB_CLIENT_SECRET
echo "<github-token>" | wrangler secret put GITHUB_TOKEN
echo "<webhook-secret>" | wrangler secret put GITHUB_WEBHOOK_SECRET
```

## 6. Variable を設定

`POLL_REPOS` に comma-separated list で repository を設定する。

例:

```toml
[vars]
POLL_REPOS = "owner/repo1,owner/repo2"
```

## 7. Worker を deploy

```bash
wrangler deploy
```

## 8. Deploy 後の確認

次を確認する。

- OAuth callback が通る
- webhook delivery が成功する
- Cloudflare log に cron run が出る
- MCP endpoint へ到達できる

推奨確認フロー:

1. Worker URL を開いて OAuth を完了する
2. 追跡対象 repository の issue を更新する
3. webhook delivery が Worker に届くことを確認する
4. search result に反映されることを確認する

## 9. 後から metadata filtering を有効化した場合の再 index

vector 作成後に metadata index を追加した場合、stored hash を reset して次回 cron で全件 re-embed させる。

Admin endpoint:

```text
POST /admin/reset-hashes?repo=owner/repo
```

認証:

- `GITHUB_TOKEN` header に worker secret と同じ `GITHUB_TOKEN` を送る

## 10. commit diff の欠損期間を再走査する（gap backfill）

ある期間の commit diff が欠けている場合（旧版 poller が取りこぼした、あるいは特定 commit が失敗し続けて watermark が止まっている場合）、diff poller の watermark を巻き戻す。次回 `:30` cron が `since` 以降を古い側から順に、取りこぼしなく再走査する。

Admin endpoint:

```text
POST /admin/diff-watermark?repo=owner/repo&since=2026-07-06T00:00:00Z
```

パラメータ:

- `repo` — `owner/repo` 形式。`POLL_REPOS` に含まれている必要がある
- `since` — 解釈可能な timestamp。次回 run の再開位置として watermark に格納される
- `phase` — `forward`（既定）は `diffs:{repo}` を巻き戻す。`backfill` は `diffs_backfill:{repo}` を移動する（履歴遡行が止まった時の解除用）

認証:

- `GITHUB_TOKEN` header に worker secret と同じ `GITHUB_TOKEN` を送る

運用上の注意:

- 追いつき速度は 1 repo あたり 1 run 5 commits（毎時 `:30` なので約 120 commits/日）。数週間分の欠損は数日かかる
- 再走査中も新規 commit は影響を受けない（webhook 経路が即時 index する）
- upsert は `(repo, commit_sha, file_path)` で idempotent なので、index 済み期間を再走査しても安全
- 進捗は worker log の `{repo} diffs: forward [...]` 行、または該当期間を `type: "diff"` で検索して確認する

## Troubleshooting

### `GITHUB_TOKEN not configured`

worker secret が未設定、または値が誤っている。

### `POLL_REPOS not configured`

plain-text variable が未設定である。

### GitHub API 401 / 403

token が失効しているか、必要な scope が不足している。

### OAuth callback fails

GitHub App の callback URL が worker 側 URL と完全一致していない。

### Webhook verification fails

`GITHUB_WEBHOOK_SECRET` が GitHub App 側設定と一致していない。
