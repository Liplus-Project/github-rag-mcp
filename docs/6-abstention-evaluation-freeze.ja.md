# #275 新規診断セットの凍結と読取事前登録

既存6問の開発試験とは別に、公開コードの固定写しから36意図×日英・短い探索語3表現=108問を作る。拒否・warningの効果、全pool A/B/D、production検索の成績は未測定。runtime/検索default/APIを変えない。この文書は評価artifactの契約であり、製品機能の追加ではない。

`experiments/abstention-evaluation-v1/` が唯一の入力セット。`provenance.json` はimmutable commit/path/公開URL/原文bytesとhashを持つ。Pullcept6 moduleとwebhook3 moduleの9資料系列を用い、composerとsignatureには実際の祖先版も保持する。targetは問いが指すコード版、historicalは同じpathの祖先で、production稼働・意味的撤回は主張しない。Apache-2.0の原著者のコードを原文のまま保持し、両repoのLICENSEも同梱する。wikiをlocal NGRへ取り込まない。

`exclusions.json` は既存development artifact8件のhash、旧issue15系列・文書11系列と保守的な除外範囲を記録する。旧RAG全体/NGR全体（#298/#299含む）・webhook requirements/retentionなどを除く。新しいtopic log管理はイベント保持日数、per-isolate limiterはAI usage windowとは別の判断系列。同じpathの版・コピー・派生した同じ判断は同一familyに置く。import依存だけで同じ主張系列とはしない。無関係な過去履歴全てを未観測と証明するものではない。

`intents.json` と `gold.json` は分離する。支持/明示的前提訂正/未裏付け前提/その他コーパス外を各9意図。支持・訂正にはtarget版の実際の引用とUTF8 byte範囲が必要。未裏付け前提の真偽は未確定で、測定ログの欠如から否定しない。コーパス外は同じ領域の別機能・条件の問いで、固定された11 source snapshot内の根拠不足に限定する。世界全体・現在のrepo・productionの情報不存在とは言わない。表現の等価性は作者が事前確認済みで、独立した意味監査はreader開始前の親の審査で行う。

`split.json` は意図・資料系列を結ぶ9 group。development3系列=12意図36問、holdout6系列=24意図72問。各splitの各categoryは3/6意図、両splitに2repoを含む。全3表現・全版は系列と一緒に移動する。validatorはID/同path/hashコピー/対象資料/引用範囲/カテゴリ件数/系列交差0を確認する。**意味的に同じ判断の別pathコピーは人による系列監査も必要**で、自動検査だけで未知の漏洩を証明しない。

読取の初回trancheはholdout F02/F06/F08の4カテゴリの日本語12問。保持q7・強制空m2・同じ資料保持＋固定warning v8の3arm、各arm独立3反復、計9 reader call/108回答。1wave最大3 readerで、1callは12問。各readerへ渡すのは `reader-inputs/{q7,m2,v8}.json` の一つだけ。gold/category/split/arm対応・他の回答・親履歴を渡さない。source metadataと原文範囲は保持arm間で一致する。全ファイルを渡すのではなく、各moduleの固定prefixとtopic-index末尾側のdelete実装を引用するcurated packetであり、検索成功や自動selectorの試験ではない。

`preregistration.json` に対象、反復、指示、予算、採点、停止条件を固定する。モデル識別子・同じmedium effort・実際のinput/output allowanceを親が最初の起動前にrun-lockへ記録する。取得できなければ開始しない。原文にはコードが含まれるがデータとしてのみ扱い、readerは実行/検索/toolを使わない。使用量・経過時間は各callで記録し、未測定の価格/時間を見積り値として出さない。

`reader-gold.json` は匿名caseとgoldの評価側対応。`verifyAnswers` はoutputのID/status/600文字/最大2引用と引用原文一致を検査するだけ。事実のcoverage・無根拠断定・根拠なし前提否定・支持/明示訂正の損失・適切な根拠不足をarm名から隔離した採点者が別々に判定する。statusラベルだけで正誤を決めない。12問の結果を残りholdout72問や全108問に拡張せず、意図/系列依存とreader反復のばらつきを報告する。

モデルscoreは一切作らない。強制空/warningは人工的な条件付きpacket ablationであり、B/Cの検索閾値効果ではない。許容損失と追加再検索コストは未解決。既存defaultは維持し、#275の検索評価完了・採用・一般性能を主張しない。残りholdoutの実行は別の事前登録が必要。

```powershell
node scripts/abstention-evaluation.mjs validate
node --test scripts/abstention-evaluation.test.mjs
```

`prepare` は読取を呼ばず入力packetとgold対応/freezeを決定論的に再構成する作者用処理。凍結後は`validate`だけで検証する。`freeze.json` はそのファイル自身以外の入力全inventory/hash。改変後はhash更新だけで同じholdoutに戻さず、新versionとして露出履歴を残す。reader開始前にcommit/pushと親の意味監査が必要であり、このPR内ではreaderを実行しない。
