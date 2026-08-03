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

## 11. migration 0006 適用後に full-text index を再分かち書きする

migration `0006_fts5_segmented_nat_index.sql` は `content_fts` 列を追加し、生本文のコピーで初期化する。実際の分かち書きは JavaScript（`Intl.Segmenter`）にしか存在しないため、migration より前に索引された row はこの endpoint が走るまで未分割のまま残る。それまでの間、該当 row に対する日本語の句クエリは sparse 候補が 0 件のままになる。

migration 適用後に一度だけ実行する。deploy 以降に索引された row は取り込み経路が既に分かち書き済みで書いている。

順序は **migration 適用 → worker deploy → この backfill** とする。migration から deploy までの間、稼働中の旧版は `content_fts` を書かないため、その窓で索引された row は v3 index に空テキストとして入る。backfill が生の `content` から書き直すので、この窓は自己修復する。逆順は成立しない。migration 前に deploy した worker は upsert のたびに `no such column: content_fts` で落ちる。

Admin endpoint:

```text
POST /admin/backfill-fts-segments
```

パラメータ:

- `repo` — 任意の `owner/repo` filter。省略すると全 repository を走査する
- `cursor` — 再開位置の `rowid`（既定 `0`）。前回 response の `nextCursor` をそのまま渡す
- `limit` — 1 回あたりの row 数、`1..200`（既定 `50`）

認証:

- `GITHUB_TOKEN` header に worker secret と同じ `GITHUB_TOKEN` を送る

Response:

```json
{ "repo": null, "cursor": 0, "limit": 50, "scanned": 50, "updated": 41, "nextCursor": 812, "done": false }
```

運用上の注意:

- `nextCursor` を渡し直しながら `done` が `true` になるまで繰り返し呼ぶ
- どの時点でも `cursor=0` から再実行してよい。分かち書きが既に一致する row は書き込まず skip するため、完了済みの backfill を再実行すると `updated: 0` になる
- 1 回の呼び出しで発行する D1 操作は最大 2 回なので、中断しても batch が中途半端に書き込まれた状態は残らない
- 確認は `fusion: "sparse_only"` で日本語の句クエリを投げ、`sparse_candidates` が 0 でないことを見る

## 12. cron を待たずに wiki を索引する

`:45` の wiki cron は 1 run あたりの page 数に上限があり、保存した cursor から再開する。したがって深い wiki が全体をカバーするまで ceil(pages / 20) 時間かかる。それでは遅い場合にこの endpoint を使う — repository を繋いだ直後、wiki を一括投入した直後、poller 修正後のカバレッジ復旧など。

Admin endpoint:

```text
POST /admin/backfill-wiki?repo=owner/repo
```

パラメータ:

- `repo` — `owner/repo`。`POLL_REPOS` に載っている必要がある
- `limit` — 1 回の呼び出しで許す raw content の fetch 試行数、`1..40`（既定 `20`）
- `cursor` — この slug の次から再開する。省略すると保存済み cursor の続きから。空（`cursor=`）を渡すと列挙の先頭からやり直す（周回の起点もそこに戻る）

認証:

- `GITHUB_TOKEN` ヘッダに worker secret と同じ値を送る

レスポンス:

```json
{ "repo": "owner/repo", "pages": 77, "fetches": 20, "visited": 20, "embedded": 18,
  "skipped": 2, "failed": 0, "removed": 3, "orphansDeferred": 5, "orphansWithheld": 0,
  "startCursor": "", "nextCursor": "current-architecture-as-concession",
  "lapAnchor": "", "wrapped": false, "enumerated": true, "done": false }
```

運用上の注意:

- `done` が `true` になるまで繰り返し呼ぶ。cron と cursor を共有するので、互いに前進させ合う（競合しない）
- `done`（= `wrapped`）は「cursor が列挙を一周した」という意味で、1 回の呼び出しで全 page を踏破したという意味ではない。`pages` が `limit` を超える wiki では 1 回で `true` にはならず、`ceil(pages / limit)` 回で成立する。77 page を既定 `limit=20` で回すなら 4 回（issue #188）
- `lapAnchor` は現在の周回の起点 slug（`""` は列挙の先頭）。周回は `lapAnchor` の次の page から始まり、`lapAnchor` に戻ってきた時点で閉じる。`nextCursor` と併せて見れば途中経過が分かる
- `enumerated: false` は `/wiki/_pages` の scrape が失敗したという意味。何も索引せず、意図的に何も削除していない。空の wiki と解釈せず再試行すること
- `orphansDeferred` は、その run で**到達しなかった**削除候補の数。削除枠と probe 枠のどちらかが尽きて打ち切った分にあたる。0 になるまで呼び続ける。到達した上で見送った候補は `orphansWithheld` の側に数えられる — 枠が分かれているので、見送りが削除枠を消費して後ろに並ぶ実削除を止めることはない（issue #197）
- `fetches` は、その call の**先頭** page が予算より多くの候補を必要とした場合に限り `limit` を最大 3 超える。1 page の probe は最大 4 回（ファイル名候補 2 × `md` / `markdown`）で、途中で打ち切った probe は結果を観測したことにならないため、そのままでは cursor を進めないまま毎回同じ page を probe し直すことになる。そこで各 call の先頭 page だけ候補リストを試し切らせている。2 page 目以降は予算どおりに打ち切る（issue #192）
- `orphansWithheld` は、削除候補に挙がったが content がまだ配信されていた（あるいは実在確認が結論を出せなかった）ため削除を見送った page 数。0 でない場合、`_pages` の scrape が**実際の wiki より少なく返っている**という意味。page 自体は無傷で守られており、調べるべきは列挙のほう。見送った page 名は worker のログに出る（issue #187）
- カバレッジの確認は `search_docs` の `type = 'wiki_doc'` 行と `https://github.com/{repo}/wiki/_pages` の page 一覧を突き合わせる

## 13. 移行前の doc ベクトルを掃除する（一回性）

vector id は 2026 年 4 月に平文形式（`{repo}#doc-{path}`）から hash 形式へ移行した。削除経路はいずれも**現行**の id を計算するため、移行前に書かれた doc ベクトルは二度と名指しできない。Vectorize に残り続け、移行前の内容のまま dense 検索に出て、同じファイルの現行行から候補枠を 1 つ奪う。ファイルを消しても解決しない — reap は現行世代の行だけを消し、旧世代を残す（issue #204）。

移行前から索引していた repository ごとに一度だけ実行する。旧形式で組み直した id だけを削除し、再 embed は伴わない。

Admin endpoint:

```text
POST /admin/purge-legacy-vectors?repo=owner/repo
```

パラメータ:

- `repo` — `owner/repo`
- `dry_run` — `true` で件数だけ返し、Vectorize を一切呼ばない
- `surface` — `doc`（既定）。受け付ける値はこれだけ。移行は全 surface の id を変えているが、孤児が実測できているのは doc だけ
- `limit` — 1 回の呼び出しで扱う id 数、`1..2000`（既定 `500`）
- `cursor` — 再開位置。前回のレスポンスの `nextCursor` をそのまま渡す

ボディ（任意）:

```json
{ "paths": [".claude/CLAUDE.md", ".claude/rules/model/absolute.md"] }
```

すでに repository から削除済みの path。旧 id は worker に残っている情報からは列挙できないので、明示的に名指す必要がある。`paths` 由来の候補はツリー由来より先に処理されるので、上限に当たる run でも先に到達する。

認証:

- `GITHUB_TOKEN` ヘッダに worker secret と同じ値を送る

レスポンス:

```json
{ "repo": "owner/repo", "surface": "doc", "dryRun": false, "candidates": 512,
  "skippedOversize": 3, "treeTruncated": false, "cursor": 0, "limit": 500,
  "targeted": 500, "deleted": 500, "remaining": 12, "nextCursor": 500, "done": false }
```

運用上の注意:

- `done` が `true` になるまで `nextCursor` を渡して繰り返し呼ぶ。`remaining` が per-run 上限で残った件数。1 回の walk では毎回同じ `paths` ボディを送ること — cursor は `paths` を先頭に並べた順序リストへの添字なので、途中で外すと以降の位置が全部ずれる
- 何度実行しても安全。存在しない id の削除は no-op なので、完了済みの purge を再実行しても `candidates` は同じで何も変わらない。途中で失敗した場合は同じ `cursor` から再開する
- `skippedOversize` は Vectorize の 64 byte id 上限を超える旧 id の数。これらは upsert 時点で弾かれている（その溢れこそが移行の理由）ので、対応するベクトルは存在せず、送信もしない
- `treeTruncated: true` は Git Trees API が一覧を打ち切ったという意味で、候補のうちツリー由来の側が部分的になる。明示 `paths` の側は影響を受けない
- 現行世代のベクトルが巻き込まれることはない。2 つの id 形式は交わらず（`{repo}#doc-…` と `d:…`）、削除呼び出しに渡すのは組み直した旧 id だけ
- 残差は増えない — 旧形式が書き込まれた期間は移行時点で閉じている。したがってこの endpoint は repository ごとに一回性で、定期実行するものではない
- 確認は二重索引されていたファイルを検索し、移行前のコピー（古い内容・dense のみ）が出なくなることを見る

## 14. close 済みなのに `open` のまま残っている索引行を揃える

issue / PR が open の状態で索引された行は `state: "open"` を持つ。その後の state 変更を索引へ反映するのは metadata のみを更新する経路だが、この経路は自分が守っている mirror 書き込みより**先に**差分検出の基準を進めていた。そのため mirror が失敗しても二度と再試行されず、行は「まだ生きている項目」として検索に出続けた（issue #209）。順序は発生源側で修正済み。この endpoint は旧順序が残した行を修復する。

再 embed は伴わない。実際の state は repo ごとに 1 回の `state=open` 一覧から取り、sparse 側は `UPDATE`、dense 側は既存の vector 値をそのまま再 upsert して metadata の `state` だけ差し替える。`/admin/reset-hashes` はこの用途には使えない — repository 全体の再 embed を起こす。

Admin endpoint:

```text
POST /admin/backfill-issue-state?repo=owner/repo
```

パラメータ:

- `repo` — `owner/repo`
- `dry_run` — `true` で件数だけ返し、D1 にも Vectorize にも書かない
- `limit` — 1 回の呼び出しで見る行数、`1..1000`（既定 `200`）
- `cursor` — 再開位置の issue 番号。前回のレスポンスの `nextCursor` をそのまま渡す

認証:

- `GITHUB_TOKEN` ヘッダに worker secret と同じ値を送る

レスポンス:

```json
{ "repo": "owner/repo", "dryRun": false, "openOnGitHub": 33, "cursor": 0, "limit": 200,
  "scanned": 165, "stale": 132, "ftsUpdated": 132, "vectorsUpdated": 130,
  "vectorsMissing": 2, "nextCursor": null, "done": true }
```

運用上の注意:

- `done` が `true` になるまで `nextCursor` を渡して繰り返し呼ぶ
- 何度実行しても安全。GitHub 側でまだ open な行は書き込みなしでスキップされるので、完了済みの修復を再実行すると `stale: 0` が返る
- 方向は一方向（`open` → `closed`）。欠陥が生んだ方向であり、検索を害する方向（閉じた判断が生きた検討事項として再供給される）でもある。走査対象が索引全体でなく open 集合の大きさに比例する点も、この方向に限る理由
- open 一覧が 50 ページを超える場合、何も閉じずにエラーで中断する。「一覧に無いこと」が close の根拠なので、部分的な一覧を使ってはならない
- `vectorsMissing` は対応する vector が無い stale 行の数。これは索引欠落側（issue #210）の面で本 endpoint の範囲外。sparse 側は存在するので、そちらは修復する
- dense 側の書き込みが失敗した場合、D1 に触れる前に呼び出し全体が失敗する。中途半端な修復を残さないための設計なので、同じ `cursor` で再実行する
- 確認は close 済みと分かっている項目を `state: "closed"` で検索するか、`SELECT COUNT(*) FROM search_docs WHERE repo = ? AND type IN ('issue','pull_request') AND state = 'open'` が実際の open 数と一致することを見る

## 15. 索引に一度も載らなかった issue / pull request を取り込む

poller は 1 run で最大 200 件を fetch する一方、embed するのは最大 50 件で、旧実装は batch 全体を追い越して watermark を進めていた。embedding 予算で見送った項目には retry の印が付くが、以後どの `since` window もそれを fetch しない。結果として、索引対象 repository の issue / pull request 履歴の約 55% が一度も索引に載っていなかった（issue #210）。watermark は発生源側で修正済みだが、それは漏れを止めるだけ — 取り残された項目が再 fetch されるのは `updated_at` が動いたときだけで、閉じた履歴はもう動かない。この endpoint が欠落そのものを走査する。

実行は watermark 修正の deploy の**後**。順序を逆にすると、backfill 済みの索引に、同じ穴から落ちた新しい項目が混ざる。

Admin endpoint:

```text
POST /admin/backfill-issue-index?repo=owner/repo
```

パラメータ:

- `repo` — `owner/repo`
- `dry_run` — `true` で走査範囲の欠落量だけを測り、GitHub からは何も取得しない
- `limit` — 1 回の呼び出しで試す候補番号の数、`1..20`（既定 `15`）。dry run では無視される
- `cursor` — 再開位置の issue 番号。前回のレスポンスの `nextCursor` をそのまま渡す

認証:

- `GITHUB_TOKEN` ヘッダに worker secret と同じ値を送る

レスポンス:

```json
{ "repo": "owner/repo", "dryRun": false, "cursor": 0, "limit": 15, "maxNumber": 1690,
  "scannedTo": 603, "candidates": 15, "attempted": 15, "indexed": 14, "absent": 1,
  "failed": 0, "nextCursor": 603, "done": false }
```

運用上の注意:

- まず `dry_run=true` で規模を測る。embedding 予算を使わず、走査した範囲（1 回あたり最大 5000 番）の `candidates` を返す
- `done` が `true` になるまで `nextCursor` を渡して繰り返し呼ぶ。既定の `limit` なら 900 件欠けている repository で 60 回
- 上の 2 つの修復と違い、この endpoint は **embed する**。しかも 1 候補あたりの取り込み fan-out が高価で、実測で 1 invocation の 1000 subrequest のうち約 40 を消費する（issue #216）。既定値はその実測に合わせてある — `15` は本番で `failed: 0` を実測した最大値、`25` は毎回最後の 1 件を落とし、`50` は `Too many subrequests by single Worker invocation` で呼び出し全体が失敗した。`20` を超える指定は拒否される
- `limit` は厳密でなくてよい。**取り込みそこねた最初の候補の 1 つ手前で cursor を止める**ので、次の呼び出しはその番号から再開する（追い越さない）。`limit` が大きすぎたときの代償は 1 回分の無駄な呼び出しであって、取りこぼしではない
- 何度実行しても安全。`search_docs` に行がある番号は fetch すらしないので、完了済みの sweep を再実行すると `candidates: 0` が返る。途中で失敗した呼び出しは同じ `cursor` から再開する
- `absent` は GitHub が 404 を返す番号の数（削除された issue、transfer で repository の外に出た番号）。これらは以後の sweep でも候補に残り続けるので、完了した repository でも `candidates` が小さな非ゼロを返すことがある。これらで cursor は止めない — 誰が何回試しても取り込めない番号なので、そこで止めると retry の境界にならず sweep が永久に停止する
- `failed` は embed が着地しなかった候補の数。cursor をその最初の 1 件の手前で止めているので、次の呼び出しがまずそれを再試行する
- したがって、毎回必ず失敗する候補があると sweep は止まる。止まったことは応答に現れる — `nextCursor` が渡した `cursor` と同じ値で返り、`failed` が 1 以上になる。手動で越えるには `cursor = nextCursor + 1` を渡す（詰まっている番号は `nextCursor + 1`、run log にも `held before #N` として出る）
- 取り込みは body-hash 判定を強制的に飛ばすので、vector はあるが FTS5 行が無い項目も修復される。次の poll を待つのでは代替できない理由がここ
- 確認は distinct な番号を数える: `SELECT COUNT(DISTINCT number) FROM search_docs WHERE repo = ? AND type IN ('issue','pull_request')` が実際の issue + PR 件数に近づく

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
