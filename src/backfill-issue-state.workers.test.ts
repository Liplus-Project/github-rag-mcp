import { describe, it, expect, beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { upsertFtsRow, queryFts, type FtsUpsertRow } from "./fts.js";
import { selectIndexedOpenRows, markRowsClosed } from "./backfill-issue-state.js";

// Shared local D1, no per-test isolation — see the note in fts.workers.test.ts.
// Every vector_id and repo here is unique to this file.
beforeAll(async () => {
  await applyD1Migrations(env.DB_FTS, env.TEST_MIGRATIONS);
});

function mkRow(
  overrides: Partial<FtsUpsertRow> &
    Pick<FtsUpsertRow, "vectorId" | "type" | "content" | "repo">,
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

async function readState(vectorId: string): Promise<string> {
  const row = await env.DB_FTS
    .prepare(`SELECT state FROM search_docs WHERE vector_id = ?`)
    .bind(vectorId)
    .first<{ state: string }>();
  return String(row?.state ?? "");
}

describe("backfill-issue-state D1: candidate selection", () => {
  it("returns open issue / PR rows in number order, and nothing else", async () => {
    const repo = "t/state-select";
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:sel-2", type: "issue", repo, number: 2, content: "second" }));
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:sel-1", type: "issue", repo, number: 1, content: "first" }));
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "p:sel-3", type: "pull_request", repo, number: 3, content: "third" }));
    // Excluded: already closed, a different surface type, and another repo.
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:sel-4", type: "issue", repo, number: 4, state: "closed", content: "fourth" }));
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "r:sel-5", type: "release", repo, number: 5, content: "fifth" }));
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:sel-6", type: "issue", repo: "t/other-repo", number: 6, content: "sixth" }));

    const rows = await selectIndexedOpenRows(env.DB_FTS, repo, 0, 50);

    expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.vectorId)).toEqual(["i:sel-1", "i:sel-2", "p:sel-3"]);
  });

  it("resumes after the cursor and honours the row budget", async () => {
    const repo = "t/state-cursor";
    for (const n of [1, 2, 3, 4]) {
      await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: `i:cur-${n}`, type: "issue", repo, number: n, content: `row ${n}` }));
    }

    const first = await selectIndexedOpenRows(env.DB_FTS, repo, 0, 2);
    const second = await selectIndexedOpenRows(env.DB_FTS, repo, first[first.length - 1].number, 2);

    expect(first.map((r) => r.number)).toEqual([1, 2]);
    expect(second.map((r) => r.number)).toEqual([3, 4]);
  });
});

describe("backfill-issue-state D1: closing rows", () => {
  it("flips the stored state and drops the row out of the candidate set", async () => {
    const repo = "t/state-close";
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:close-1", type: "issue", repo, number: 1, content: "stale open row" }));
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:close-2", type: "issue", repo, number: 2, content: "genuinely open row" }));

    await markRowsClosed(env.DB_FTS, ["i:close-1"]);

    expect(await readState("i:close-1")).toBe("closed");
    expect(await readState("i:close-2")).toBe("open");
    expect((await selectIndexedOpenRows(env.DB_FTS, repo, 0, 50)).map((r) => r.number)).toEqual([2]);
  });

  it("keeps the FTS5 index intact and moves the row across the state filter", async () => {
    // The UPDATE trigger deletes and reinserts the row in the FTS5 index. This is the
    // path that used to throw (migration 0005 / issue #175), and a corrupt vtab would
    // surface here as a failing or empty bm25 query.
    const repo = "t/state-filter";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: "i:filter-1", type: "issue", repo, number: 1, content: "kubernetes scheduler regression" }),
    );

    expect((await queryFts(env.DB_FTS, "scheduler", 10, { repo, state: "open" })).map((h) => h.vectorId))
      .toEqual(["i:filter-1"]);

    await markRowsClosed(env.DB_FTS, ["i:filter-1"]);

    expect(await queryFts(env.DB_FTS, "scheduler", 10, { repo, state: "open" })).toEqual([]);
    const closed = await queryFts(env.DB_FTS, "scheduler", 10, { repo, state: "closed" });
    expect(closed.map((h) => h.vectorId)).toEqual(["i:filter-1"]);
    expect(closed[0].content).toBe("kubernetes scheduler regression");
  });

  it("is a no-op on an empty id list", async () => {
    await expect(markRowsClosed(env.DB_FTS, [])).resolves.toBeUndefined();
  });
});
