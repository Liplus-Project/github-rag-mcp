# Offline Document Tail Replay

長い資料の後半を発見する候補の比較を、固定公開入力から再計算する opt-in CLI。既定検索、embedding、reranker、live DB、デプロイは変更しない。全文索引や分割方式を本番に採用する変更ではない。

```sh
# Node >=22.6 (TypeScript stripping), Python >=3.10 with SQLite FTS5
python scripts/document-tail-replay.py --out /tmp/document-tail-new
node --experimental-strip-types --test scripts/document-tail.test.mjs
python -m unittest discover -s scripts -p 'document_tail_test.py'
```

`--out` は存在しない新規ディレクトリを指定する。CLIは原子的に作成し、既存出力・入力・DBを上書きしない。既存のsymlink先も拒否する。ネットワーク、認証、Workers、NGR共有DB、モデルを使わない。失敗時の部分出力も再利用しない。異なる新規dirで実行する。`prepared.json`、3 SQLite DB、`results.json`、`sections.json`、`REPORT.md` をそのdirに生成する。DBやpreparedをコミットしない。

## 固定入力と再現契約

`experiments/document-tail/fixture.json` は2026-10-13に独立captureした11公開文書 / 7事前queryの新規fixture。frozen corpus、WSLC、`corpora/` 配下は入力に含めない。公開文書中でcorpusに言及していても、そのcorpus自体は読み込まない。`provenance.json` は各文書のcommit、Git blob SHA、本文SHA256、immutable URLを保持し、parentがGitHub Contentsの固定refと照合した記録。runnerはネットワーク再取得せず、その本文hashとblobをローカル検証する。

`protocol.json` はfixture/provenanceとsource snapshotのSHA256を固定する。sourceは github-rag-mcp `da23db3f077a2975e11fc4ab16cfab1556098045` のbyte-exact写し。segmentForFtsをその写しから実行し、escapeFtsQueryは同じ写しからTypeScript注釈のみを除いて抽出する。source snapshotは実行中のsrcとは別物。runnerは入力と全snapshot hash、各本文version hashを照合する。

- prefix: `(path + '\n\n' + body).slice(0,8000)`、JavaScript UTF16 units。production snapshotと同じ切断。
- full: 同じ入力全体。
- chunks: 同じ入力の固定非重複 <=8000 units。surrogate pairを割る境界だけ1unit戻す。pathはchunk0のみ、重複・title再挿入なし。結合が元入力に一致することを検証する。
- natural FTS5: `porter unicode61 remove_diacritics 2`、単一external-content列。strict ANDを先に、relaxed ORを後に採る。各tier内BM25昇順、rowidでtie break、全候補列挙後にbest rowでentity dedup。
- 順位付けが使うのはqueryとoptional exact repo filterのみ。target/eligible-sourceは順位付け後の採点にだけ使用する。

環境version（Node/ICU/Python/SQLite/compile options）、bytes/rows、build時間、prepare時間、1warmup +31queryのsample/median、全候補・snippet・match windowsを出す。ローカル時間・DB bytesは本番CPU/RAM/費用の保証ではない。Node/ICU/SQLite versionが変わるとtokenや順位が変わりうる。CIの固定順位検査はそのfixture契約であり汎用FTS品質を保証しない。

## 指標と観測された範囲

named target hit@1/@3は事前指定pathの順位。literal-source entity hitは同repoの原本文にexact query文字列がある任意entityの順位で、意味的goldではない。eligible entityがprefix由来で偶然rankすることもあるため、**top1のindex row自体にphraseがあるか**も別に記録する。negativeはこのfixture中のliteral不在を検査するだけで、productionで答えられないことを意味しない。`ngr_prefix` の `judgment relation` は個々のtokenがprefix内にあるgeneral-query controlであり、phrase-in-prefix controlではない。

固定fixtureでのtail3件の再計算:

| Arm | named target @1/@3 | literal-source entity @1/@3 | top1 index rowにliteral |
|---|---|---|---|
| prefix | 0/3, 1/3 | 1/3, 1/3 | 0/3 |
| full | 3/3, 3/3 | 3/3, 3/3 | 3/3 |
| chunks | 2/3, 3/3 | 3/3, 3/3 | 3/3 |

webhook chunkの1位は別資料にも同じ根拠literalがあるため、named-target差からfullの品質優位を導かない。prefix/fullはproduction natural topK3の各branch cap、outer6、entity dedupとの14結果の一致を別監査する。chunkは全列挙/dedupでありproduction candidate capとは異なる。コード/trigram/dense/graph/RRFを含めた本番の検索経路は測定しない。

## 静的根拠露出と節長

現在のsnapshotのrerank内容予算は `1700-min(query.length,200)` UTF16 units。full入力と採点targetのwinning8000 chunkのprefixには3tailのphraseがどれも収まらない。見出し節候補はpath+改行2つ+節（見出しmarkup含む）の仮想prefixで、2/3が見える。NGRは19454-unitの節の後半にあり隠れる。これは節retrieval/rerankingを実行した結果ではない。

節解析はfence外のATX h1-h6 / single-line setext h1/h2間を区切り、親子集約しない。非空preambleを含み、空preambleを別集計。indented code、blockquote、listのsetext候補を除外する簡易parserで、完全なCommonMark対応を主張しない。UTF16 nearest-rank percentilesを記録する。tail対象root3は74節、59節が<=1700。多数の短節があってもsection chunkだけで十分とは証明しない。

## 残課題

端-to-端モデル正答率、誤陽性のrelevance注釈、広いcorpusでの評価は未測定。採用前にはunchanged-hash backfill、deletion/replacement、provenance、chunk ID/offset、entity dedup、candidate budget、rerank evidence slice、return/fetch-source semantics、D1 statement/size/CPU制約を決める必要がある。chunk境界でphrase/tokenが分割される影響も未評価。
