# Doc/wiki 全文 sparse source 基盤

Issue #284 の保存・運用契約。通常検索への接続は #281 の別作業。

`DOC_SPARSE_CONTEXT_ENABLED` は省略時 false。false では ingest は全文の生成・取得・追加 D1 呼出しを行わない。8000 UTF-16 unit の prefix、通常 nat FTS corpus/IDF、1 資料 1 vector、fetch、graph は維持する。既定 off の ingest と検索は migration 0009 の新 schema にアクセスしない。migration 0009 は operator 経路と enable より先に適用する。検索だけの旧経路は全文テーブルを読まない。

`search_docs` が metadata 正本。`doc_sparse_sources` は doc/wiki 専用で vector_id に一意、source_version（doc は Git blob SHA、wiki は body SHA-256）、prefix の取得時点、索引版、raw/body/source hash、UTF-8 bytes、coverage と理由を持つ。全文は path（wiki は slug）+ 2 改行 + body。同じ Worker の segmenter で作った文字列をそのまま所有し、位置表は保存しない。独立した external-content FTS は full coverage の行のみを索引する。

raw 256 KiB、segmented 512 KiB、owner 行の文字列 UTF-8 bytes と固定 overhead の合計 1 MiB を上限とする。超過は `out_of_range` として処理済みで prefix-only。全文/hash を取得できなかった場合は null とし、取得済みとしない。同じ版は skip、次の版または operator の `force=true` で再判定する。予算は CPU/heap の安全証明ではない。

有効 ingest は doc の blob hash を検証し、prefix と全文を D1 batch transaction で書いてから DO の版を進める。FTS 失敗は版を進めず、既存の ETag 保持・再試行に従う。prefix 更新は旧 owner を無効化し、削除 trigger は owner/独立 FTS を削除する。prefix 更新と backfill の競合は source_version、prefix 本文・type・repo・path・updated_at・indexed_at・source_revision の compare-and-swap で上書きを防ぐ。

migration の source_revision は prefix の source に関わる UPDATE ごとにちょうど 1 増える。既定 off の旧 SQL 形を保ち、同じ prefix・timestamp・古い source_version が残る更新も識別する。source_revision 自体の UPDATE は generation trigger を再発火させない。owner の prefix_revision は実際の prefix generation を所有し、統計と同版 skip もこの一致を確認する。

既定 off で A→B が取り込まれると source_version は A のままになり得る。backfill はこれだけで永久 conflict にせず、store.updatedAt と prefix、取得した doc blob/wiki body の hash と exact prefix、store の再読をすべて確認する。plan は版修復の予定だけを返し書かない。apply は source_revision を含む snapshot CAS で canonical source_version を B へ修復し、その UPDATE の成功だけを条件に owner 保存を同一 D1 batch で行う。修復は revision を 1 増やし旧 owner を無効化してから新 owner を結ぶ。CAS が負ければ両方 0 行、書込み失敗なら版修復も rollback。legacy の空版もこの手順で結ぶ。embedding/vector は呼ばない。

## Operator

この 2 経路だけは専用 secret `DOC_SPARSE_ADMIN_TOKEN` を使い、`Authorization: Bearer <token>` が完全一致した時だけ認証する。未設定・空なら fail closed。`GITHUB_TOKEN` への fallback はなく、GitHub source の取得だけは従来の `GITHUB_TOKEN` を使う。既存の他 admin 経路は変更しない。reviewed merge 後、operator が `wrangler secret put DOC_SPARSE_ADMIN_TOKEN` で secret を provision する。値は [vars]・repository・chat に置かない。`POST /admin/backfill-doc-sparse?repo=owner/repo&type=doc|wiki_doc` は plan が既定。書込みは `apply=true` のみ。`limit` は既定 5、最大 10、`max_bytes` は既定/最大 1 MiB、`cursor` は search_docs rowid。1 回の source 取得も bounded reader で制限する。doc は DO の blobSHA の Git Blob API から取得・hash 検証し、wiki は DO の extension の raw 本文を取得して bodySHA を照合する。過去 wiki を hash から取得できるとは仮定しない。store と prefix の版が異なるものや検証できないものは conflict、再取得候補として返す。embedding/Vectorize を呼ばず、unchanged/ETag を回避して準備する。

応答は対象 repo/type、取得時刻、各 source の版、coverage/bytes、成功・範囲外・欠損・競合・retryable error、次 cursor を持つ。retryable error または取得前に残り byte 予算が無い場合、cursor はその source を越えない。残り予算だけで取得が打ち切られた source は `byte_budget_deferred` として cursor を保持し、次の call で再試行する。call の初期予算でも取得上限で原文/hash を確認できなかった source は `source_byte_limit_unverified` conflict として進め、残りの取得を止める。`source_bytes` は取得・decode が完了した body の UTF-8 bytes、`budget_exhausted` は未取得分の上限到達も区別する。Git Blob JSON の network reader は残り decoded 予算 × 1.4 + 4096 bytes（base64 と envelope）で制限する。missing/conflict は明示報告して次へ進むため、競合解消後は cursor を戻して再実行する。plan は source を取得・検証するが保存しない。apply は同じ source の再実行で owner/FTS/vector を増やさない。

`POST /admin/doc-sparse-stats?repo=owner/repo&type=doc|wiki_doc` は indexed prefix population の coverage、未準備、版不一致、legacy prefix の版未検証件数、raw/segmented/行 bytes と索引版別件数を返す。これは repo tree 全体や現在の Git source 本体の件数ではない。

本番 apply は merge 後の別 operator 判断。対象 repo/type と plan、復旧境界を確認して migration/apply を行う。2026-10-13 の operator 確認では、全文 D1 export は FTS/virtual table 未対応で失敗しバックアップファイルは作れなかった。Time Travel info は成功し bookmark を控えたが、restore は実行していない。migration/apply 前には Time Travel info を再確認し bookmark と影響対象の metadata を控える。全 repo 一括取得は行わず cursor ごとに観察する。migration は旧 prefix/FTS/vector を変更しない。通常の fallback は enable を false に戻して全文書込みを止める。既定検索と prefix ingest は継続できる。DB 復旧は別操作であり、info で確認した Time Travel bookmark と restore の影響範囲を operator が apply 前に確認する。全 DB の restore は他 surface にも影響し、in-flight query/transaction を取り消す別判断であり、小さい全文 backfill の通常 fallback と混同しない。実行時は webhook/cron/admin の D1 書込みを静止させる。D1 Time Travel は DO/Vectorize を独立して復元するものではなく、復旧後の store 版・vector・prefix との整合を別途確認する。空の復旧用 D1 への import/binding 切替は、完全なバックアップが得られ手順を検証した場合に限る。既存の populated D1 への export SQL import だけを復元保証にしない。この PR では DB 復元を試行・検証していない。既定 off の ingest・検索は migration 0009 が無くても使用できる。operator 経路と enable は migration 0009 が必要。報告は merge・配置・本番 plan・apply 観測を分ける。

一次資料: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)、[D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。
