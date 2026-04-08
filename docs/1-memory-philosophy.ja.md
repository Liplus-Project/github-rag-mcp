# Memory Philosophy

言語: [English](1-memory-philosophy.md) | 日本語

## Summary

`github-rag-mcp` は次の考えに基づいている。

GitHub は AI によるソフトウェア作業の shared working memory になりうる。

このシステムは complete memory を目指さない。recoverable state を目指す。

## The problem

多くの memory system は会話を丸ごと覚えようとする。

この方向には二つの失敗が起きやすい。

- 余計な情報が蓄積して retrieval が noisy になる
- 要約の過程で重要な制約が落ちる

ソフトウェア作業ではどちらも高コストで、後続 agent が誤った state から自信を持って続きを始めてしまう。

## The design stance

本プロジェクトは次の立場を取る。

- 余計な情報を足さない
- 次の正しい行動に必要な情報を引かない
- 状態は durable で human-visible な artifact に保存する

つまり memory は model が見たもの全部の private archive ではない。

既に意味を持つ artifact の上に乗る state recovery layer として扱う。

- issue body と label
- pull request と review state
- repository docs
- releases

## Why this matters for multi-agent work

multi-agent system に必要なのは storage だけではなく stable interface である。

GitHub にはすでに自然な interface がある。

- issue は何をやるかを表す
- pull request は何が変わったかを表す
- docs は何が固定化されたかを表す
- release は何が出荷されたかを表す

retrieval をこれらの surface の上に載せることで、agent 同士は hidden chat memory に依存せずに work を引き継げる。

## Why this matters for session handoff

session boundary は普通に起こる。

後続 session は chat transcript 全体を再生しなくても current state を取り戻せるべきである。

代わりに次の問いに答えられればよい。

- この task は何か
- どの制約が受け入れ済みか
- 何が実装済みか
- 何が未解決か
- 何が release 済みか

本プロジェクトが保存・取得したいのはこの state である。

## What this project is not

これは次のものではない。

- complete transcript archive
- すべての思考を保存する仕組み
- source-of-truth GitHub artifact の代替

これはそれらの artifact から正しい state を引き戻すための retrieval layer である。
