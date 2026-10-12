/**
 * Word segmentation for the FTS5 natural-language (BM25) index.
 *
 * Layer = L4 Operations (sparse retrieval surface)
 *
 * Why this exists (issue #180 fact 1 / #182):
 * FTS5's `unicode61` tokenizer splits on non-alphanumeric characters only. Japanese
 * text has no such separators, so a whole run of kana/kanji between two punctuation
 * marks becomes ONE token. A Japanese phrase query then matches nothing unless it is
 * byte-identical to that run, which is why `sparse_candidates` was 0 for Japanese
 * phrases while English queries worked. D1 cannot load a custom tokenizer (`icu` is
 * not compiled in), so the split has to happen before the text reaches SQLite.
 *
 * `Intl.Segmenter` is available in workerd and in Node, ships with the runtime, and
 * needs no dependency. We run it on both sides of the index:
 *   - ingest side: `search_docs.content_fts` stores the segmented text,
 *   - query side:  the nat MATCH string is built from the segmented query.
 * Because the same segmenter runs on both sides, its mistakes are symmetric.
 * Katakana words in particular are over-split, which costs precision but not recall:
 * the same wrong split is applied to the query.
 *
 * `search_docs.content` keeps the raw text — it feeds the reranker and the code
 * (trigram) index, both of which want the original.
 */

/**
 * Scripts written without word separators, for which `unicode61` alone produces
 * one giant token: CJK punctuation/symbols, hiragana, katakana, CJK ideographs
 * (incl. extension A and compatibility), and halfwidth katakana.
 *
 * Text with none of these is left untouched — see `segmentForFts`.
 */
const UNSPACED_SCRIPT_RE =
  /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿･-ﾟ]/u;

/**
 * Lazily constructed, module-level singleton. Constructing a segmenter is the
 * expensive part; `segment()` itself is cheap.
 *
 * There is deliberately no "runtime lacks Intl.Segmenter" fallback. A silent
 * fallback would still be symmetric across ingest and query, so it would not throw —
 * it would quietly reinstate the #180 bug for a whole generation of rows. A loud
 * failure is the observable one.
 */
let segmenter: Intl.Segmenter | undefined;

function getSegmenter(): Intl.Segmenter {
  if (segmenter === undefined) {
    segmenter = new Intl.Segmenter("ja", { granularity: "word" });
  }
  return segmenter;
}

/** True when `text` contains a script that `unicode61` cannot split on its own. */
export function needsSegmentation(text: string): boolean {
  return UNSPACED_SCRIPT_RE.test(text);
}

/**
 * Insert word boundaries as spaces so `unicode61` can tokenize the text.
 *
 * Text without an unspaced script is returned verbatim. That fast path is not just
 * an optimization: it is the guarantee that English behaviour cannot regress, since
 * the stored/queried string stays byte-identical to what the current generation
 * indexes. (Mixed text does go through the segmenter, but ICU never breaks inside an
 * alphanumeric run, so the ASCII words inside it survive as whole segments and still
 * match an unsegmented English query.)
 *
 * Whitespace-only segments are dropped and the rest joined with a single space, so
 * the function is idempotent: segmenting already-segmented text returns it unchanged.
 */
export function segmentForFts(text: string): string {
  if (!needsSegmentation(text)) return text;

  const out: string[] = [];
  for (const { segment } of getSegmenter().segment(text)) {
    const trimmed = segment.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out.join(" ");
}
