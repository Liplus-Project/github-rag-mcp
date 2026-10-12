import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const R = path.resolve(process.argv[2]);
const fixtureDir = path.resolve(process.argv[3]);
const fixture = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, "fixture.json"), "utf8"),
  ),
  prepared = JSON.parse(fs.readFileSync(path.join(R, "prepared.json"), "utf8")),
  results = JSON.parse(fs.readFileSync(path.join(R, "results.json"), "utf8"));
const source = fs.readFileSync(path.join(fixtureDir, "source-src-rerank.ts"));
import { sections } from "./document-tail-headings.mjs";
const docs = fixture.docs.map((d) => ({ ...d, sections: sections(d.text) }));
const rootSet = new Set(
  fixture.queries
    .filter((q) => q.kind === "tail")
    .map((q) => q.repo + ":" + q.target),
);
function dist(ds) {
  const ss = ds
      .flatMap((d) =>
        d.sections.filter((s) => s.length_utf16 > 0).map((s) => s.length_utf16),
      )
      .sort((a, b) => a - b),
    pct = (p) => ss[Math.max(0, Math.ceil(p * ss.length) - 1)];
  return {
    documents: ds.length,
    nonempty_sections_including_preamble: ss.length,
    empty_preambles: ds.filter((d) => d.sections[0].length_utf16 === 0).length,
    sum_section_utf16: ss.reduce((a, b) => a + b, 0),
    at_most_1500: {
      count: ss.filter((n) => n <= 1500).length,
      denominator: ss.length,
      fraction: ss.filter((n) => n <= 1500).length / ss.length,
    },
    at_most_1700: {
      count: ss.filter((n) => n <= 1700).length,
      denominator: ss.length,
      fraction: ss.filter((n) => n <= 1700).length / ss.length,
    },
    p50: pct(0.5),
    p75: pct(0.75),
    p90: pct(0.9),
    p95: pct(0.95),
    max: Math.max(...ss),
  };
}
const targets = fixture.queries
  .filter((q) => q.target)
  .map((q) => {
    const d = docs.find((d) => d.repo === q.repo && d.path === q.target),
      raw = d.path + "\n\n" + d.text,
      off = d.text.indexOf(q.text),
      s = d.sections.find((s) => off >= s.offset && off < s.end),
      section = d.text.slice(s.offset, s.end),
      budget = 1700 - Math.min(q.text.length, 200),
      target = results.results.chunks
        .find((x) => x.id === q.id)
        .all_candidates.find((h) => h.entity === q.repo + ":" + q.target),
      winning = prepared.rows.chunks.find(
        (x) =>
          x.entity === q.repo + ":" + q.target && x.chunk === target?.chunk,
      ),
      literalChunk = prepared.rows.chunks.find(
        (x) => x.entity === q.repo + ":" + q.target && x.raw.includes(q.text),
      ),
      sectionInput = d.path + "\n\n" + section;
    return {
      id: q.id,
      label:
        q.id === "ngr_prefix"
          ? "general-query control (individual matching terms in prefix)"
          : q.kind,
      query_utf16: q.text.length,
      content_budget_utf16: budget,
      body_phrase_offset_utf16: off,
      section_level: s.level,
      section_title: s.title,
      section_start_body_utf16: s.offset,
      section_length_utf16: s.length_utf16,
      phrase_offset_in_section_utf16: off - s.offset,
      phrase_offset_with_path_title_utf16: off - s.offset + d.path.length + 2,
      whole_full_prefix_literal_visible: raw.slice(0, budget).includes(q.text),
      winning8000chunk: target?.chunk ?? null,
      winning8000chunk_prefix_literal_visible: winning
        ? winning.raw.slice(0, budget).includes(q.text)
        : null,
      literal8000chunk: literalChunk?.chunk ?? null,
      phrase_offset_in_literal8000chunk: literalChunk
        ? literalChunk.raw.indexOf(q.text)
        : null,
      literal8000chunk_prefix_visible: literalChunk
        ? literalChunk.raw.slice(0, budget).includes(q.text)
        : null,
      headingsection_with_path_title_prefix_literal_visible: sectionInput
        .slice(0, budget)
        .includes(q.text),
    };
  });
const out = {
  definition:
    "Adjacent ATX h1-h6 or single-line setext h1/h2 boundaries outside fenced backtick/tilde code; includes heading line/markup, ends immediately before next heading, no parent-child aggregation. Nonempty preamble included, empty preamble separately counted/excluded from fractions. Indented code/blockquote/list setext candidates excluded; no full CommonMark parser claim. UTF16 units, nearest-rank percentiles. Root3 are manually supplied tail-target docs, all11 are complete fixture.",
  rerank_source_sha256: crypto
    .createHash("sha256")
    .update(source)
    .digest("hex"),
  root3: dist(docs.filter((d) => rootSet.has(d.repo + ":" + d.path))),
  all11: dist(docs),
  targets,
  per_document: docs.map((d) => ({
    repo: d.repo,
    path: d.path,
    sections: d.sections,
  })),
};
fs.writeFileSync(
  path.join(R, "sections.json"),
  JSON.stringify(out, null, 2) + "\n",
);
console.log(JSON.stringify({ root3: out.root3, all11: out.all11, targets }));
