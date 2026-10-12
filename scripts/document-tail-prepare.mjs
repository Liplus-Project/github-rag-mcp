import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
export const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
export function chunkBounds(raw) {
  const bounds = [];
  for (let pos = 0; pos < raw.length;) {
    let end = Math.min(pos + 8000, raw.length);
    if (
      end < raw.length &&
      /[\uD800-\uDBFF]/u.test(raw[end - 1]) &&
      /[\uDC00-\uDFFF]/u.test(raw[end])
    )
      end--;
    bounds.push([pos, end]);
    pos = end;
  }
  return bounds;
}
export async function prepare(dir, out) {
  const protocol = JSON.parse(
    fs.readFileSync(path.join(dir, "protocol.json"), "utf8"),
  );
  const inputBytes = fs.readFileSync(path.join(dir, "fixture.json"));
  if (hash(inputBytes) !== protocol.fixture_sha256)
    throw Error("Fixture hash mismatch");
  for (const [file, digest] of Object.entries(protocol.source_hashes))
    if (hash(fs.readFileSync(path.join(dir, file))) !== digest)
      throw Error("Source hash mismatch: " + file);
  const fixture = JSON.parse(inputBytes);
  const provenanceBytes = fs.readFileSync(path.join(dir, "provenance.json"));
  if (hash(provenanceBytes) !== protocol.provenance_sha256)
    throw Error("Provenance hash mismatch");
  const provenance = JSON.parse(provenanceBytes);
  if (provenance.length !== fixture.docs.length)
    throw Error("Provenance coverage mismatch");
  for (const d of fixture.docs) {
    const source = provenance.find(
      (s) => s.repo === d.repo && s.path === d.path,
    );
    if (!source || hash(d.text) !== source.content_sha256)
      throw Error("Provenance body hash mismatch");
    const bytes = Buffer.from(d.text);
    const blob = crypto
      .createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
    if (blob !== source.blob_sha) throw Error("Provenance blob mismatch");
  }

  const { segmentForFts } = await import(
    pathToFileURL(path.join(dir, "source-src-segment.ts"))
  );
  const fts = fs.readFileSync(path.join(dir, "source-src-fts.ts"), "utf8");
  const literal = fts.slice(
    fts.indexOf("export function escapeFtsQuery"),
    fts.indexOf("\n/**", fts.indexOf("export function escapeFtsQuery")),
  );
  const executable = literal
    .replace('raw: string, mode: FtsMatchMode = "all"', 'raw, mode = "all"')
    .replace("): string {", ") {");
  const { escapeFtsQuery } = await import(
    "data:text/javascript," + encodeURIComponent(executable)
  );
  const start = performance.now(),
    rows = { prefix: [], full: [], chunks: [] },
    inventory = [];
    for (const d of fixture.docs) {
    const raw = d.path + "\n\n" + d.text,
      entity = d.repo + ":" + d.path;
    const add = (v, text, offset, chunk) =>
      rows[v].push({
        entity,
        repo: d.repo,
        path: d.path,
        chunk,
        offset,
        raw: text,
        segmented: segmentForFts(text),
      });
    add("prefix", raw.slice(0, 8000), 0, 0);
    add("full", raw, 0, 0);
    const bounds = chunkBounds(raw);
    for (const [chunk, [pos, end]] of bounds.entries())
      add("chunks", raw.slice(pos, end), pos, chunk);
    inventory.push({
      entity,
      body_utf16: d.text.length,
      body_utf8_bytes: Buffer.byteLength(d.text),
      body_sha256: hash(d.text),
      declared_version: d.version,
      version_hash_matches: d.version === "sha256:" + hash(d.text),
      full_utf16: raw.length,
      prefix_utf16: Math.min(8000, raw.length),
      chunk_bounds_utf16: bounds,
    });
  }
  if (!inventory.every((d) => d.version_hash_matches))
    throw Error("Body version hash mismatch");
  const queries = fixture.queries.map((q) => ({
    ...q,
    segmented: segmentForFts(q.text),
    match_all: escapeFtsQuery(segmentForFts(q.text), "all"),
    match_any: escapeFtsQuery(segmentForFts(q.text), "any"),
  }));
  const literalAudits = queries.map((q) => {
    if (!q.target)
      return {
        id: q.id,
        absent_from_all_bodies: fixture.docs.every(
          (d) => !d.text.includes(q.text),
        ),
        absent_from_all_index_sources: fixture.docs.every(
          (d) => !(d.path + "\n\n" + d.text).includes(q.text),
        ),
      };
    const d = fixture.docs.find(
        (d) => d.repo === q.repo && d.path === q.target,
      ),
      raw = d.path + "\n\n" + d.text,
      offset = d.text.indexOf(q.text),
      idx = raw.indexOf(q.text);
    return {
      id: q.id,
      body_offset_utf16: offset,
      body_offset_utf8_bytes:
        offset < 0 ? null : Buffer.byteLength(d.text.slice(0, offset)),
      index_offset_utf16: idx,
      index_offset_utf8_bytes:
        idx < 0 ? null : Buffer.byteLength(raw.slice(0, idx)),
      literal_present: offset >= 0,
      prefix_literal_present: raw.slice(0, 8000).includes(q.text),
      original_excerpt:
        offset < 0
          ? null
          : d.text.slice(
              Math.max(0, offset - 80),
              offset + q.text.length + 100,
            ),
    };
  });
  const prep = {
    sha: protocol.source_sha,
    sources: protocol.source_hashes,
    input_sha256: hash(inputBytes),
    input_bytes: inputBytes.length,
    fixture_sha256: hash(inputBytes),
    body_utf16_total: inventory.reduce((s, d) => s + d.body_utf16, 0),
    body_utf8_bytes_total: inventory.reduce((s, d) => s + d.body_utf8_bytes, 0),
    node_versions: process.versions,
    segmentation_prepare_elapsed_ms: performance.now() - start,
    inventory,
    literalAudits,
    rows,
    queries,
  };
  fs.writeFileSync(
    path.join(out, "prepared.json"),
    JSON.stringify(prep, null, 2) + "\n",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await prepare(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
