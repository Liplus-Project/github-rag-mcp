# 未解決 source の調査（Issue #263）

調査日: 2026-10-02 JST。対象: [Issue #263](https://github.com/Liplus-Project/github-rag-mcp/issues/263)。基準は v0.12.0 / `c3e5126363386a7665cbe56087ecd5cbc5cf7a6a`。本番管理操作・DB変更・一括修復の再実行は行っていない。使った証拠は既存の補修CSV/結果、Git履歴、公開GitHub API、通常ユーザー向けRAGの限定stored-content fetch。

## 1. 旧行の comment_id/review_id が0になった理由（確定）

[コメント取り込み導入 1edf74d](https://github.com/Liplus-Project/github-rag-mcp/commit/1edf74d3d0729096fbc9890a8a3d847fb776a580)（2026-04-23）では、Vectorize metadata と DO canonical record に GitHub event ID を保存していた。一方 `src/pipeline.ts` のコメント/review用 `upsertFtsRow` はIDを渡さず、当時のFTSスキーマにも両列が無かった。

[memory実装 4594bb6](https://github.com/Liplus-Project/github-rag-mcp/commit/4594bb6801f61f9a19e15bbee47e242d2bef3cbb) の `migrations/0008_source_event_identity.sql` は両列を `INTEGER NOT NULL DEFAULT 0` で追加した。そのため旧行のIDは0となる。取り込みのhash一致skipで本文が更新されなければ、旧行にevent IDを補う経路が必要だった。同実装は通常取り込みでIDを保存し、unchanged ingest と DO canonical backfill でも補修するよう変更済み。

既存Owner UI補修記録は issue_comment 952、pr_review 553、pr_review_comment 14、計1519件を修復し、総行数10545を維持した。未解決は1520→1。本修正はこれらの成功済み補修や個人memoryを変更しない。

## 2. 残存1件が照合できない理由（未確定）

既存証拠の位置は `D:/Users/hal/Codex/release-staging/github-rag-259-operations/`。`OWNER-UI-ID-REPAIR-RESULT.ja.md`、`canonical-event-ids.csv`、`unmapped-event-ids.csv`、`verified-id-repair-map.csv` を根拠とする。秘密情報を含むファイルは参照していない。

| 観測 | 値 |
|---|---|
| repo/type/parent | Liplus-Project/liplus-language / issue_comment / #1428 |
| vector_id | `ic:B9kDYNPm4eKCVyazFWiY_sjR6YvOPt6Cw-OVIOi1OEE` |
| ID列 | comment_id=0、既存補修証拠ではreview_id=0 |
| indexed row updated_at | 2026-05-30T11:15:02Z |
| indexed body | 著者prefix `liplus-lin-lay`、見出し「中間検証報告（feasibility-first / 進捗ログ）」、2443文字、content_truncated=false |
| 現在の #1428 コメント | ID 4582731637、created/updated 2026-05-30T11:47:48Z、重複close報告 |

限定fetchは該当vector IDの1件のみを指定し、本文とmetadataを返した。調査時の現行Workerはその1件だけでmemory_unavailable=true、feedback_available=false、trace無し。旧行の本文・timestampは[現在の #1428 コメント](https://github.com/Liplus-Project/liplus-language/issues/1428#issuecomment-4582731637)と異なる。[#1430](https://github.com/Liplus-Project/liplus-language/issues/1430)の現在のコメント2件（ID4582772963、4582774279）も12:07:52Z/12:08:28Zのverdict/close報告で、同じ本文ではない。

comment導入時と現行のvector ID生成はどちらも `ic:base64url(SHA256(repo + NUL + String(comment_id)))`。このsurfaceの方式変更はGit履歴で見つからなかった。取得済みcanonical event集合で照合できず、現在の公開コメントでも出典を復元できない、というところまでが確認できた事実。IDの推測・brute force・新しいsource_idの捏造は行わない。

過去のコメント削除、取り込み時の不整合、別の運用によるcanonical欠落は候補であり、対象event ID・削除delivery・当時のbinding失敗ログが無いので原因の断定はできない。「現在のコメントにない」だけでは「削除済み」は確定しない。

## 3. 再現した削除経路の欠陥（確定、対象1件との因果は未確認）

コメント導入時から現行まで `issue_comment.deleted` は Vectorize とFTSの削除例外を個別にcatchして、DOのcanonical削除を続行し、202 `result:deleted` を返す。FTS削除だけ失敗した場合、索引行は残るがcanonicalは消える。逆にVectorizeだけ失敗した場合も、その索引行の出典をDOで追えなくなる。DO fetchの非2xxも成功扱いだった。

Issue #263 ではこのhandlerだけを修正した。索引両surfaceの削除成功までDO canonicalを保持し、どちらかの失敗を503 `partial_delete` として返す。DO削除の例外・非2xxも503とする。ログは失敗surface、vector IDまたはrepo/comment ID、bindingエラー理由を保持し、本文や認証propsを記録しない。成功時は従来の202 deleted。部分削除後の明示的な再配送と既に削除済みの再配送も正常に扱う。自動再試行/queueは追加しておらず、503を自動回復の保証としない。

この再現は残存1件を説明できる機構を示すが、その行で実際に起きた証拠ではない。過去の既存行は本変更で修復されない。

## 4. 検証と適用範囲

`src/webhook-comment-deletion.workers.test.ts` は署名付きsynthetic deliveryとローカルDO/D1でFTSのみ失敗、Vectorizeのみ失敗、DO非2xx、DO例外、正常削除を確認する。失敗時のcanonical保持、失敗surfaceの索引状態、明示的再配送、削除済み再配送も確認する。

`src/memory-e2e.workers.test.ts` と `src/memory-api.test.ts` は両軸/同一entity、全件未解決と正常0件、原子的保存失敗、history一覧/詳細再読、未解決/返却されない中間を通るgraph path、正常pathのconfirmed receiptと取消し、識別以外の例外を確認する。仕様は [2-feedback-memory.ja.md](2-feedback-memory.ja.md)。新migration・binding・版番号更新は不要。品質や性能向上の測定はしていない。
