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
