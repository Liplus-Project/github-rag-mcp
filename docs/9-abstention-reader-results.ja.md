# #275 初回の固定packet読取比較

この初回条件では、資料保持にwarningを加える利益は観測しなかった。強制的に空にすると回答/訂正の根拠を失うという診断結果であり、検索閾値の性能ではない。親の確認した次の判断は、既定を維持し、warningやdrop閾値を追加しないこと。runtime/API/検索defaultは変更しない。#275の残る評価はopenで保持する。

## 対象と保存物

[凍結・事前登録](8-abstention-evaluation-freeze.ja.md) の108表現全体ではなく、F02（画面設定）/F06（topic file/index）/F08（CIDR cache）の日本語12問だけを実行した。4カテゴリ各3問。資料保持q7・全問強制空m2・資料保持＋warning v8を各3反復、9 fresh reader context、計108回答。108独立意図ではなく、12問/3資料系列への反復回答である。

要求launch modelは全readerで `gpt-6.1-sol` / medium / forkなし。同じ指示・出力上限を使った。resolved backendは観測不能、provider tokenと各callの確かなelapsedは未取得で、0や推定料金を代入しない。親は1人の独立judgeへ3familyの匿名入力を順次渡した。judgeの独立反復や評価者間一致は測っていない。

原入力freeze SHA256は `e4962e8e62ef2aa7584982ccda63ed9b34c173beea2fbadeeac740e3cd5bf321`。元freeze/protocol/transport/reader回答/judge原文は変更しない。`experiments/abstention-reader-results-v1/` にraw9回答・原judge3ファイル・由来manifest・匿名対応表・`input-grounding-audit.json`・`aggregation.json` を保存した。`aggregation.json` はarm/反復/カテゴリ/資料系列とその組合せごとに分子/適用分母を出す。nullは非適用、分母0のrateはnull。

技術pilot2batchは採点前に除外した。旧empty出力も成績/反復数に算入しない。有効9readerは切断なしで入力を取得し、全108回答のID/構造/引用を元packetで検証した。原judgeも各36行、計108匿名row IDの全単射とschema/hashを確認した。reader statusだけから正誤を推定しない。

## 原judgeの一次集計

以下は3反復を含む回答数。各arm36回答（12問×3回）、支持/訂正は各9回答（各3問×3回）、根拠不足を期待する2カテゴリは計18回答（6問×3回）。

| 原judge軸 | 保持q7 | 強制空m2 | warning保持v8 |
|---|---:|---:|---:|
| 共通goldでも支持できない断定 | 0/36 | 0/36 | 0/36 |
| 根拠なしの前提否定 | 0/36 | 0/36 | 0/36 |
| strict goldの支持内容損失 | 2/9 | 9/9 | 2/9 |
| 明示訂正の損失 | 0/9 | 9/9 | 0/9 |
| 適切な根拠不足 | 18/18 | 18/18 | 18/18 |

支持内容損失の反復別件数はq7/v8とも0/3、1/3、1/3。m2は各反復3/3、訂正損失も各反復3/3。根拠不足の2カテゴリは全arm・全反復で各6/6だった。機械集計には全カテゴリ別の適用分母も保持している。

強制空条件で根拠を失うのは介入の構造上の帰結で、実際の低score検索がどれだけ正しく拒否されるかを示さない。支持/訂正の損失と、無根拠断定を別々に扱う。

## Q008の問いとstrict goldの範囲差

Q008は「添付とtopic logのどちらが先か」を問う。保持armの回答は順序を正しく説明したが、goldにはNotFound許容/他のlog削除errorで停止する追加条件もある。次の4行はその追加条件を省いたため原judgeが支持損失とした。

- q7反復2: `Rb86acbe5d9f221c1`
- q7反復3: `Rd4893c5f0bc5619e`
- v8反復2: `R1b7c5b75db3beb1a`
- v8反復3: `R31fe8cc9cdad9307`

親はこの範囲差を確認し、一次strict集計/原judge/goldを維持する判断をした。上表のq7/v8各2/9を「削除順序が誤っていた」「有害な断定があった」と読まない。観測後にgoldやスコアを緩めた代替成績も作らない。この問いと指標の範囲差は比較の限界である。

## 実入力の根拠との照合

共通gold上の正解は、そのreaderが実際に根拠を持っていた証明ではない。unblind後、実装担当が全108回答本文/引用と実際の元packetを別に照合した。empty36回答はいずれもproject factを断定せず根拠不足を述べた。資料保持72回答のコードに関する断定と引用は実excerpt内で支持され、局所定数/既定値を現在値や本番の全体保証へ転用していなかった。実入力に支持されない断定は各arm0/36と記録した。

これはstatusや共通gold正解から自動生成した判定ではなく、作者の別軸の意味監査である。形式的な含意証明や第二の独立judge評価ではない。原judgeの引用/版妥当性フラグには引用のないempty回答も含まれるため、その36/36を引用利用率/根拠保持率とは呼ばない。

## 露出範囲と残る評価

108表現は作者が事前確認した。親がreader開始前に独立に監査したのは初回12JAのsource/gold適用性だけで、全108の意味正解やEN/shortの等価性を独立監査したとは言わない。

元holdout72表現のうち12JAを実行し、60表現は未実行。そのうち24は既に露出したF02/F06/F08のEN/short変種なので、独立した未露出groupとは扱わない。group単位で未露出なのはF03/F04/F09の3系列/12意図/36表現。既存データを再調整したりholdoutへ付け替えたりしない。

この人工的curated packet・前提/根拠不足を明示する指示・小さい3系列でwarningの上積みがなかったことは、一般的な無効/同等性や統計的優越を証明しない。実検索、rerank/dense score、全pool A/B/D、許容損失、追加再検索コスト、未露出系列/他言語は残る。資料の欠如から前提を否定せず、候補取得や自動selectorの性能とも区別する。

```powershell
node scripts/abstention-reader-aggregate.mjs verify
node --test scripts/abstention-reader-aggregate.test.mjs
```
