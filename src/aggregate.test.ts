import { describe, it, expect } from "vitest";
import { entityKey, groupByEntity, type EntityRow } from "./aggregate.js";

/**
 * Binding-independent unit tests for entity aggregation (node pool).
 *
 * Focus = the issue #189 surface: `top_k` was being spent on several rows of
 * one referent, and the line that must hold while fixing it is referent ≠
 * event. Two files touched by one commit are two referents and must survive
 * as two results; a file's `doc` row and its `diff` rows are one referent and
 * collapse into one.
 */

function row(over: Partial<EntityRow> & Pick<EntityRow, "vectorId" | "type">): EntityRow {
  return { repo: "Liplus-Project/Li-plus", number: 0, ...over };
}

/** Rank-ordered pool → the entity keys of the surviving representatives. */
function keysAfterAggregation(rows: EntityRow[], topK: number): string[] {
  return groupByEntity(rows, entityKey)
    .slice(0, topK)
    .map((g) => g.key);
}

describe("entityKey: file class (doc + diff of the same file)", () => {
  it("gives a doc row and every diff row of that file one key", () => {
    const doc = row({ vectorId: "v-doc", type: "doc", docPath: "skills/x/SKILL.md" });
    const diffA = row({ vectorId: "v-a", type: "diff", filePath: "skills/x/SKILL.md" });
    const diffB = row({ vectorId: "v-b", type: "diff", filePath: "skills/x/SKILL.md" });

    expect(entityKey(doc)).toBe("file:Liplus-Project/Li-plus:skills/x/SKILL.md");
    expect(entityKey(diffA)).toBe(entityKey(doc));
    expect(entityKey(diffB)).toBe(entityKey(doc));
  });

  it("keeps two files touched by ONE commit as two entities (referent, not event)", () => {
    // The line the whole design rests on: folding by commit would hide a file
    // that is genuinely independent. The SHA is deliberately absent from the key.
    const fileA = row({ vectorId: "v-a", type: "diff", filePath: "rules/model/absolute.md" });
    const fileB = row({ vectorId: "v-b", type: "diff", filePath: "rules/task/task.md" });

    expect(entityKey(fileA)).not.toBe(entityKey(fileB));
    expect(keysAfterAggregation([fileA, fileB], 10)).toHaveLength(2);
  });

  it("keeps the same path in two different repos apart (cross-repo copies are out of scope)", () => {
    const upstream = row({ vectorId: "v-a", type: "doc", docPath: "skills/x/SKILL.md" });
    const copy = row({
      vectorId: "v-b",
      type: "doc",
      repo: "Liplus-Project/github-webhook-mcp",
      docPath: "skills/x/SKILL.md",
    });

    expect(entityKey(upstream)).not.toBe(entityKey(copy));
  });
});

describe("entityKey: thread class (issue / PR + its comments)", () => {
  it("gives an issue and its top-level comments one key", () => {
    const issue = row({ vectorId: "v-i", type: "issue", number: 1317 });
    const comment = row({ vectorId: "v-c", type: "issue_comment", number: 1317 });

    expect(entityKey(comment)).toBe(entityKey(issue));
    expect(entityKey(issue)).toBe("thread:Liplus-Project/Li-plus:1317");
  });

  it("gives a PR, its reviews and its inline review comments one key", () => {
    const pr = row({ vectorId: "v-p", type: "pull_request", number: 1318 });
    const review = row({ vectorId: "v-r", type: "pr_review", number: 1318 });
    const inline = row({
      vectorId: "v-rc",
      type: "pr_review_comment",
      number: 1318,
      filePath: "src/mcp.ts",
    });

    expect(entityKey(review)).toBe(entityKey(pr));
    expect(entityKey(inline)).toBe(entityKey(pr));
  });

  it("keeps an issue and the PR that closes it as two entities", () => {
    // One unit of work, two referents. The `Closes #N` link that would join
    // them is not in the index, so joining here would be a guess.
    const issue = row({ vectorId: "v-i", type: "issue", number: 1317 });
    const pr = row({ vectorId: "v-p", type: "pull_request", number: 1318 });

    expect(entityKey(issue)).not.toBe(entityKey(pr));
  });
});

describe("entityKey: rows that must never fold", () => {
  it("keeps wiki pages out of the file namespace", () => {
    const wiki = row({ vectorId: "v-w", type: "wiki_doc", docPath: "Decision-Structure" });
    const doc = row({ vectorId: "v-d", type: "doc", docPath: "Decision-Structure" });

    expect(entityKey(wiki)).toBe("row:v-w");
    expect(entityKey(wiki)).not.toBe(entityKey(doc));
  });

  it("falls back to the row identity when the keying field is missing", () => {
    const pathless = row({ vectorId: "v-a", type: "diff" });
    const numberless = row({ vectorId: "v-b", type: "issue" });
    const release = row({ vectorId: "v-c", type: "release" });

    expect(entityKey(pathless)).toBe("row:v-a");
    expect(entityKey(numberless)).toBe("row:v-b");
    expect(entityKey(release)).toBe("row:v-c");
  });
});

describe("groupByEntity", () => {
  it("keeps the highest-ranked row as representative and the rest as others", () => {
    const rows = [
      row({ vectorId: "v-1", type: "diff", filePath: "skills/x/SKILL.md" }),
      row({ vectorId: "v-2", type: "doc", docPath: "docs/other.md" }),
      row({ vectorId: "v-3", type: "doc", docPath: "skills/x/SKILL.md" }),
      row({ vectorId: "v-4", type: "diff", filePath: "skills/x/SKILL.md" }),
    ];

    const groups = groupByEntity(rows, entityKey);

    expect(groups).toHaveLength(2);
    expect(groups[0].representative.vectorId).toBe("v-1");
    expect(groups[0].others.map((o) => o.vectorId)).toEqual(["v-3", "v-4"]);
    expect(groups[1].representative.vectorId).toBe("v-2");
    expect(groups[1].others).toEqual([]);
  });

  it("does not pin the newest version — an older diff ranked top stays the answer", () => {
    // Negative control for "when did this change": the query ranks the old
    // diff first, so the collapse must not replace it with the live doc row.
    const oldDiff = row({ vectorId: "v-old-diff", type: "diff", filePath: "rules/model/absolute.md" });
    const liveDoc = row({ vectorId: "v-doc", type: "doc", docPath: "rules/model/absolute.md" });

    const groups = groupByEntity([oldDiff, liveDoc], entityKey);

    expect(groups).toHaveLength(1);
    expect(groups[0].representative.vectorId).toBe("v-old-diff");
    expect(groups[0].others.map((o) => o.vectorId)).toEqual(["v-doc"]);
  });

  it("preserves rank order of the representatives", () => {
    const rows = [
      row({ vectorId: "v-1", type: "issue", number: 10 }),
      row({ vectorId: "v-2", type: "issue", number: 20 }),
      row({ vectorId: "v-3", type: "issue_comment", number: 10 }),
      row({ vectorId: "v-4", type: "issue", number: 30 }),
    ];

    expect(groupByEntity(rows, entityKey).map((g) => g.representative.vectorId)).toEqual([
      "v-1",
      "v-2",
      "v-4",
    ]);
  });

  it("returns an empty array for an empty pool", () => {
    expect(groupByEntity([], entityKey)).toEqual([]);
  });
});

describe("duplicate rate regression (issue #189 measurements, 2026-08-01)", () => {
  /**
   * The two pools below reproduce the duplication actually observed on the
   * production index at `top_k: 10` (rrf + rerank). Before aggregation each
   * pool spent ~10 slots on ~6 independent things. The assertions fix both
   * directions: the known duplicates collapse, and the known non-duplicates
   * (same commit / issue+PR / cross-repo copy) do not.
   */

  it("`subagent への委譲はいつ必須になるのか`: doc + diff of one file collapse", () => {
    const repo = "Liplus-Project/Li-plus";
    const pool: EntityRow[] = [
      row({ vectorId: "d1", type: "doc", docPath: "skills/task-subagent-delegation/SKILL.md" }),
      // same file, commit 45deef8 — collapses into the doc row above
      row({ vectorId: "d2", type: "diff", filePath: "skills/task-subagent-delegation/SKILL.md" }),
      // different file of the SAME commit 45deef8 — stays independent
      row({ vectorId: "d3", type: "diff", filePath: "rules/task/task.md" }),
      // the github-webhook-mcp copy of the same source — stays independent (axis (c))
      row({
        vectorId: "d4",
        type: "doc",
        repo: "Liplus-Project/github-webhook-mcp",
        docPath: ".claude/skills/task-subagent-delegation/SKILL.md",
      }),
      row({ vectorId: "d5", type: "issue", number: 919, repo }),
      row({ vectorId: "d6", type: "doc", docPath: "rules/operations/operations.md", repo }),
      row({ vectorId: "d7", type: "wiki_doc", docPath: "Subagent-Delegation", repo }),
      row({ vectorId: "d8", type: "issue", number: 1180, repo }),
      row({ vectorId: "d9", type: "pull_request", number: 1181, repo }),
      row({ vectorId: "d10", type: "diff", filePath: "docs/G.-Sheepdog-Engineering.md", repo }),
      row({ vectorId: "d11", type: "release", repo }),
      row({ vectorId: "d12", type: "issue_comment", number: 1180, repo }),
    ];

    const groups = groupByEntity(pool, entityKey);

    // 12 rows → 10 entities: d1+d2 collapse, d8+d12 collapse.
    expect(groups).toHaveLength(10);
    expect(groups[0].others.map((o) => o.vectorId)).toEqual(["d2"]);

    const top10 = keysAfterAggregation(pool, 10);
    expect(top10).toHaveLength(10);
    expect(new Set(top10).size).toBe(10);
  });

  it("`wiki sync sidebar integrity check`: one file across two commits collapses", () => {
    const repo = "Liplus-Project/Li-plus";
    const pool: EntityRow[] = [
      // same commit afae460, two files — stays two entities
      row({ vectorId: "w1", type: "diff", filePath: "skills/operations-on-wiki-sync/SKILL.md", repo }),
      row({ vectorId: "w2", type: "diff", filePath: "scripts/wiki-sync.sh", repo }),
      // issue #1317 and PR #1318, one unit of work — stays two entities
      row({ vectorId: "w3", type: "issue", number: 1317, repo }),
      row({ vectorId: "w4", type: "pull_request", number: 1318, repo }),
      // docs/Decision-Structure.md in two different commits — collapses
      row({ vectorId: "w5", type: "diff", filePath: "docs/Decision-Structure.md", repo }),
      row({ vectorId: "w6", type: "diff", filePath: "docs/Decision-Structure.md", repo }),
      row({ vectorId: "w7", type: "doc", docPath: "docs/Decision-Structure.md", repo }),
      row({ vectorId: "w8", type: "wiki_doc", docPath: "Wiki-Sync", repo }),
      row({ vectorId: "w9", type: "pr_review", number: 1318, repo }),
      row({ vectorId: "w10", type: "issue", number: 1290, repo }),
      row({ vectorId: "w11", type: "doc", docPath: "docs/4.-Operations.md", repo }),
      row({ vectorId: "w12", type: "diff", filePath: "docs/4.-Operations.md", repo }),
    ];

    const groups = groupByEntity(pool, entityKey);
    const keys = groups.map((g) => g.key);

    // 12 rows → 8 entities: w5+w6+w7 collapse, w4+w9 collapse, w11+w12 collapse.
    expect(groups).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);

    const decisionStructure = groups.find(
      (g) => g.key === `file:${repo}:docs/Decision-Structure.md`,
    );
    expect(decisionStructure?.representative.vectorId).toBe("w5");
    expect(decisionStructure?.others.map((o) => o.vectorId)).toEqual(["w6", "w7"]);

    // Negative controls: the pairs that must NOT be one entity.
    expect(entityKey(pool[0])).not.toBe(entityKey(pool[1])); // one commit, two files
    expect(entityKey(pool[2])).not.toBe(entityKey(pool[3])); // issue #1317 vs PR #1318
  });
});
