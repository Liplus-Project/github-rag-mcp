/**
 * D1-backed tests for fetch mode — the `vector_ids` branch of `search` (#239).
 *
 * The point of the mode is that every indexed type can hand its body back, not
 * just the two that could before, so the coverage here is per type. Rows go in
 * through the real ingest writer (`upsertFtsRow`) and come out through the real
 * read (`fetchStoredContent`), which is what makes this a check on the schema
 * agreeing with the assembly rather than on a hand-built row.
 *
 * Shared-DB caveat (same as graph.workers.test.ts): isolatedStorage is false,
 * so every vector_id here is globally unique and no test cleans up.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { upsertFtsRow, type FtsUpsertRow } from "./fts.js";
import { fetchStoredContent } from "./fetch.js";
import { MAX_EMBEDDING_INPUT_CHARS } from "./pipeline/embedding.js";

const REPO = "t/fetch-mode";

beforeAll(async () => {
  await applyD1Migrations(env.DB_FTS, env.TEST_MIGRATIONS);
});

function mkRow(
  overrides: Partial<FtsUpsertRow> &
    Pick<FtsUpsertRow, "vectorId" | "type" | "content">,
): FtsUpsertRow {
  return {
    repo: REPO,
    state: "open",
    labels: "",
    milestone: "",
    assignees: "",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** The seven types the issue names, plus the two that already had a body path. */
const SURFACES: Array<{ id: string; row: FtsUpsertRow }> = [
  {
    id: "fetch:issue",
    row: mkRow({
      vectorId: "fetch:issue",
      type: "issue",
      number: 239,
      content: "feat(mcp): add vector_ids\n\n索引が既に保持している本文を取り出せるようにする",
    }),
  },
  {
    id: "fetch:pr",
    row: mkRow({
      vectorId: "fetch:pr",
      type: "pull_request",
      number: 240,
      content: "pr title\n\npr body text",
    }),
  },
  {
    id: "fetch:comment",
    row: mkRow({
      vectorId: "fetch:comment",
      type: "issue_comment",
      state: "active",
      number: 239,
      content: "smileygames\n\ncomment body text",
    }),
  },
  {
    id: "fetch:review",
    row: mkRow({
      vectorId: "fetch:review",
      type: "pr_review",
      state: "APPROVED",
      number: 240,
      content: "smileygames\n\nreview body text",
    }),
  },
  {
    id: "fetch:review-comment",
    row: mkRow({
      vectorId: "fetch:review-comment",
      type: "pr_review_comment",
      state: "active",
      number: 240,
      filePath: "src/fetch.ts",
      commitSha: "abc1234",
      content: "smileygames\n\ninline comment body",
    }),
  },
  {
    id: "fetch:release",
    row: mkRow({
      vectorId: "fetch:release",
      type: "release",
      state: "published",
      tagName: "v0.9.0",
      content: "v0.9.0\n\nrelease notes body",
    }),
  },
  {
    id: "fetch:diff",
    row: mkRow({
      vectorId: "fetch:diff",
      type: "diff",
      state: "active",
      commitSha: "6acdbd3",
      filePath: "src/mcp.ts",
      fileStatus: "modified",
      commitDate: "2026-02-02T00:00:00Z",
      commitAuthor: "smileygames",
      content: "commit message\n\nsrc/mcp.ts\n\n@@ -1 +1 @@\n-old\n+new",
    }),
  },
  {
    id: "fetch:doc",
    row: mkRow({
      vectorId: "fetch:doc",
      type: "doc",
      state: "active",
      docPath: "docs/0-requirements.md",
      content: "requirements body",
    }),
  },
  {
    id: "fetch:wiki",
    row: mkRow({
      vectorId: "fetch:wiki",
      type: "wiki_doc",
      state: "active",
      docPath: "Decision-Structure",
      content: "wiki page body",
    }),
  },
];

beforeAll(async () => {
  for (const s of SURFACES) await upsertFtsRow(env.DB_FTS, s.row);
});

describe("fetchStoredContent: every indexed type returns its body", () => {
  it("returns content for all nine surfaces in one call", async () => {
    const ids = SURFACES.map((s) => s.id);
    const res = await fetchStoredContent(env.DB_FTS, ids);

    expect(res.mode).toBe("fetch");
    expect(res.count).toBe(ids.length);
    expect(res.not_found).toEqual([]);
    // Order follows the request, so a caller can line results up with its list.
    expect(res.results.map((r) => r.vector_id)).toEqual(ids);
    for (const item of res.results) {
      expect(item.content.length).toBeGreaterThan(0);
    }
  });

  it("returns the non-doc bodies that had no retrieval path before #239", async () => {
    const res = await fetchStoredContent(env.DB_FTS, [
      "fetch:issue",
      "fetch:comment",
      "fetch:diff",
    ]);
    const byId = new Map(res.results.map((r) => [r.vector_id, r]));
    expect(byId.get("fetch:issue")?.content).toContain("索引が既に保持している本文");
    expect(byId.get("fetch:comment")?.content).toContain("comment body text");
    expect(byId.get("fetch:diff")?.content).toContain("@@ -1 +1 @@");
  });

  it("carries the per-type identity columns the schema holds", async () => {
    const res = await fetchStoredContent(env.DB_FTS, [
      "fetch:diff",
      "fetch:release",
      "fetch:wiki",
      "fetch:review-comment",
    ]);
    const byId = new Map(res.results.map((r) => [r.vector_id, r]));

    expect(byId.get("fetch:diff")?.commit_sha).toBe("6acdbd3");
    expect(byId.get("fetch:diff")?.file_path).toBe("src/mcp.ts");
    expect(byId.get("fetch:release")?.tag_name).toBe("v0.9.0");
    expect(byId.get("fetch:wiki")?.wiki_path).toBe("Decision-Structure");
    expect(byId.get("fetch:review-comment")?.file_path).toBe("src/fetch.ts");
  });

  it("states the source and the ceiling on every response", async () => {
    const res = await fetchStoredContent(env.DB_FTS, ["fetch:issue"]);
    expect(res.content_source).toBe("index");
    expect(res.content_max_chars).toBe(MAX_EMBEDDING_INPUT_CHARS);
    expect(res.results[0].content_truncated).toBe(false);
  });
});

describe("fetchStoredContent: truncation is visible on the row", () => {
  it("flags a row stored at the ingest ceiling", async () => {
    // What a long diff patch looks like after the pipeline truncates it: the
    // tail is not in the index, and nothing about the text itself says so.
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({
        vectorId: "fetch:truncated",
        type: "diff",
        state: "active",
        content: "d".repeat(MAX_EMBEDDING_INPUT_CHARS),
      }),
    );

    const res = await fetchStoredContent(env.DB_FTS, ["fetch:truncated", "fetch:doc"]);
    const byId = new Map(res.results.map((r) => [r.vector_id, r]));
    expect(byId.get("fetch:truncated")?.content_truncated).toBe(true);
    expect(byId.get("fetch:truncated")?.content_chars).toBe(MAX_EMBEDDING_INPUT_CHARS);
    // Same call, so the flag is per row and not a property of the response.
    expect(byId.get("fetch:doc")?.content_truncated).toBe(false);
  });
});

describe("fetchStoredContent: partial success", () => {
  it("returns the live rows and lists the unknown ids", async () => {
    const res = await fetchStoredContent(env.DB_FTS, [
      "fetch:issue",
      "fetch:no-such-id",
      "fetch:doc",
    ]);
    expect(res.results.map((r) => r.vector_id)).toEqual(["fetch:issue", "fetch:doc"]);
    expect(res.not_found).toEqual(["fetch:no-such-id"]);
    expect(res.count).toBe(2);
    expect(res.requested).toBe(3);
  });

  it("reports every id as missing when none resolve, rather than erroring", async () => {
    const res = await fetchStoredContent(env.DB_FTS, ["fetch:gone-a", "fetch:gone-b"]);
    expect(res.count).toBe(0);
    expect(res.results).toEqual([]);
    expect(res.not_found).toEqual(["fetch:gone-a", "fetch:gone-b"]);
  });

  it("de-duplicates repeated ids instead of returning the row twice", async () => {
    const res = await fetchStoredContent(env.DB_FTS, [
      "fetch:issue",
      "fetch:issue",
      " fetch:issue ",
    ]);
    expect(res.requested).toBe(1);
    expect(res.results.map((r) => r.vector_id)).toEqual(["fetch:issue"]);
  });

  it("drops blank ids rather than reporting them as missing rows", async () => {
    const res = await fetchStoredContent(env.DB_FTS, ["", "   ", "fetch:issue"]);
    expect(res.requested).toBe(1);
    expect(res.not_found).toEqual([]);
    expect(res.count).toBe(1);
  });

  it("returns an empty response for an empty id list without issuing a query", async () => {
    const res = await fetchStoredContent(env.DB_FTS, []);
    expect(res.count).toBe(0);
    expect(res.requested).toBe(0);
    expect(res.results).toEqual([]);
    expect(res.not_found).toEqual([]);
  });
});
