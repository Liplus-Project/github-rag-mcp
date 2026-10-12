# Offline Abstention Replay

Issue #275 の固定 capture 比較用の要件・入力契約。追加 dependency、モデル呼出し、サービス/DB/認証/既定検索の変更を伴わない。既存の探索資料を再計算する道具であり、拒否閾値の採用、108問いの固定試験、blind reader 評価を完了したものではない。

## 実行

Node 22 で repository root から実行する。出力は入力と別のパスを指定する。

```powershell
node scripts/abstention-replay.mjs experiments/abstention-replay/fixture.json experiments/abstention-replay/annotation.json report.json
node --test scripts/abstention-replay.test.mjs
```

同じ入力 bytes では同じ JSON を生成する。時刻を足さず、schema/protocol/fixture/annotation/runner の SHA-256 を結果に保存する。元 capture は編集しない。CLI は引数誤り・契約違反を exit 1 とし、入力自身および既存symlink/hardlinkの入力別名への出力を拒否する。

## 入力契約

`experiments/abstention-replay/schema.json` は fixture と annotation の JSON Schema。CLI は dependency なしの validator で、unknown field、非有限値、query/candidate の重複、annotation の参照と全件被覆も検査する。query category/language は入力の層別軸。entity は独立資料の同一性を表す公開キーで、同一issue・コメント・派生本文を別 entity と数えないよう実験担当が決める。private trace/source ID、credential、principal、activation、feedback receipt のための field は許可しない。文字列本文そのものの秘密検出は行わないため、公開入力の内容監査も必要。

- retrieval: `complete` / `partial` / `unknown`。正常な0件、取得障害、未確認を区別する。
- sparse: state=`complete` / `failed` / `not_run` / `unknown`、scope=`filtered_pool` / `pre_filter`。正常時のみ非負整数countを持つ。他はnull。正常な pre_filter 0件ならfiltered候補も空だが、pre_filter正数はfiltered候補の存在を証明しない。
- dense: 同じfilter済み全候補poolの最大値 `max` と `pool_complete`。top-kからの推測は不可。未確認はfalse/null。ゼロは実測値として扱い、欠損の代用にしない。
- rerank: 資料ごとに `kind=model`（実モデルで測れた値）/ `synthetic`（サービスが合成した値）/ `missing`（null）。`rerank_pool_complete=true` は全poolの候補と実測が入力に揃ったという入力作成側の保証。単なる `rerank_applied=true` では保証できない。
- graph_entities: 独立した関係軸。keyword候補拒否時も削除しない。scan/fetchのreplay入力はこの意味検索契約に入れない。

fixtureは6件・18行の既存development captureを公開fieldだけのallowlistで転記したもの。保持した点数は返却行のrerank_scoreで、候補pool全体の測定保証ではない。元captureのsource_commitは参照したsource SHA、稼働code/index固定の証明ではない。sparse候補数はpre_filter。dense最大と全rerank poolは不明。既に観測済みの資料で、holdoutではない。

annotationはscoreと独立して、query_id/candidate_idごとに `support`（支持）/ `contradiction`（明示反証）/ `partial`（部分的根拠）/ `irrelevant`（無関係）/ `unknown`（未判定）を付ける。unknown以外はcitation（引用箇所と固定版の出典）とconditions（問いへの適用条件）を必須とする。CLIは引用の真偽を自動採点しない。captureに根拠本文がないため、同梱annotationは全件unknown。#275の資料にも当時の明示記述を監査せずgoldを付けない。moon質問は全コーパス不存在が未確認で、確定unanswerableではない。

## 比較規約

固定gridは 0, 0.001, 0.005, 0.01, 0.05, 0.1, 0.2, 0.5, 0.9。比較は厳密な `< tau`。閾値最適化は行わない。

- baseline: keyword packetを保持。
- A: 正常なfiltered sparse候補が存在すれば保持。空なら完全なdense pool最大値がtau未満のとき拒否。pre_filter候補の正数、sparse障害/未実行、空時のdense最大不明、取得不完全は判定不能として保持。
- B: 全poolの実測rerank最大値がtau未満ならkeyword検索全体を拒否。未測定、候補欠落、合成点数、空pool、取得不完全は判定不能として保持。
- D: 同じ完全pool内でentityごとの最大値を取り、上位2独立entityの絶対差がtau未満なら全keyword packetを拒否。独立entityが2件未満なら判定不能。同点は差0。重複行は独立資料として数えない。
- C: B信号を添付して資料を保持するreader用packet。点数を正しさの確率とは呼ばない。reader効果は未測定。

`returned_packet_diagnostics` は返却されたtop-k行だけでtop/gap/gridを再計算する別scope。hidden poolや候補欠落を埋めず、全検索B/Dの判定へ流用しない。6件のtau=0.01で返却packetのBは探索3件を保持、訂正問い2件とmoon問いを拒否するが、gold保持率や一般性能には換算しない。全poolのA/B/Dはこのfixtureでは判定不能6/6、保持6/6。正常sparse候補ありで素朴なAの発火が0だった既存観測も、filtered pool検証済みという意味ではない。

Eはembedding/距離/bandwidth/候補pool等の指標が未固定なので実装しない。rerank合計による代用もしない。

## 指標と解釈

all/category/language/category-languageごとに件数を出す。各rateは numerator/denominator/rateを持ち、分母0はnull（0%とはしない）。発火率と判定不能率の分母はquery数。支持/反証/部分的根拠/無関係/未判定ごとにcandidate保持率と失った件数を出す。無関係保持率がcandidate-levelの無関係返却率。誤拒否率の分母は少なくとも一件のgold有用資料（支持・反証・部分的根拠）があるquery数、分子はそれを全keyword packet拒否で失ったquery数。

同一entity重複のまとめはD信号のみ。candidateの損失分母は入力行数でありentity数ではない。graph有用性はkeyword指標へ混ぜない。query全体の無根拠断定、根拠不足の適切な明示、読む側の前提訂正、再検索costは未測定。同梱gold未判定では有用性/無関係指標の分母は0になる。

合成controlは欠損、合成点数、部分取得、tau境界、同点、同一entity、低点の反証資料とC保持、分母0、入力上書き拒否を検査する。合成control成功を検索品質の証拠としない。

## 残る評価

別段階で固定コーパスの引用監査、意図/資料系列による調整・未使用分割、108問いを出発点とする比較、条件名を伏せた同じreader/model/予算/指示でのbaseline/B/C比較が必要。害と支持/反証の取り逃しは別件数で報告する。PR mergeだけで#275のreader比較義務は完了しない。改善または不採用の理由をissueへ記録するまで開いた状態に保つ。現時点で既定動作は維持する。
