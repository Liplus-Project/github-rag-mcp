import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkBounds, prepare } from "./document-tail-prepare.mjs";
import { sections } from "./document-tail-headings.mjs";

const fixture = path.resolve("experiments/document-tail");
test("UTF16 chunk boundary preserves surrogate pairs and exact reconstruction", () => {
  const raw = "x".repeat(7999) + "😀" + "y".repeat(8000);
  const bounds = chunkBounds(raw);
  assert.equal(bounds[0][1], 7999);
  assert.equal(bounds.map(([a, b]) => raw.slice(a, b)).join(""), raw);
  assert.ok(bounds.every(([a, b]) => b - a <= 8000));
});
test("heading parser excludes fenced ATX/setext and retains actual headings", () => {
  const text =
    "# One\n```md\n# Fake\nFake\n----\n```\n~~~\n## Fake too\n~~~\nTwo\n===\nbody\n";
  assert.deepEqual(
    sections(text)
      .filter((s) => s.level)
      .map((s) => s.title),
    ["One", "Two"],
  );
});
test("hash verification rejects fixture/source tampering before indexing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tail-hash-"));
  try {
    fs.cpSync(fixture, path.join(tmp, "fixture"), { recursive: true });
    fs.appendFileSync(path.join(tmp, "fixture", "fixture.json"), " ");
    await assert.rejects(
      prepare(path.join(tmp, "fixture"), tmp),
      /Fixture hash mismatch/,
    );
    fs.copyFileSync(
      path.join(fixture, "fixture.json"),
      path.join(tmp, "fixture", "fixture.json"),
    );
    fs.appendFileSync(path.join(tmp, "fixture", "source-src-segment.ts"), " ");
    await assert.rejects(
      prepare(path.join(tmp, "fixture"), tmp),
      /Source hash mismatch/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
