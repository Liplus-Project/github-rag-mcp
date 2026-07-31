import { describe, it, expect, beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import {
  upsertFtsRow,
  queryFts,
  deleteFtsRow,
  backfillNatSegments,
  tokenizerKindForType,
  type FtsUpsertRow,
} from "./fts.js";

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

/**
 * Insert a row the way the code did before migration 0006 — no `content_fts` column.
 * Used only by the v1-corruption test, which has to build its pre-repair state on a
 * database where 0006 has not been applied yet.
 */
async function insertLegacyRow(
  db: D1Database,
  row: Pick<FtsUpsertRow, "vectorId" | "repo" | "type" | "content">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO search_docs (
         vector_id, repo, type, state, labels, milestone, assignees, updated_at,
         number, tag_name, doc_path, commit_sha, file_path, file_status,
         commit_date, commit_author, tokenizer_kind, content, indexed_at
       ) VALUES (?, ?, ?, 'open', '', '', '', '2026-01-01T00:00:00Z',
                 0, '', '', '', '', '', '', '', ?, ?, '2026-01-01T00:00:00Z')
       ON CONFLICT (vector_id) DO UPDATE SET content = excluded.content`,
    )
    .bind(
      row.vectorId,
      row.repo,
      row.type,
      tokenizerKindForType(row.type),
      row.content,
    )
    .run();
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
  it("backfills healthy current-generation indexes without reading the corrupt v1 indexes", async () => {
    const baseMigration = env.TEST_MIGRATIONS.find((m) => m.name === "0001_fts5_init.sql");
    const repairMigration = env.TEST_MIGRATIONS.find(
      (m) => m.name === "0005_fts5_tokenizer_isolation.sql",
    );
    const segmentMigration = env.TEST_MIGRATIONS.find(
      (m) => m.name === "0006_fts5_segmented_nat_index.sql",
    );
    expect(baseMigration).toBeDefined();
    expect(repairMigration).toBeDefined();
    expect(segmentMigration).toBeDefined();

    await applyD1Migrations(env.DB_FTS_MIGRATION, [baseMigration!]);

    const repo = "t/v1-recovery";
    const natId = "i:v1-recovery";
    const codeId = "c:v1-recovery";
    // Pre-0006 shape: `content_fts` does not exist on this database yet.
    await insertLegacyRow(env.DB_FTS_MIGRATION, {
      vectorId: codeId,
      type: "diff",
      repo,
      content: "persistentCodeSentinel",
    });
    await insertLegacyRow(env.DB_FTS_MIGRATION, {
      vectorId: natId,
      type: "issue",
      repo,
      content: "original natural sentinel",
    });

    // The v1 UPDATE trigger sends a delete command to code_fts even though this
    // nat row was never indexed there. D1 rejects the write as a corrupt-vtab
    // operation; sparse mirroring can therefore never reconcile this row.
    await expect(
      insertLegacyRow(env.DB_FTS_MIGRATION, {
        vectorId: natId,
        type: "issue",
        repo,
        content: "updated natural sentinel",
      }),
    ).rejects.toThrow(/SQLITE_CORRUPT_VTAB/);

    await applyD1Migrations(env.DB_FTS_MIGRATION, [repairMigration!, segmentMigration!]);

    await env.DB_FTS_MIGRATION
      .prepare(
        "INSERT INTO search_docs_nat_fts_v3(search_docs_nat_fts_v3, rank) VALUES('integrity-check', 1)",
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

describe("fts D1: Japanese natural-language queries (#180 fact 1)", () => {
  const JA_DOC =
    "判断の記録は状態形式で書く。supersede / depend / conflict のエッジを宣言する。";

  it("returns sparse candidates for the #180 reproduction phrase", async () => {
    const repo = "t/ja-phrase";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: "d:ja-phrase", type: "wiki_doc", repo, content: JA_DOC }),
    );
    const hits = await queryFts(env.DB_FTS, "判断の記録は状態形式で書く", 10, { repo });
    expect(hits.map((h) => h.vectorId)).toContain("d:ja-phrase");
  });

  it("tolerates punctuation in the query (token-less phrases)", async () => {
    // Segmentation emits punctuation as its own segment, so the MATCH string ends up
    // containing phrases that tokenize to nothing under unicode61. FTS5 must ignore
    // them rather than error out or drop the whole match.
    const repo = "t/ja-punct";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: "d:ja-punct", type: "wiki_doc", repo, content: JA_DOC }),
    );
    expect(
      (await queryFts(env.DB_FTS, "判断の記録は状態形式で書く。", 10, { repo }))
        .map((h) => h.vectorId),
    ).toContain("d:ja-punct");
    expect(await queryFts(env.DB_FTS, "。", 10, { repo })).toEqual([]);
  });

  it("still matches a single Japanese word", async () => {
    const repo = "t/ja-word";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: "d:ja-word", type: "wiki_doc", repo, content: JA_DOC }),
    );
    expect((await queryFts(env.DB_FTS, "判断", 10, { repo })).map((h) => h.vectorId))
      .toContain("d:ja-word");
  });

  it("does not match an unrelated Japanese phrase", async () => {
    const repo = "t/ja-nomatch";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: "d:ja-nomatch", type: "wiki_doc", repo, content: JA_DOC }),
    );
    expect(await queryFts(env.DB_FTS, "気象衛星の打ち上げ", 10, { repo })).toEqual([]);
  });

  it("returns the RAW content, not the segmented form (reranker input)", async () => {
    const repo = "t/ja-raw-content";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: "d:ja-raw", type: "wiki_doc", repo, content: JA_DOC }),
    );
    const hits = await queryFts(env.DB_FTS, "判断", 10, { repo });
    expect(hits[0].content).toBe(JA_DOC);
  });

  it("matches an English term inside a mixed-language document", async () => {
    // The doc is segmented (it contains Japanese) but the query is not, so this
    // pins the asymmetric case: ASCII words must survive segmentation whole.
    const repo = "t/ja-mixed";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({
        vectorId: "d:ja-mixed",
        type: "wiki_doc",
        repo,
        content: "この issue は reranker の precision について記述する",
      }),
    );
    expect((await queryFts(env.DB_FTS, "reranker", 10, { repo })).map((h) => h.vectorId))
      .toContain("d:ja-mixed");
    expect(
      (await queryFts(env.DB_FTS, "reranker の precision", 10, { repo })).map((h) => h.vectorId),
    ).toContain("d:ja-mixed");
  });

  it("keeps English phrase matching intact (no regression)", async () => {
    const repo = "t/en-phrase";
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({
        vectorId: "d:en-phrase",
        type: "wiki_doc",
        repo,
        content: "decision structure write skill: the writer-side surface of judgment learning",
      }),
    );
    expect(
      (await queryFts(env.DB_FTS, "decision structure write skill", 10, { repo }))
        .map((h) => h.vectorId),
    ).toContain("d:en-phrase");
  });

  it("survives index -> update -> delete without corrupting the nat index", async () => {
    // The isolation guarantee of migration 0005, re-asserted for the v3 generation:
    // the delete command must replay the exact segmented text that was indexed.
    const repo = "t/ja-lifecycle";
    const id = "d:ja-lifecycle";
    const survivor = "d:ja-lifecycle-survivor";

    await upsertFtsRow(env.DB_FTS, mkRow({ vectorId: id, type: "wiki_doc", repo, content: JA_DOC }));
    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: survivor, type: "wiki_doc", repo, content: "観測の記録は別の面にある" }),
    );

    await upsertFtsRow(
      env.DB_FTS,
      mkRow({ vectorId: id, type: "wiki_doc", repo, content: "判断の記録は破棄された" }),
    );
    expect(await queryFts(env.DB_FTS, "状態形式", 10, { repo })).toEqual([]); // stale gone
    expect((await queryFts(env.DB_FTS, "破棄", 10, { repo })).map((h) => h.vectorId)).toContain(id);

    await deleteFtsRow(env.DB_FTS, id);
    expect(await queryFts(env.DB_FTS, "破棄", 10, { repo })).toEqual([]);
    expect((await queryFts(env.DB_FTS, "観測", 10, { repo })).map((h) => h.vectorId))
      .toContain(survivor);

    await env.DB_FTS
      .prepare(
        "INSERT INTO search_docs_nat_fts_v3(search_docs_nat_fts_v3, rank) VALUES('integrity-check', 1)",
      )
      .run();
  });
});

describe("fts D1: backfillNatSegments", () => {
  it("re-segments migration-seeded rows in batches, resumably and idempotently", async () => {
    const repo = "t/backfill";
    const contents = [
      "判断の記録は状態形式で書く",
      "観測は昇格の前段にすぎない",
      "plain english row stays untouched",
    ];
    for (let i = 0; i < contents.length; i++) {
      await upsertFtsRow(
        env.DB_FTS,
        mkRow({ vectorId: `d:backfill-${i}`, type: "wiki_doc", repo, content: contents[i] }),
      );
    }

    // Reproduce the state migration 0006 leaves behind: content_fts is a verbatim
    // copy of the raw content, so Japanese is still one un-splittable token.
    await env.DB_FTS
      .prepare("UPDATE search_docs SET content_fts = content WHERE repo = ?")
      .bind(repo)
      .run();
    expect(await queryFts(env.DB_FTS, "判断の記録は状態形式で書く", 10, { repo })).toEqual([]);

    // Batch size 1 so the cursor has to advance several times.
    let cursor = 0;
    let rounds = 0;
    let updated = 0;
    for (;;) {
      const r = await backfillNatSegments(env.DB_FTS, { limit: 1, cursor, repo });
      rounds++;
      updated += r.updated;
      if (r.nextCursor === null) break;
      cursor = r.nextCursor;
      expect(rounds).toBeLessThan(10); // cursor must advance, never spin
    }
    expect(rounds).toBeGreaterThan(1);
    expect(updated).toBe(2); // the two Japanese rows; the English row is already correct

    expect(
      (await queryFts(env.DB_FTS, "判断の記録は状態形式で書く", 10, { repo }))
        .map((h) => h.vectorId),
    ).toContain("d:backfill-0");
    expect((await queryFts(env.DB_FTS, "english", 10, { repo })).map((h) => h.vectorId))
      .toContain("d:backfill-2");

    // Re-running from scratch (the interrupted-and-restarted case) writes nothing.
    const rerun = await backfillNatSegments(env.DB_FTS, { limit: 100, cursor: 0, repo });
    expect(rerun.scanned).toBe(3);
    expect(rerun.updated).toBe(0);
    expect(rerun.nextCursor).toBeNull();

    // Deleting after a backfill must still replay the exact indexed text.
    await deleteFtsRow(env.DB_FTS, "d:backfill-0");
    await env.DB_FTS
      .prepare(
        "INSERT INTO search_docs_nat_fts_v3(search_docs_nat_fts_v3, rank) VALUES('integrity-check', 1)",
      )
      .run();
  });

  it("reports an exhausted scan on an empty range", async () => {
    const r = await backfillNatSegments(env.DB_FTS, { limit: 10, repo: "t/backfill-absent" });
    expect(r).toEqual({ scanned: 0, updated: 0, nextCursor: null });
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
