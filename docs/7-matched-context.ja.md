# 文書の一致コンテキスト

`doc_context: matched` は `query` と `type: doc|wiki_doc` を明示する。`rerank: false` や単一候補でも一致抜粋を返す。省略/`prefix` は従来の検索経路を使う。既存の全文保存フラグは取り込みの制御であり、この読取りの条件にはしない。準備済み少数 source でも利用できる。

`doc_context_coverage` の total/full/prefix_only/unprepared/out_of_range/stale は query 語との一致前の metadata scope 件数。status は complete/partial/unprepared/unavailable。全文索引読取り失敗時は unavailable とし、準備済みも含む従来 prefix 候補を返す。未準備資料の後半は検索できない。

metadata 正本 search_docs の repo/type/state/milestone/path_prefix/labels/assignee/since/until を共通 SQL で適用する。full owner は版・取得時点・revision・index_version の一致が必要。それ以外を prefix 系統に含める。strict/relaxed 各 tier 内の順位を 1/(60+rank) とし、異なる corpus の BM25 生点数を比較せず、同点は vector_id、同一 vector は一票。全 sparse を internalTopK 最大50へ絞り、既存 dense/sparse 融合へ渡す。

`matched_context.text` は indexed 原文 path+2改行+body の連続 slice。start/end はその UTF16 座標、最大1400 units、source_version と body/source/raw/excerpt hash を伴う。同じ text がモデル入力になる。`include_content` の最新 GitHub 本文とは別欄。graph_results、stored fetch は従来の所有を維持する。

候補の postfilter/base 本文/非空判定後に最大50件を選び、keyword 順位で狭い source 情報を検査する。raw 合計1MiB、資料 raw256KiB/segmented512KiB/owner1MiB、raw batch 最大5、位置 map 同時1。大きい候補は skip し後続を扱う。予算は初期工学的制限であり、実 heap/GC/Cloud CPU 適合の証明ではない。

版や hash、path、byte 数、保存 segmentation と再計算が完全一致し、一意 fragment が安全な surrogate 境界に写像される場合だけ抜粋を返す。曖昧fragment・更新/削除競合・未準備・範囲外・dense-only/位置なし・予算・読取り失敗等では matched_context_fallback と既存本文を維持し、資料を捨てない。位置 map は保存しない。取り込みフラグ変更、全 corpus backfill、secret、production 操作をこの検索機能へ含めない。
