import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS } from "../server/tools.js";

// MCP clients validate arguments against the schema the proxy answers
// `tools/list` with, so a value missing here is rejected before the request ever
// reaches the Worker. gh#181: `wiki_doc` was a returned result type but not an
// accepted filter value, which made wiki-only searches impossible.
const search = TOOLS.find((t) => t.name === "search");
const typeParam = search?.inputSchema?.properties?.type;

const EXPECTED_TYPES = [
  "issue",
  "pull_request",
  "release",
  "doc",
  "wiki_doc",
  "diff",
  "issue_comment",
  "pr_review",
  "pr_review_comment",
  "all",
];

test("search tool exposes a type filter enum", () => {
  assert.ok(search, "search tool is present in TOOLS");
  assert.ok(Array.isArray(typeParam?.enum), "type param declares an enum");
});

test("type filter accepts wiki_doc", () => {
  assert.ok(
    typeParam.enum.includes("wiki_doc"),
    "wiki_doc must be selectable so wiki pages can be searched on their own",
  );
});

test("type filter carries exactly the indexed surfaces plus all", () => {
  assert.deepEqual([...typeParam.enum].sort(), [...EXPECTED_TYPES].sort());
});

test("all remains the union value", () => {
  assert.ok(typeParam.enum.includes("all"), "`all` stays available as the default union");
});

test("tool and type descriptions document the wiki surface", () => {
  assert.match(search.description, /wiki/i);
  assert.match(typeParam.description, /wiki_doc/);
});

// gh#219: the proxy schema is the description a client actually reads, so the
// exact-match requirement on `repo` has to be stated here — a bare repository
// name silently selects nothing, and the caller has no way to see that from the
// zero-result response alone.
// gh#239: fetch mode returns the index's copy of a body — the embedding input,
// truncated at the ingest ceiling. A caller reading this schema is the one that
// decides whether to trust the text as whole, so the provenance, the ceiling,
// the per-row flag and the partial-success field all have to be stated here.
test("vector_ids description states provenance, ceiling, and partial success", () => {
  const param = search?.inputSchema?.properties?.vector_ids;
  assert.ok(param, "vector_ids param is present in the mirrored schema");
  assert.equal(param.type, "array");
  assert.equal(param.items?.type, "string");
  assert.match(param.description, /INDEXED copy/);
  assert.match(param.description, /8000/);
  assert.match(param.description, /content_truncated/);
  assert.match(param.description, /not_found/);
  assert.match(param.description, /no GitHub API call/i);
  // The id is a handle for the result set it arrived in, not a citation: this
  // repository has migrated its vector id scheme once already.
  assert.match(param.description, /not a durable identifier/);
});

test("repo description states the full-slug exact match and the unmatched-filter signal", () => {
  const repoParam = search?.inputSchema?.properties?.repo;
  assert.ok(repoParam, "repo param is present in the mirrored schema");
  assert.match(repoParam.description, /owner\/repo/);
  assert.match(repoParam.description, /exact match/i);
  assert.match(repoParam.description, /filters_unmatched/);
});

test("path_prefix is exposed as a doc-only directory filter", () => {
  const param = search?.inputSchema?.properties?.path_prefix;
  assert.ok(param, "path_prefix param is present in the mirrored schema");
  assert.equal(param.type, "string");
  assert.match(param.description, /type="doc"/);
  assert.match(param.description, /(trailing \/|end with \/)/i);
  assert.match(param.description, /64 UTF-8 bytes/);
  assert.match(param.description, /filters_unmatched/);
});
