import { describe, it, expect, beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { upsertFtsRow, type FtsUpsertRow } from "./fts.js";
import { getDocsByVectorIds } from "./graph.js";

/**
 * D1-backed tests for `getDocsByVectorIds` — the batched content source the
 * search path uses to backfill reranker input for dense-only candidates
 * (issue #172). A Japanese query yields zero FTS5 hits, so every candidate is
 * dense-only and carries no inline content; this query is what supplies it.
 *
 * Shared-DB caveat (same as fts.workers.test.ts): isolatedStorage is false, so
 * every vector_id here is globally unique and no test cleans up.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB_FTS, env.TEST_MIGRATIONS);
});

function mkRow(
  overrides: Partial<FtsUpsertRow> & Pick<FtsUpsertRow, "vectorId" | "type" | "content" | "repo">,
): FtsUpsertRow {
  return {
    state: "open",
    labels: "",
    milestone: "",
    assignees: "",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("getDocsByVectorIds: reranker content backfill source (#172)", () => {
  it("returns content for a row that no FTS5 query would have matched", async () => {
    // Japanese body: the nat tokenizer (porter + unicode61) does not segment it,
    // so the dense path is the only way this row surfaces — no FtsRow, no inline
    // content, hence the backfill.
    const repo = "t/backfill-ja";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({
        vectorId: "i:backfill-ja",
        type: "issue",
        repo,
        content: "memoryとDecision StructureをSQLiteベースで実装するかの判断記録",
      }),
    );

    const rows = await getDocsByVectorIds(env.DB_FTS, ["i:backfill-ja"]);
    expect(rows.size).toBe(1);
    expect(String(rows.get("i:backfill-ja")?.content ?? "")).toContain("Decision Structure");
  });

  it("fetches many vector IDs in one batched query (no per-candidate fan-out)", async () => {
    const repo = "t/backfill-batch";
    const ids = ["i:backfill-b1", "i:backfill-b2", "i:backfill-b3"];
    for (const [i, id] of ids.entries()) {
      await upsertFtsRow(
        env.DB_FTS,
        mkRow({ vectorId: id, type: "issue", repo, content: `batched candidate body ${i}` }),
      );
    }

    const rows = await getDocsByVectorIds(env.DB_FTS, ids);
    expect([...rows.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(String(rows.get(id)?.content ?? "").length).toBeGreaterThan(0);
    }
  });

  it("omits unknown vector IDs instead of throwing, so backfill degrades partially", async () => {
    const repo = "t/backfill-miss";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: "i:backfill-present", type: "issue", repo, content: "present body" }),
    );

    const rows = await getDocsByVectorIds(env.DB_FTS, ["i:backfill-present", "i:backfill-absent"]);
    expect([...rows.keys()]).toEqual(["i:backfill-present"]);
  });

  it("returns an empty map for an empty id list without issuing a query", async () => {
    expect((await getDocsByVectorIds(env.DB_FTS, [])).size).toBe(0);
  });
});
