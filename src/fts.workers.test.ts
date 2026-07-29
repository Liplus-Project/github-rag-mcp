import { describe, it, expect, beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { upsertFtsRow, queryFts, deleteFtsRow, type FtsUpsertRow } from "./fts.js";

// One shared local D1 (isolatedStorage:false — per-test snapshotting corrupts FTS5
// external-content shadow tables). Tests therefore share a DB and do NOT clean up:
//   - every vector_id is globally unique, so no cross-test ON CONFLICT UPDATE fires
//     (a stray cross-test update on the FTS5 external-content table is what corrupts
//     the vtab — SQLITE_CORRUPT_VTAB);
//   - every query is scoped with the `repo` filter so accumulated rows from other
//     tests are excluded by the SQL WHERE clause.
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

describe("fts D1: upsert + query (natural-language / porter)", () => {
  it("indexes a nat row and matches it by word", async () => {
    const repo = "t/nat-match";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: "i:nat-match", type: "issue", repo, content: "authentication failure in the login handler" }),
    );
    const hits = await queryFts(env.DB_FTS, "authentication", 10, { repo });
    expect(hits.map((h) => h.vectorId)).toEqual(["i:nat-match"]);
    expect(hits[0].repo).toBe(repo);
    expect(hits[0].type).toBe("issue");
  });

  it("does not match unrelated queries", async () => {
    const repo = "t/nat-nomatch";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: "i:nat-nomatch", type: "issue", repo, content: "authentication failure in the login handler" }),
    );
    expect(await queryFts(env.DB_FTS, "kubernetes", 10, { repo })).toEqual([]);
  });
});

describe("fts D1: diff rows via trigram (the #135 surface)", () => {
  it("indexes a diff row (code tokenizer) and matches an identifier substring", async () => {
    const repo = "t/diff-match";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({
        vectorId: "c:diff-match",
        type: "diff",
        repo,
        commitSha: "abc123",
        filePath: "src/auth.ts",
        content: "export function handleLoginCallback(req) { return verify(req); }",
      }),
    );
    const hits = await queryFts(env.DB_FTS, "handleLogin", 10, { repo });
    expect(hits.map((h) => h.vectorId)).toContain("c:diff-match");
  });

  it("re-upserting the same vector_id re-syncs the FTS mirror (ON CONFLICT + update trigger)", async () => {
    // The exact regression class behind #135: repeated upsert of a diff row must
    // re-sync the FTS5 mirror, not leave stale content searchable or duplicate rows.
    const repo = "t/diff-dup";
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "c:diff-dup", type: "diff", repo, content: "alpha bravo charlie" }));
    expect((await queryFts(env.DB_FTS, "bravo", 10, { repo })).map((h) => h.vectorId)).toContain("c:diff-dup");

    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "c:diff-dup", type: "diff", repo, content: "delta echo foxtrot" }));
    expect(await queryFts(env.DB_FTS, "bravo", 10, { repo })).toEqual([]); // stale content gone
    expect((await queryFts(env.DB_FTS, "echo", 10, { repo })).map((h) => h.vectorId)).toContain("c:diff-dup"); // new found

    const row = await env.DB_FTS.prepare("SELECT COUNT(*) AS n FROM search_docs WHERE vector_id = ?")
      .bind("c:diff-dup")
      .first<{ n: number }>();
    expect(row?.n).toBe(1); // upsert, not duplicate insert
  });
});

describe("fts D1: deleteFtsRow", () => {
  it("removes the row and its FTS mirror (no orphan hit)", async () => {
    const repo = "t/del";
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:del", type: "issue", repo, content: "deletable indexing entry" }));
    expect((await queryFts(env.DB_FTS, "deletable", 10, { repo })).length).toBe(1);

    await deleteFtsRow(env.DB_FTS, "i:del");
    expect(await queryFts(env.DB_FTS, "deletable", 10, { repo })).toEqual([]);
  });
});

describe("fts D1: tokenizer isolation", () => {
  it("keeps the opposite tokenizer healthy across updates and deletes", async () => {
    const repo = "t/tokenizer-isolation";
    const natId = "i:tokenizer-isolation";
    const codeId = "c:tokenizer-isolation";

    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: natId, type: "issue", repo, content: "persistent natural-language sentinel" }),
    );
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: codeId, type: "diff", repo, content: "persistentCodeSentinel" }),
    );

    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: natId, type: "issue", repo, content: "updated natural-language sentinel" }),
    );
    await deleteFtsRow(env.DB_FTS, natId);
    expect((await queryFts(env.DB_FTS, "CodeSentinel", 10, { repo })).map((h) => h.vectorId))
      .toContain(codeId);

    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: codeId, type: "diff", repo, content: "updatedCodeSentinel" }),
    );
    await deleteFtsRow(env.DB_FTS, codeId);
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: `${natId}-survivor`, type: "issue", repo, content: "healthy natural tokenizer" }),
    );
    expect((await queryFts(env.DB_FTS, "healthy", 10, { repo })).map((h) => h.vectorId))
      .toContain(`${natId}-survivor`);
  });
});

describe("fts D1: v1 corruption recovery migration", () => {
  it("backfills healthy v2 indexes without reading the corrupt v1 indexes", async () => {
    const baseMigration = env.TEST_MIGRATIONS.find((m) => m.name === "0001_fts5_init.sql");
    const repairMigration = env.TEST_MIGRATIONS.find(
      (m) => m.name === "0005_fts5_tokenizer_isolation.sql",
    );
    expect(baseMigration).toBeDefined();
    expect(repairMigration).toBeDefined();

    await applyD1Migrations(env.DB_FTS_MIGRATION, [baseMigration!]);

    const repo = "t/v1-recovery";
    const natId = "i:v1-recovery";
    const codeId = "c:v1-recovery";
    await upsertFtsRow(
      env.DB_FTS_MIGRATION,
      mkRow({ vectorId: codeId, type: "diff", repo, content: "persistentCodeSentinel" }),
    );
    await upsertFtsRow(
      env.DB_FTS_MIGRATION,
      mkRow({ vectorId: natId, type: "issue", repo, content: "original natural sentinel" }),
    );

    // The v1 UPDATE trigger sends a delete command to code_fts even though this
    // nat row was never indexed there. D1 rejects the write as a corrupt-vtab
    // operation; sparse mirroring can therefore never reconcile this row.
    await expect(
      upsertFtsRow(
        env.DB_FTS_MIGRATION,
        mkRow({ vectorId: natId, type: "issue", repo, content: "updated natural sentinel" }),
      ),
    ).rejects.toThrow(/SQLITE_CORRUPT_VTAB/);

    await applyD1Migrations(env.DB_FTS_MIGRATION, [repairMigration!]);

    await env.DB_FTS_MIGRATION
      .prepare(
        "INSERT INTO search_docs_nat_fts_v2(search_docs_nat_fts_v2, rank) VALUES('integrity-check', 1)",
      )
      .run();
    await env.DB_FTS_MIGRATION
      .prepare(
        "INSERT INTO search_docs_code_fts_v2(search_docs_code_fts_v2, rank) VALUES('integrity-check', 1)",
      )
      .run();

    expect(
      (await queryFts(env.DB_FTS_MIGRATION, "CodeSentinel", 10, { repo }))
        .map((h) => h.vectorId),
    ).toContain(codeId);
    expect(
      (await queryFts(env.DB_FTS_MIGRATION, "original", 10, { repo }))
        .map((h) => h.vectorId),
    ).toContain(natId);

    await upsertFtsRow(
      env.DB_FTS_MIGRATION,
      mkRow({ vectorId: natId, type: "issue", repo, content: "updated natural sentinel" }),
    );
    expect(
      (await queryFts(env.DB_FTS_MIGRATION, "updated", 10, { repo }))
        .map((h) => h.vectorId),
    ).toContain(natId);

    await deleteFtsRow(env.DB_FTS_MIGRATION, natId);
    expect(
      (await queryFts(env.DB_FTS_MIGRATION, "CodeSentinel", 10, { repo }))
        .map((h) => h.vectorId),
    ).toContain(codeId);
  });
});

describe("fts D1: structured filters", () => {
  it("filters by repo", async () => {
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:repo-a", type: "issue", repo: "t/repo-alpha", content: "shared keyword token" }));
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:repo-b", type: "issue", repo: "t/repo-bravo", content: "shared keyword token" }));
    const hits = await queryFts(env.DB_FTS, "keyword", 10, { repo: "t/repo-alpha" });
    expect(hits.map((h) => h.vectorId)).toEqual(["i:repo-a"]);
  });

  it("filters by type within a repo", async () => {
    const repo = "t/type-filter";
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:type-iss", type: "issue", repo, content: "common search term alpha" }));
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "r:type-rel", type: "release", repo, content: "common search term alpha" }));
    const hits = await queryFts(env.DB_FTS, "common", 10, { repo, type: "release" });
    expect(hits.map((h) => h.vectorId)).toEqual(["r:type-rel"]);
  });
});

describe("fts D1: queryFts edge cases", () => {
  it("returns [] for an empty / whitespace query (no MATCH)", async () => {
    const repo = "t/empty";
    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: "i:empty", type: "issue", repo, content: "something searchable" }));
    expect(await queryFts(env.DB_FTS, "", 10, { repo })).toEqual([]);
    expect(await queryFts(env.DB_FTS, "   ", 10, { repo })).toEqual([]);
  });

  it("respects topK", async () => {
    const repo = "t/topk";
    for (let i = 0; i < 5; i++) {
      await upsertFtsRow(
        env.DB_FTS,
        mkRow({ vectorId: `i:topk-${i}`, type: "issue", repo, content: `repeated common token number ${i}` }),
      );
    }
    expect((await queryFts(env.DB_FTS, "common", 2, { repo })).length).toBe(2);
  });
});
