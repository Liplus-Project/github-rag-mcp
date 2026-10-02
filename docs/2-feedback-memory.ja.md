# 非公開の検索 feedback memory

言語: [English](2-feedback-memory.md) | 日本語

Issue #259 の4機能である検索履歴、資料の明示的利用、時間減衰する活性度、取り消せる関係強化を同じ trace 契約で提供する。保存対象は query、検索設定、返した資料の provenance と明示判断。会話全体、資料本文やタイトル、credential、認証 props は複製しない。

## 資料と trace の識別

成功した `search`（search / scan / stored-content fetch / 0件）は UTC trace を保存してから `trace_id`、`timestamp`、`feedback_available:true` を返す。資料と `same_entity.others` には `source_id`、`provenance`、現在の `activation` を追加する。request は query/filter/control、settings は mode、有効な scan 窓、fusion/rerank 実施結果と両軸を保存する。

provenance は `{repo,type,identity,version,content_source}`。identity は issue/PR number、release tag、doc/wiki path、diff の `[commit_sha,file_path]`、GitHub comment/review ID。`content_source:"index"` の version は取得した `updated_at`（doc/wiki は索引 snapshot の timestamp）。live inline doc/wiki 本文は `content_source:"github_live"` と `content_version:"sha256:<返した UTF-8 本文の hash>"` を持ち、この hash を provenance の version と source ID に使う。`index_updated_at` は索引 timestamp を補足 audit として保存し、live 版は定義しない。同じ live 本文は索引 timestamp が変わっても同じ版、本文が変われば索引 timestamp が固定でも別 source_id。stored-content fetch と graph 本文は索引コピーで、index provenance を維持する。memory に保存するのは hash/provenance のみで、live 本文は複製しない。mode、vector handle、任意の補足 field は ID の hash に含めない。

`source_id` は実体の特定版を識別する。同じ実体・同じ取得版は vector ID が移行しても同じ ID、更新版は別 ID になる。activation は版単位。mention strength は `[repo,src_slug,dst_slug,edge_kind]` 単位で、vector ID や資料版から独立している。reindex は principal 別の学習状態を消さず、元の mention topology を保持する。消えた mention は探索できず、過去 trace の path は監査と取消しのため残る。

principal は検証済み MCP OAuth props の numeric GitHub user ID からサーバーが決める。同じ GitHub ユーザーの client 間で共有し、caller 指定 identity は信頼しない。別ユーザーには `unknown_trace` / `unknown_confirmation` を返す。DO の内部 API は公開 route を持たない。

`memory_history {limit:10}` は新しい trace から一覧を返し、`next_cursor` で次ページへ進む。`memory_history {trace_id,limit:10}` は資料、利用段階、現在 activation、検索設定と古い順の receipt audit を返す。この詳細側 cursor は**同じ trace 内の receipt**用で、一覧側とは用途が異なる。cursor は principal と、詳細側では trace にも所属する。

limit は1..50、trace の資料 snapshot は300件、保存入力は300,000文字、query は4096文字、metadata string は256文字、usage batch は100 entry、reason/key は1000/128文字まで。SQL は owner/cursor index と有界 page を使う。全履歴をまとめて読む API はない。

未成立・失敗を成功 trace として保存しない。一部 scan source、sparse retrieval、graph expansion の失敗と memory の原子的書込失敗では検索結果を返せるが、`memory_unavailable:true`、`feedback_available:false` とし、**trace_id を発行しない**。`memory_error` はそれぞれ `retrieval_incomplete` / `memory_save_failed`。拒否 error は段階違反、key conflict、confirmation 等の安全な code を返し、query/handle を error や log へ転記しない。検索の error log は固定文言にする。

### 資料単位の部分記録（Issue #263）

canonical identity または live version が未解決の資料は、検索結果・順序・本文を維持して、その資料だけ保存から除外する。正常資料があれば既存 transaction で原子的に保存し `trace_id` と全体の `feedback_available:true` を返す。未解決 row は `feedback_available:false`、`memory_exclusion_reason:canonical_identity_unavailable` または `live_version_unavailable` を持ち、source_id/provenance/activation を付けない。`results`、`graph_results`、両軸の `same_entity.others` に適用する。

応答の `memory_recording` は `status:complete|partial|unresolved`、`recorded_sources`（保存した distinct source 数）、`excluded_sources`（除外した返却 row 数）、`exclusions:[{location,reason}]` を返す。同じ未解決資料が複数箇所にあれば各 row を数える。location は `results[0].same_entity.others[1]` 等の返却位置のみ。本文・タイトル・vector ID を除外記録へコピーしない。同じ object を `settings.memory_recording` として保存し、history 一覧・詳細の両方で再読できる。古い trace の settings にこの field が無い場合は従来の記録。

全資料未解決は `status:unresolved`、`memory_error:all_sources_unresolved`、memory_unavailable/feedback不可、trace無し。正常な0件検索は `status:complete`、件数0の空 trace を保存する。識別以外の例外とDB書込失敗は資料単位の除外として扱わない。

graph path の起点・中間・終点は実際に探索した vector ID 列から索引 metadata を読む。返却枠外・dangling・identity 未解決の中間も検証し、repo と directional mention の両端 slug を照合する。確認不可の path は保存 snapshot で `path:[]` とし、返却 graph_path は維持する。終点自体が正常なら利用段階は記録可能だが `graph_feedback_available:false` と `graph_feedback_exclusion_reason:unverifiable_graph_path` を返し、confirmed は `no_graph_path` で非適用。`excluded_graph_paths` / `graph_exclusions` を memory_recording に保存する。確認できた他の path の強化・receipt・取消しは継続する。内部 node snapshot は返却・settings・history に含めない。graph metadata 読取は返却 path 当たり最大3 node の集合に限定し、保存形式の移行は不要。

## 利用段階と retry

`record_source_use {trace_id,idempotency_key,uses:[{source_id,stage}]}` で段階を記録する。

| stage | 意味 | usage activation 加算 |
|---|---|---:|
| selected | 調査対象として選んだ | 0.2 |
| validated | 正確な出典を確認し利用可と判断した | 0.5 |
| used | 回答・判断に実際に使用した | 1.0 |

段階は一つずつ進める。caller が各判断を済ませた後、同じ資料の3段階を同じ batch に含めてもよい。trace 所属、順序、owner、全 entry を一つの SQLite `transactionSync` で確認し、拒否時は usage・activation・receipt 全てを rollback する。既に完了した段階の再送は no-op。検索自体を used や confirmed と解釈しない。

key は principal 全体で mutation tool / trace をまたいで一意。同じ parsed payload の retry は同 receipt、同 key の異なる payload は `idempotency_conflict`。JSON object の field 順序は同一性に影響せず、array 順序は影響する。並行更新は DO と transaction で直列化する。新しい操作には新しい key を使う。

## 活性度と学習の反映

`MEMORY_POLICY` の半減期は3600秒。読取・更新時に `value * 0.5^(max(0,elapsed_ms)/3600000)` で計算する。clock 逆行は elapsed=0、更新 timestamp は逆行させない。cron は不要。

成功 trace ごとに distinct な返却資料へ `retrieved` を0.1加算。`usage` は上記 stage の加算量を使う。**各 channel 上限10、total 上限20**で、有限・非負。応答は両 channel、total、UTC updated_at を返す。取消しは関係の寄与を取り消し、過去の usage 記録や activation は消さない。

検索履歴は既定で書き込み、search の `readOnlyHint:false`。keyword の fusion / score / rank / rerank は維持する。`graph_expand:false` が既定。`use_memory:false` は従来の graph 順序・上限を保つ。

search mode の `use_memory:true` は現在の graph 候補を最大200件読み、hop 昇順、同 hop 内だけ減衰後の path strength 合計降順で並べ、同点は元順序を保つ。その後 `min(top_k*2,30)` 件へ絞るので、従来の返却枠外の強化済み候補も選べる。初期 strength=0 では従来と同じ順序。両軸を融合せず、relevance score を追加しない。opt-in の graph row に付く `learned_strength` は寄与の合計で、関連度ではない。scan/fetch はこの並べ替え指定を無視する。

## confirmed と因果的取消し

`record_outcome {trace_id,idempotency_key,outcome:"confirmed",source_ids,reason}` は同 trace の used 済み資料を要求する。探索時に保存した実在する1〜2本の directional mention edge だけを強化し、origin→終点の shortcut、lexical/zero-hop edge は作らない。usage だけでは関係を強化しない。

独立 trace は保存 edge ごとに0.25を加算し、減衰後 strength の上限は5。同 trace は同じ edge に一度しか寄与できず、資料間の path 重複、再確認、retry、取消し後も二重加算しない。実 delta は残り headroom（0の場合もある）。receipt / ledger は saved path、delta、timestamp、reason、active/reversed を保持する。重複、上限、lexical、取消し済みは非適用理由を返す。

`corrected` / `rolled_back` は**同 trace の confirmation_id を一つ明示**し、source_ids を渡さない。取消しはその receipt の寄与だけを inactive にし、現在まで減衰した delta だけを減算する。後続の独立寄与を残し、weight 全体を reset しない。未知・曖昧な confirmation は原子的に拒否。元 receipt と別の取消し receipt を監査に保持する。取消された trace は同 edge の credit を再取得できない。

## 移行・deploy・artifact

この変更では version/tag/release を公開しない。新しい Worker binding / DO class migration は不要。既存 SQLite `IssueStore` に独立 `memory_*` table を追加し、既存 issue table / watermark は保持する。

**D1 migration 0008 を Worker deploy、または自動 deploy を起こす branch への merge より先に適用する。** `comment_id` / `review_id` を追加し、0は未解決の旧行を表す。運用段階の具体的コマンドは以下（credential は出力しない）。

```powershell
# read-only の事前確認
npx wrangler d1 migrations list github-rag-fts --remote
npx wrangler d1 execute github-rag-fts --remote --command "PRAGMA table_info(search_docs)"
# 本番変更の許可後、Worker deployment 前に適用
npx wrangler d1 migrations apply github-rag-fts --remote
# 両列を確認後、review 済み Worker commit を deploy
npx wrangler d1 execute github-rag-fts --remote --command "PRAGMA table_info(search_docs)"
# 0008後の未解決件数（read-only）
npx wrangler d1 execute github-rag-fts --remote --command "SELECT type,COUNT(*) AS unresolved FROM search_docs WHERE (type IN ('issue_comment','pr_review_comment') AND comment_id=0) OR (type='pr_review' AND review_id=0) GROUP BY type"
```

deploy 後の認可された `POST /admin/backfill-source-identities?repo=owner/repo&limit=50[&cursor=TYPE:ID]` は、既存 DO の canonical event ID から過去の unchanged 行を補修する。既存管理 credential は非公開 header で渡し、URL / artifact / shell history に token を載せない。next_cursor を渡して done:true まで進める。limit は1..100、1 page は最大3つの有界 DO read と一つの原子的 D1 batch。再開・再実行は安全で、embedding / GitHub 本文再取得 / index reset は不要。

通常の unchanged ingest も hash skip の前に ID を補修する。DO に canonical event が無い行は未解決のままなので、別の再取り込み前に欠損を調べる。未解決 source 自体は feedback 不可とし、正常 source は上記の部分記録を適用する。backfill は private trace/credit を変更しない。旧ID欠落と残存1件の調査、再現した削除経路の修正は [調査記録](3-unresolved-source-investigation.ja.md) を参照。

bridge には `server/search-schema.json` と `server/memory-tools.json` を同梱する。`node scripts/generate-tool-contracts.mjs` で Worker Zod contract から生成し、`node scripts/check-schema-drift.mjs` が全 tool の実 protocol と nested 入出力 schema / bounds / defaults / annotations の完全一致を確認する。npm / mcpb の両 artifact にこの JSON が必要。stdio client の tool discovery には更新 bridge の公開が必要。公開 version と publication は後続の運用段階で決める。

## 合成 lifecycle と検証

`npx vitest run --config vitest.workers.config.ts src/memory-e2e.workers.test.ts src/memory.workers.test.ts` で、synthetic principal と local in-process SQLite/D1 のみを使う。

実演は `syntheticneedle` 検索 → path `a->b->c` → `c` の selected/validated/used → 2 edge に各0.25の confirmed → corrected で両寄与 inactive。独立 trace の固定時刻テストでは半減期後に次の確認を加えると path strength=0.75、最初の寄与を取り消すと次の寄与0.50が残る。実 MCP の live 本文回帰では索引 timestamp と keyword 順位を固定し、doc/wiki の inline 本文のみ変更する。同じ本文の retry は同 ID、変更本文は別 ID、stored fetch は index ID を保ち、旧 live 版の usage は新しい版に引き継がれない。正しさの検証であり、検索品質向上の評価ではない。

成功検索には DO request を一つと、有界な source hash / activation 処理が加わる。学習 opt-in は最大200 path、各最大2 edge を追加で読む。storage は trace/receipt とともに増え、自動 retention deletion は実装しない。global DO が書込を直列化する。feedback に Python 常駐、モデル配布、追加 embedding、mention topology の書換えは不要。
