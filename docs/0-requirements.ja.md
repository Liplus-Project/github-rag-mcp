# github-rag-mcp 要求仕様

言語: [English](0-requirements.md) | 日本語

## Overview

`github-rag-mcp` は GitHub 上の project state を AI agent が検索・取得できるようにする MCP サーバーです。

対象にする artifact:

- issue
- pull request
- release
- repository documentation
- commit diff（削除済みファイルを含む判断履歴）

このシステムの目標は transcript memory ではなく recoverable project state です。

本プロジェクトは GitHub を shared working memory として扱います。

- issue は要件、未解決事項、タスク状態を保持する
- pull request は実装、review、CI 状態を保持する
- docs は固定化された理解を保持する
- release は出荷済みの節目を保持する
- commit diff は「その時点でどう判断して何を変えたか」の履歴を保持する（削除済みファイル・非 .md 拡張子を含む）

agent が行動するときは、必要な状態の断面を search で引き戻します。

カウンターパート:

- [github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp) は push ベースの awareness を担う
- `github-rag-mcp` は durable state 上の retrieval を担う

## Principles

### State over complete memory

会話や思考過程を丸ごと保存することは目指さない。

次の正しい行動に必要な state を保存し、取り戻せるようにすることを目指す。

### No unnecessary additions

memory layer は GitHub artifact の意味を変えるような推測や装飾を足さない。

### No loss of required information

memory layer は別 agent や別 session が安全に続きを行うために必要な制約、判断、現在地を落とさない。

### Human-visible memory

source of truth は引き続き人間が読める GitHub artifact にある。retrieval はその上に載る index であり、置き換えではない。

## Architecture

```text
GitHub webhooks + GitHub API
            |
            v
     Cloudflare Worker
     + MCP surface
     + webhook receiver
     + cron poller
     + embedding pipeline
     + hybrid retrieval (dense + sparse + RRF fusion + cross-encoder rerank)
            |
            +--> Vectorize             (dense: BGE-M3 1024d, cosine)
            +--> D1 FTS5               (sparse: BM25, porter + trigram)
            +--> Durable Object/SQLite (structured state, watermarks)
            +--> Workers AI BGE-M3     (embedding generation)
            +--> Workers AI bge-reranker-base (cross-encoder rerank)
```

## Components

### 1. MCP Surface

worker は HTTP 上で MCP tools を公開する。

Responsibilities:

- 認証済み MCP request を受ける
- semantic retrieval と structured retrieval の tool を公開する
- downstream agent がそのまま使える形式で state を返す

スキーマの source of truth は Worker 側の tool 定義。client proxy
(`mcp-server/server/tools.js`) は `tools/list` を Worker へ転送せず、`search`
params の静的ミラーから応答する（起動時を auth/network なしに保つため）。ミラーは
手動保守ゆえ、Worker に param を足して proxy を忘れると、MCP クライアントが
`additionalProperties: false` で黙って落とし Worker に届かない（gh#157）。
`scripts/check-schema-drift.mjs` を CI で実行し、proxy の `search` スキーマが Worker
からズレたら build を失敗させる。両者は同期せずに出荷できない。
比較する軸は 2 つ、param 名と enum param の値。名前だけの比較では proxy の `type`
enum から `wiki_doc` が抜けたまま気付けず、Worker は受け付けるのにクライアント側で
値が弾かれていた（gh#181）。

### 2. Webhook Receiver

webhook receiver は GitHub event を near real time で取り込む。

対象 event family:

- `issues`
- `pull_request`
- `release`
- `push`

Responsibilities:

- `GITHUB_WEBHOOK_SECRET` で署名検証する
- GitHub source IP を検証する
- event を embedding pipeline に渡す
- semantic store と structured store の両方を更新する

`push` はリポジトリ内の全 `.md` ファイルの変更検出に使う。同じ `push` event から per-commit diff も index する（1 commit × N files → N vector、各 vector は commit message + file path + patch を embedding input にする）。これにより削除済みファイルや非 `.md` 拡張子の判断履歴も semantic 検索可能になる。

### 3. Cron Poller

cron poller は fallback path である。

Responsibilities:

- webhook 取りこぼしを補償する
- 新しい repository の backfill を行う
- issue、pull request、release、docs、GitHub Wiki page、issue/PR comments、commit diff の変更を再取得する
- 一時障害後も store を収束させる

現在の deployment では hourly で 4 つの cron trigger に分けて実行する。各 upsert が Store DO + Vectorize + D1 FTS + AI embed と最大 4 internal fetch を生むため、heavy 同居 (comments + diffs) でも per-Worker subrequest 上限を超える。surface 単独単位で 15 分ずつずらして発火させる:

- **`0 * * * *` (light)** — issues / pull requests / releases / docs
- **`15 * * * *` (comments)** — issue/PR comments のみ
- **`30 * * * *` (diffs)** — commit diffs のみ
- **`45 * * * *` (wiki)** — GitHub Wiki page のみ

各 invocation は独立した subrequest 予算を持つ。dispatch は `controller.cron` で `handleScheduled` 内で行う。未知の cron 表現は no-op log で silent regression を防止する。

commit diff poller は 2-phase 構成:

- **forward phase** — `(lastPolledAt, pollStartTime]` の window を列挙し、その中の**古い側から**取り込む（webhook 取りこぼし時の redundancy）。watermark namespace は `diffs:${repo}`。
- **backward phase** — `until=oldestUnprocessedDate` で履歴を徐々に遡行する（新規 deployment や webhook 起動前の commit を backfill する経路）。watermark namespace は `diffs_backfill:${repo}`。

1 run あたりの取り込み上限は forward / backward それぞれ 5 commits。`processAndUpsertCommitDiff` の upsert は `(repo, commit_sha, file_path)` で idempotent なので、webhook / 両 phase 間で overlap しても副作用はない。

両 phase は同一の watermark 不変条件に従う: **取り込みに成功していない commit を watermark が追い越さない。** commit が「取り込み済み」とみなされるのは、detail 取得が成功し、かつ `processAndUpsertCommitDiff` の failed が 0 の場合のみ（embedding / Vectorize の失敗は throw ではなく戻り値で報告されるため、戻り値も判定に含める）。判定は dense 側のみを見る: D1 FTS mirror / store row の失敗は pipeline 側で log のみ・failed に計上しない設計で、vector は既に landing 済み・sparse index は reindex で reconcile されるため。mirror 側まで watermark の条件にすると、FTS 側の障害が diff surface 全体を止めてしまう。帰結:

- 失敗した commit と、1 run 上限で持ち越された commit は、次回 run の window に残る
- commit list 取得が失敗した run は watermark を動かさないので、その期間全体が再試行対象のまま残る
- forward phase は window の古い端を確定してからでないと watermark を進められないため、window は 100 件/page で列挙する。page が満杯なら「列挙不能」とみなして window 終端を半分に縮める（最大 8 回）。それでも収まらない場合は watermark を保持して log に出す — silent な欠損より、観測できる stall を選ぶ。

トレードオフは liveness で、毎回失敗し続ける commit はその phase の watermark を止める。run log に境界 commit の SHA が出るほか、`POST /admin/diff-watermark`（installation guide 参照）で watermark を手動で移動できる。旧版 poller が取りこぼした期間を再走査させる経路も同じ endpoint。

wiki poller は `:45` cron 専属で、GitHub Wiki content の唯一の取り込み経路。Wiki は別 git repo (`{repo}.wiki.git`) に存在し、REST API も webhook event も持たないため、poller が repo ごとに 3 段の HTTP 呼び出しで処理する:

1. `https://github.com/{repo}.wiki.git/info/refs?service=git-upload-pack` を打って wiki 存在検出（200 = 存在、404 = 無効化済 or 未設置 = skip）。
2. `/{repo}/wiki/_pages` HTML を scrape して page slug を列挙（`/{repo}/wiki/{slug}` 形式の link を tolerant な regex で拾う、`_pages` / `_history` / `_new` 等の特殊 pseudo-page は除外）。この index には効いてくる癖が 2 つある（issue #184）: `Home` は実在するのに列挙に現れないので無条件で union する。そして slug は page title の**不可逆な**変換で（`E. Li+language` は `E.-Li-language` に routing されるが実ファイルは `E.-Li+language.md`）、link の表示テキストを 2 つ目のファイル名候補として保持する。
3. 各 page について `https://raw.githubusercontent.com/wiki/{repo}/{name}.{ext}` から raw markup を取得（`name` は title 由来のファイル名を先に、slug を後に試す）。markup 拡張子は probe 順 (`md` → `markdown`) で検出、次回以降は前回ヒット拡張子を再利用して probe を省略。probe 集合を絞ってあるのは意図的で、1 回の miss が invocation の 1000 subrequest を 1 消費するため（issue #130）。

変更検出は SHA-256 content hash（wiki git smart-HTTP を叩かないと git blob SHA は取れないため、content 直接 hash）。hash 差分のある page だけ re-embed。

**カバレッジ.** page 走査の上限は `MAX_WIKI_FETCHES_PER_REPO_PER_RUN`（既定 20）。page 単位ではなく **HTTP 試行単位**で数えるので、候補を複数持つ page が fan-out で上限を超えることはない。この予算は深い wiki より小さいため、走査は**循環し、保存された cursor から再開する** — 最後に probe した slug を `wiki:{repo}` watermark 行の `etag` 列に置くので、schema 変更は不要。結果として全 page が ceil(pages / 予算) run 以内に到達する。毎 run 列挙の先頭から舐め直す実装が、位置 20 以降を構造的に到達不能にし、77 page の wiki の大半を未索引のまま放置していた（issue #184）。`MAX_WIKI_EMBEDDINGS_PER_RUN`（既定 30）は別軸のまま — Workers AI の embed 予算の上限であって、走査の上限ではない。

**周回の完了.** 2 本目の watermark 行 `wiki-lap:{repo}` が *lap anchor* — 現在の周回がどの slug の次から始まったか — を保持する。pass は anchor の直前の page に到達した時点、つまり cursor が一周して戻ってきた時点で `wrapped: true` を返し、anchor はその page へ移動して次の周回がその次から始まる。これが admin endpoint の `done` を到達可能にしている。「この 1 回の pass で全 page を踏破した」という意味では、1 pass の fetch 予算より page 数が多い wiki で真になりようがなく、「`done` まで呼び続けろ」という手順に停止条件が無かった（issue #188）。anchor は保存した index ではなく slug 順で解決するので、周回の途中で page が増減しても desync しない。`cursor=` を明示指定した場合はその地点から新しい周回を開始する。

**孤児の削除.** 現在の `_pages` index に無い page は Vectorize / D1 FTS5 / graph edge table / structured store から削除する。候補集合は structured store **と** 実際の `search_docs` 行の和集合。store から消えているのに index には残っている page は store だけを見る差分からは見えず、これが改名済み 8 page を数ヶ月間 search から引ける状態で残した原因だった（issue #184）。影響範囲は 3 つの guard で抑える — `_pages` index が読めなかった run では削除を完全に skip（空の slug 集合は「全部消えた」ではなく「こちらが盲目」の意）、1 repo 1 run あたり `MAX_WIKI_DELETIONS_PER_REPO_PER_RUN`（既定 5）で cap、各 surface は独立に teardown して Vectorize の失敗が実際に retrieval される D1 行を取り残さないようにする。

**即時復旧.** `POST /admin/backfill-wiki?repo=owner/repo[&limit=N][&cursor=SLUG]` が同じ pass を明示予算（1..40、既定 20）で即時実行する。cron と cursor を共有するので互いに前進させ合う。response の `done: true` まで繰り返し呼ぶ — 1 周に必要な呼び出し回数は 1 回ではなく ceil(pages / limit) 回。`cursor=`（空）を渡すと列挙の先頭から walk（と周回）をやり直す。各 call は独立した Worker invocation なので、それぞれ独自の subrequest 予算を持つ。

### 4. Embedding Pipeline

embedding model:

- `@cf/baai/bge-m3`

現行実装:

- 1024 dimensions
- cosine similarity
- issue / release は body hash で変更検出する
- documentation は blob SHA で変更検出する
- commit diff は append-only。一度 index した (commit_sha, file_path) は再計算しない

Responsibilities:

- title + body または path + content から embedding input を作る
- 安全な場合は unchanged record を skip する
- vector と metadata を Vectorize に upsert する
- 同じ content を D1 FTS5 の `search_docs` table にも upsert する（sparse 側同期、tokenizer_kind は type に応じて `nat` / `code` を自動選択）
- embedding 失敗時も次回 retry できる状態を保つ
- D1 FTS5 upsert 失敗は Vectorize upsert を無効化しない（次回 reindex で reconcile）
- commit diff は 1 commit 分の file リストを batch embed（Workers AI の `text: string[]` 対応を利用）し、1 回の Vectorize upsert で N vector を書き込む
- batch size は `MAX_EMBEDDING_BATCH_SIZE`（既定 20）で上限。これを超える commit は複数 batch call に分割する

### 5. Vector Store (Dense)

Vectorize は hybrid retrieval の dense 側を担う。次の metadata を伴う semantic embedding を保持する。

- repository
- item type（`issue` / `pull_request` / `release` / `doc` / `diff`）
- state
- labels（個別スロット label_0..3 + CSV フォールバック）
- milestone
- assignees（個別スロット assignee_0..1 + CSV フォールバック）
- update timestamp
- release tag name
- documentation path
- commit SHA / file path / file status / commit date / commit author / blob SHA（diff only）

Metadata index（10/10 枠使用）:

- Pre-filter 対応: repo, type, state, milestone
- 将来の pre-filter 用に格納: label_0, label_1, label_2, label_3, assignee_0, assignee_1

Vectorize の metadata filter はフィールド間で AND のみサポートし、OR は非対応。`label_0 = "bug" OR label_1 = "bug"` のようなクエリは表現できない。そのため labels / assignees は overfetch + post-filter で recall を改善している。Vectorize が OR または `$in`-across-fields をサポートした時点で、個別フィールドは即座に pre-filter 化可能。

vector store は semantic retrieval layer であり、canonical state store ではない。

### 6. Full-Text Index (Sparse, D1 FTS5 / BM25)

D1 の FTS5 virtual table は hybrid retrieval の sparse 側を担う。

採用理由:

- dense-only retrieval はコード識別子、固有名詞、SHA、exact term などの sparse 情報で recall を落とす構造弱点が既知
- 2026 時点の業界標準では hybrid search が production baseline (reranker は併用例もある別階層)
- Cloudflare D1 は SQLite FTS5 pre-compiled、BM25 ranking 内蔵、Workers から virtual table として利用可能

Schema 概要:

- `search_docs` — external content table（source of truth、vector_id を primary key）。索引対象テキストを 2 列で持つ: `content` が生本文、`content_fts` が分かち書き済み本文
- `search_docs_nat_fts_v3` — porter + unicode61 tokenizer の稼働中 FTS5 virtual table（自然言語: issue / PR / release / doc / wiki_doc / comment / review）。external content は `content_fts`
- `search_docs_code_fts_v2` — trigram tokenizer の稼働中 FTS5 virtual table（コード / SHA / identifier: diff）。external content は生の `content`。旧世代（nat v2 および v1 の 2 table）は過去の corruption を修復時に触らないため残すが、query / update 対象にはしない

tokenizer 選択:

- `porter` — 自然言語の stem matching に適する
- `trigram` — SHA prefix、CamelCase、file path などの部分一致に適する
- tokenizer_kind 列で row をどちらの virtual table に振り分けるか決定
- 各稼働中 FTS table は `search_docs` の tokenizer-filtered view を external-content relation に指定し、宣言上の content row 集合と実際の index row 集合を一致させる。trigger で自動 sync し、すべての分岐を `tokenizer_kind` で guard して、各 row は片方の FTS5 table にだけ insert / delete する。索引したことのない反対側 tokenizer に FTS5 `delete` command を送ることは禁止する（external-content index が壊れるため）
- 復旧時は新しい FTS generation を作り、`WHERE tokenizer_kind = ...` で各 table を個別 backfill する。FTS5 `rebuild` は全 `search_docs` row を各 tokenizer に流して同じ分離不変条件を壊すため使用しない

分かち書き（自然文側）:

- `unicode61` は非英数字でしか token を切らない。日本語には区切り記号が無いため仮名漢字の連なりが丸ごと 1 token になり、日本語の句クエリは何にも当たらない。本 corpus の大半が日本語であるため、hybrid retrieval が実質 dense 単独に退化していた
- D1 はカスタム tokenizer を読み込めない（`tokenize = 'icu'` は `no such tokenizer: icu` で失敗する）。したがって語境界は SQLite に渡る前に挿入する必要がある
- 分割には `Intl.Segmenter`（workerd 同梱、依存追加なし）を使う。索引側と検索側の両方で走らせる: 取り込み経路は分かち書き済み本文を `content_fts` に格納し、検索経路は分かち書き済みクエリから nat 側の `MATCH` 文字列を組む。**対称性が正しさの条件**である。カタカナ語などは誤分割するが、クエリ側も同じ誤分割を通るため、劣化するのは精度だけで再現率は落ちない
- CJK を含まないテキストは素通しするため、英語の挙動は前世代と byte 単位で同一
- nat 分岐と code 分岐は同一クエリから**別々の** `MATCH` 文字列を組む（nat = 分かち書き後、code = 生。挿入した空白は trigram の部分一致を壊すため）
- `content` を生のまま保持するのは、reranker の入力であり、かつ trigram index の索引対象であるため
- migration 0006 は `content_fts` を `content` のコピーで初期化することしかできない（分かち書きは JS にしか存在しない）。既存 row の再分割は `POST /admin/backfill-fts-segments` が `rowid` cursor でバッチ実行する。分かち書き済みの row は書き込まずに skip するため idempotent で、中断しても先頭から再実行できる

クエリ長の階層化（nat 側）:

- 全トークンを要求する連言 `MATCH` は、クエリが長くなるほど満たすのが単調に難しくなる。本番で同一の索引済み文書に対し実測すると、3 トークンで候補 3 件、約 12 トークンで 2 件、約 17 トークンで 0 件だった。自然文の問いはまさにこの帯域に入るため、hybrid の sparse 側が実効していたのは短い単語列に対してだけだった
- この崖は言語非依存である。日本語は分かち書きで助詞が独立トークンになるぶん早く到達するが、英語の長文クエリでも落ちる。したがって対処も言語非依存にする（stopword / 助詞のリストは持たない）
- nat 側は strict（全トークン）と relaxed（いずれかのトークン）の **2 本**の `MATCH` 文字列を、同一 UNION の別 arm として `tier` 列付きで発行し、BM25 score より先に tier で並べる。strict の hit は従来と同じ順位を保ち、relaxed はその下に追加されるだけなので、短いクエリの precision は退行しない。relaxed が見えるのは strict が `topK` を埋めきれなかった分だけ——それが崖そのものである。クエリ長の閾値は不要
- relaxed 側の precision は BM25 が担う。IDF 重みが「より多くの・よりレアな語を含む文書」を上位に置き、高頻度の機能語（`の` / `は` / `the` / `of`）の寄与をほぼ 0 にする。stopword リストがやるはずの仕事を、リストを持たずに ranker がやる
- 2 tier を「AND が 0 件なら OR で再試行」ではなく単一 statement に載せるのは、再試行形式が D1 への往復を 1 回増やすうえ、実測の中間帯（約 12 トークンで弱い 2 件）を改善しないため。受容したコスト: relaxed arm は全クエリトークンの posting list を辿るので、長いクエリでは従来より読む row が増える。問題化した場合の次の手は `fts5vocab` table を使った IDF ベースの語の刈り込みであり、手書きの stopword リストではない
- 同一文書が両 tier から返り得るため、`topK` で切る前に `vector_id` で重複排除する（tier が良い方、次に score が良い方を残す）
- code（trigram）arm は strict のまま。識別子の部分一致は同じ崖を持たない

vector_id は Vectorize 側と同一（deterministic SHA-256 ベース）で、RRF 合成時に dense hit と sparse hit を追加 round-trip なしで join できる。

Vectorize metadata filter と同じく、`repo` / `type` / `state` / `milestone` は SQL WHERE 句で pre-filter する。

BM25 ranking 関数 `bm25(<fts_table>)` で score を取得する。値が小さいほど good match。RRF 合成では rank に変換する。

### 7. Structured State Store

Durable Object + SQLite は次の structured record を保持する。

- issue / pull request
- release
- documentation file state（repo `docs/` 等の `.md` ファイル）
- GitHub Wiki page state（page slug、拡張子、content hash）
- commit diff file state（1 row = 1 file-in-commit）
- polling watermark

この store は次を支える。

- `get_issue_context`
- `list_recent_activity`
- semantic search hit の enrichment

**recency window.** `/recent*` 系 endpoint は、各 surface 自身の timestamp 列（`updated_at` / `published_at` / `commit_date`）に対する半開区間 `[since, until)` を新しい順・最大 `limit` 件で読む。両端とも SQL の条件である。`until` を返り値側で後置フィルタすると古い窓に到達できない——cap が先に最新側を取り、フィルタがそれを全部落とすため、数千行ある窓でも 0 件に見える（issue #194）。endpoint あたりの cap は subrequest / D1 読み取り予算の境界として維持するが、これは「窓を置き換える」ものではなく「窓の中を打ち切る」ものになった。

### 8. Graph Index（opt-in, D1 `doc_edges`）

判断知（Decision Structure = wiki の kebab エントリ）の関係を索引化する additive なグラフ層。dense（Vectorize）/ sparse（FTS5）に並ぶ第3の surface だが、**既定では retrieval から読まれない**。

- **スキーマ**: `doc_edges(src_vector_id, dst_vector_id, repo, src_slug, dst_slug, edge_kind, updated_at)`（`migrations/0002_graph_edges.sql`）。src/dst は wiki の決定的 vector_id（`wikiDocVectorId`）。
- **エッジ抽出**: wiki ページ index 時（`processAndUpsertWikiDoc`）、同 repo の既知 wiki slug が本文に出現したら A→B の "mention" エッジを生成（`src/graph.ts` の `indexWikiEdges`）。**決定的 slug-match（LLM 不要・ロスなし）**。dst は計算で求まるので未 index でも記録可（dangling 可）。typed（supersede/depend/conflict）は将来スコープ。
- **traversal**: `queryNeighbors` が `WITH RECURSIVE`（標準 SQLite、拡張不要）で seed の 1–2 hop neighbor を無向に辿る。
- **retrieval 統合**: `search` の `graph_expand`（既定 false）/ `graph_hops`（既定 1）。true の時のみ、RRF 後の最終結果を seed に neighbor を辿り、関連 wiki ページを `graph_hop` / `graph_from` 付きで末尾に append。**false の時は既存挙動と完全同一（回帰なし）**。
- **delete fan-out**: wiki ページ削除時に `deleteEdgesForVector`（当該 vector を端点に持つエッジを除去）。
- **backfill**: `POST /admin/backfill-edges?repo=owner/repo`（GITHUB_TOKEN ヘッダ）。既存 index 済み wiki の content から一括抽出（GitHub 再取得不要）。
- **評価**: 本番 ship 後の実運用観測（judgment-learning が関連判断を拾えるか）。offline eval harness は作らない。

## Retrieval Model

retrieval layer は hybrid search（dense + sparse）+ cross-encoder rerank + structured filter を 3 段で支える（2026 production baseline）。

### 3-tier Hybrid Retrieval (default)

想定フロー:

1. query の embedding を Workers AI BGE-M3 で生成
2. structured params から Vectorize filter（dense 側）と D1 SQL WHERE（sparse 側）を同時構築（repo, state, type, milestone は pre-filter）
3. labels / assignee フィルタ指定時、または reranker 有効時は内部 topK をオーバーフェッチ（requestedTopK × 5, max 50）。reranker は最大 50 件まで処理
4. dense (Vectorize.query) と sparse (D1 FTS5 MATCH + BM25) を並列実行
5. 両 ranker の結果を Reciprocal Rank Fusion（RRF、k=60）で合成
6. 合成後の rank 順に、labels（AND ロジック、個別フィールド + CSV フォールバック）と assignee を post-filter
7. reranker 有効時（default ON）は post-filter 後の候補を `@cf/baai/bge-reranker-base` で re-score し、reranker score 降順に並び替え
8. requestedTopK にトリムして structured context と共に返す

#### Reciprocal Rank Fusion (RRF)

RRF 公式:

```
score(d) = sum_over_rankers ( 1 / (k + rank_r(d)) )
```

- k = 60（Cormack et al. 2009 の canonical 値、Elasticsearch / Vespa / Milvus などの production default）
- rank_r(d) は ranker r における document d の 1-based rank（その ranker にヒットしていない場合は contribution 0）
- dense と sparse で score の scale が非互換でも、rank に正規化することで合成可能
- 片側にしかヒットしない document も部分点を得られる（recall boost）

### Cross-encoder Reranker

3 段目の reranker は `@cf/baai/bge-reranker-base`（Workers AI）を使用する。

採用理由:

- 2026 業界標準で reranker は production baseline の必須層（hybrid + reranker）。Cloudflare AI Search 公式 (2026-04-16) も `@cf/baai/bge-reranker-base` を rerank primitive として組み込み済
- bi-encoder（BGE-M3）と sparse BM25 は recall 向上には強いが、precision@k では cross-encoder に劣る。RRF で fuse した上位候補を cross-encoder で re-rank することで precision を底上げできる
- 既存 BGE-M3 embedding と同じ `env.AI` primitive で呼び出せるため追加 binding 不要

実装制約と既知の限界:

- bge-reranker-base は context window 512 tokens（BAAI 元仕様）。`(query, candidate content)` pair が超過しないよう char-budget ベースで truncate（query 200 chars 上限、pair 合計 1700 chars 上限）
- Workers AI は `contexts[].text` に length >= 1 を要求（エラー 5006: "Length of '/contexts/N/text' must be >= 1 not met"）。呼び出し時点で content が空のままの候補は rerank 入力から除外する（残った件数が 0 / 1 の場合は AI 呼び出しをスキップして passthrough）
- reranker 入力の本文は 2 系統から供給する。sparse（FTS5）hit を持つ候補は本文を inline で保持している。dense-only 候補は FTS row が無いため、D1 `search_docs` から `vector_id IN (...)` の一括クエリ 1 回で本文を補完する（1 件ずつの fan-out はしない）。最も顕著だったのは nat index を分かち書きする前の日本語 query で、FTS5 のトークン化で BM25 hit が 0 件になり全候補が dense-only になるため、補完が無いと候補集合が空本文のまま reranker に渡り cross-encoder が一度も動かなかった。分かち書きでこの原因は解消したが、sparse 側が取りこぼした候補は依然として本文を持たずに届くので、補完自体は引き続き必要である。補完中の D1 失敗は致命的に扱わず、既に得られている本文だけで検索を継続する
- `rerank_applied: true` は、実際に 1 件以上へ reranker score が付与された場合にのみ報告する。空の reranker 結果（スコア可能な本文が 0 件）は失敗と同じ扱いで、fusion 順を維持し `rerank_applied: false` とする。不変条件: `rerank_applied: true` なら必ず 1 件以上の `rerank_score` が non-null
- reranker は最大 50 件 / 1 検索（Workers AI Free tier 10,000 neurons/day と業界中央値の整合点）
- bge-reranker-base は英語ベース・多言語非対応。日本語 issue/PR では精度低下リスクあり（runtime 観察対象、将来的に bge-reranker-v2-m3 提供開始時または外部 reranker への切替を別 issue で検討）。上記の dense-only 本文補完は cross-encoder を「動かす」ためのものであって、モデルを多言語対応にするものではない。順位品質は別軸のまま
- reranker 呼び出し失敗・想定外レスポンス時は graceful fallback（fusion 順を維持、`rerank_applied: false` で通知）

呼び出しコスト試算:

- Workers AI 公式単価: bge-reranker-base = 283 neurons/M tokens
- 1 検索あたり試算: 約 7.5 neurons (query 30 tokens + 候補 50 件 × 平均 500 tokens, embedding 含む)
- Free tier 10,000 neurons/day で約 1,300 検索/day 上限
- neuron 実測値はレスポンスに `usage` フィールドが含まれる場合に取得し、理論試算と照合する（公式未文書化のため存在しない場合は黙ってスキップ）

### 切替オプション

`search` の `fusion` パラメータで retrieval mode を切り替え可能:

- `rrf` (default) — dense + sparse を RRF で合成
- `dense_only` — Vectorize のみ（debug、semantic 特化クエリ）
- `sparse_only` — D1 FTS5 BM25 のみ（debug、exact term / identifier クエリ）

`rerank` パラメータで cross-encoder rerank を切り替え可能:

- `true` (default) — RRF 合成後に bge-reranker-base で re-score
- `false` — rerank skip（faster、Workers AI rerank cost なし。短い識別子クエリで lexical match が決定的な場合や debug に推奨）

この retrieval layer の目的は keyword match ではなく working state の復元である。3 段化の意図は、BGE-M3 の semantic 表現が弱い短い識別子・SHA prefix・固有名詞で sparse がカバーし、RRF で recall を確保しつつ、cross-encoder で precision を底上げすることにある。

## MCP Tools

### `search`

Purpose:

- issue / pull request / release / documentation / commit diff を **3-tier hybrid search**（dense + sparse BM25 → RRF 合成 → cross-encoder rerank）で引く
- `type: "diff"` 指定で判断履歴（削除済みファイル・非 .md 拡張子を含む）を引ける

Parameters:

- `query` required
- `repo` optional
- `state` optional
- `labels` optional
- `milestone` optional
- `assignee` optional
- `type` optional
- `top_k` optional
- `fusion` optional — `rrf` (default) / `dense_only` / `sparse_only`
- `rerank` optional — `true` (default) / `false`
- `since` / `until` optional — 半開区間 `[since, until)` の時間窓

Returns:

- repository、type、state、labels、milestone、assignees、URL、RRF fused score を含む ranked match
- 追加 debug フィールド: `dense_score`、`sparse_score`、`dense_rank`、`sparse_rank`、`rerank_score`（rerank 無効時または fallback 時は null）
- top-level metadata: `fusion`、`dense_candidates`、`sparse_candidates`、`rerank_requested`、`rerank_applied`

**scan mode（query 空）.** Vectorize / FTS5 / reranker を経由せず、structured store の recency endpoint から集約する。`since` / `until` は store 側へ push down されるので、窓に行があれば、その窓がどれだけ古くても返る。`since` 省略時の既定は `until` の 7 日前（`until` も省略時は現在の 7 日前）。`until` だけ指定した問い合わせが「下限が上限より新しい空窓」に潰れないための既定である。

scan mode は top-level に `truncated` を追加する。窓が応答に載せた以上の行を持つとき true になる（endpoint が cap 一杯まで返した、または merge 後の件数が `top_k` を超えた）。これが「該当なし」と「読み切れていない」を呼び出し側に区別させる: 返った最古の行の時刻を次の `until` にして遡ればよい。両者を区別できない欠損調査ツールは、存在しない欠損を報告し実在する取り込みを見落とす——#178 の再検証で 1 日に 2 度踏んだ誤りがこれである。

### `get_issue_context`

Purpose:

- 単一 issue または pull request の周辺 state を集約する

Returns:

- issue / PR details
- linked PRs
- branch information
- CI status
- sub-issues
- 推定可能な related releases

### `list_recent_activity`

Purpose:

- tracked repository 群の recent activity feed を返す

Returns:

- created / updated / closed issue / PR activity
- release publication activity
- documentation update activity
- commit diff indexing activity

## Authentication

認証は GitHub App + OAuth 2.1 を使う。

Requirements:

- MCP client user を認証する
- installation 済み repository に access する
- GitHub API read に token を使う
- cached Dynamic Client Registration は、登録済み redirect URI 集合が今回の
  OAuth flow で要求する localhost callback URI を全て含む場合だけ再利用し、
  含まない場合は authorization 前に client registration を置き換える

## Storage Rules

### Canonical memory surfaces

canonical project memory は引き続き GitHub artifact 側にある。

- issue body と label
- pull request と review state
- repository docs
- releases
- commit history（diff）

retrieval system はそれらを index する。source of truth を置き換えない。

### Update behavior

- webhook update はできるだけ早く反映する
- cron は drift を解消する
- embedding failure は次回 retry 可能でなければならない
- delete された issue / PR / release / doc は semantic index（Vectorize）と sparse index（D1 FTS5）の両方から削除する
- commit diff は append-only なので delete 経路対象外

## Current Deployment Assumptions

- TypeScript codebase
- Cloudflare Workers runtime
- Vectorize for dense semantic search（hybrid retrieval の dense 側）
- Cloudflare D1 for FTS5 BM25 sparse search（hybrid retrieval の sparse 側、migration 経由でスキーマ管理）
- Workers AI for embedding generation
- Durable Object / SQLite for structured state
- `POLL_REPOS` により 1 deployment で複数 repository を追跡できる

## Operational Constraints

### Worker invocation pressure

1 invocation あたりの Workers AI 呼び出しには制限があるため、embedding work は保守的に batch する必要がある。

### Cron CPU pressure

大きな initial sync は CPU limit を超えうるため、pagination と resumable watermark が必要である。

### Durable Object resets

deployment により Durable Object state が reset されることがあるため、webhook と cron の両経路から GitHub を再読して回復できる必要がある。

### Free-tier hard stop（D1 / Vectorize / Workers AI）

Workers AI Free（10,000 Neurons/day）、D1 Free、Vectorize Free はいずれも daily / monthly limit 超過で `operations will fail with an error` の hard stop 規約。overage billing は Paid plan 契約時のみ発生する。AI Search（managed）採用しないため AI Search 固有の hard stop 不確実性はスコープ外。

### Retry safety

embedding が失敗した record は incomplete と分かる形で残し、次回 run で retry できるようにする。

## Future Scope

- ranking と filtering の改善
- multi-agent handoff retrieval の改善
- cross-repository state recovery の改善
