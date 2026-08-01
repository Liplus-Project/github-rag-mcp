import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { IssueStore } from "./store.js";
import type { DiffRecord } from "./types.js";
import { runScan } from "./scan.js";

/**
 * Scan mode against a real IssueStore (#194).
 *
 * The fixture mirrors the shape that broke in production: a repo whose diff
 * rows run from January to the end of July, with a dense tail at the newest
 * end. Any implementation that fetches the newest `limit` rows and *then*
 * applies `until` returns zero for every window below that tail, however many
 * rows the window holds. The three windows measured on the live index
 * (Liplus-Project/liplus-language, type=diff) are pinned here.
 */

const REPO = "o/liplus-language";

function diff(commitDate: string, sha: string, file: string): DiffRecord {
  return {
    repo: REPO,
    commitSha: sha,
    filePath: file,
    fileStatus: "modified",
    commitDate,
    commitAuthor: "someone",
    blobShaBefore: null,
    blobShaAfter: null,
    indexedAt: commitDate,
  };
}

/**
 * 150 rows in the newest tail (2026-07-30) — more than the 100-row per-endpoint
 * cap on their own — plus the rows the issue names by SHA, plus one row per
 * month for the long window.
 */
function seed(s: IssueStore): void {
  for (let i = 0; i < 150; i++) {
    const hour = String(i % 24).padStart(2, "0");
    const minute = String(Math.floor(i / 24) * 10).padStart(2, "0");
    s.upsertDiff(diff(`2026-07-30T${hour}:${minute}:00Z`, `tail${i}`, `tail/${i}.md`));
  }

  // Inside 2026-07-08 .. 2026-07-22: one file on 9044cb6, three on ae78c99.
  s.upsertDiff(diff("2026-07-15T02:00:00Z", "9044cb6", "rules/a.md"));
  for (const file of ["rules/b.md", "rules/c.md", "docs/d.md"]) {
    s.upsertDiff(diff("2026-07-19T09:30:00Z", "ae78c99", file));
  }

  // Inside 2026-07-29T00:00 .. 12:00: exactly four rows.
  for (let i = 0; i < 4; i++) {
    s.upsertDiff(diff(`2026-07-29T0${i}:15:00Z`, `mid${i}`, `mid/${i}.md`));
  }

  // One row a month, 2026-01-22 .. 2026-06-22, for the long window.
  for (let m = 1; m <= 6; m++) {
    const month = String(m).padStart(2, "0");
    s.upsertDiff(diff(`2026-${month}-22T00:00:00Z`, `m${month}`, `hist/${month}.md`));
  }
}

async function seeded(name: string) {
  const stub = env.ISSUE_STORE.get(env.ISSUE_STORE.idFromName(name));
  await runInDurableObject(stub, (s: IssueStore) => seed(s));
  return stub;
}

describe("scan mode: since/until window (#194)", () => {
  it("reaches a wide old window (was: 0 results, index held 1,200+ rows)", async () => {
    const store = await seeded("scan-wide-old");
    const out = await runScan(store, {
      repo: REPO,
      type: "diff",
      topK: 10,
      sort: "updated_desc",
      since: "2026-01-01T00:00:00Z",
      until: "2026-07-28T00:00:00Z",
    });

    expect(out.rows.length).toBe(10);
    for (const row of out.rows) {
      expect(row.updated_at >= "2026-01-01T00:00:00Z").toBe(true);
      expect(row.updated_at < "2026-07-28T00:00:00Z").toBe(true);
    }
    // Newest first, and the newest row in the window is the ae78c99 batch.
    expect(out.rows[0].commit_sha).toBe("ae78c99");
    // The window holds 10 rows total; a full page is not proof of more, but
    // this window holds exactly topK, so nothing is withheld.
    expect(out.truncated).toBe(false);
  });

  it("reaches a narrow old window and returns exactly its rows", async () => {
    const store = await seeded("scan-narrow-old");
    const out = await runScan(store, {
      repo: REPO,
      type: "diff",
      topK: 10,
      sort: "updated_desc",
      since: "2026-07-08T00:00:00Z",
      until: "2026-07-22T00:00:00Z",
    });

    expect(out.rows.map((r) => r.commit_sha)).toEqual([
      "ae78c99",
      "ae78c99",
      "ae78c99",
      "9044cb6",
    ]);
    expect(out.truncated).toBe(false);
  });

  it("keeps the newest-side window working (the case that never broke)", async () => {
    const store = await seeded("scan-recent");
    const out = await runScan(store, {
      repo: REPO,
      type: "diff",
      topK: 10,
      sort: "updated_desc",
      since: "2026-07-29T00:00:00Z",
      until: "2026-07-29T12:00:00Z",
    });

    expect(out.rows).toHaveLength(4);
    expect(out.rows.map((r) => r.commit_sha)).toEqual(["mid3", "mid2", "mid1", "mid0"]);
    expect(out.truncated).toBe(false);
  });
});

describe("scan mode: truncation is distinguishable from an empty window (#194)", () => {
  it("flags truncated when the store cap ends the read", async () => {
    const store = await seeded("scan-truncated-cap");
    const out = await runScan(store, {
      repo: REPO,
      type: "diff",
      topK: 20, // storeLimit = 100, and the tail alone holds 150 rows
      sort: "updated_desc",
      since: "2026-01-01T00:00:00Z",
      until: "2026-08-01T00:00:00Z",
    });

    expect(out.rows).toHaveLength(20);
    expect(out.truncated).toBe(true);
  });

  it("flags truncated when the merged set is longer than the page", async () => {
    const store = await seeded("scan-truncated-page");
    const out = await runScan(store, {
      repo: REPO,
      type: "diff",
      topK: 3,
      sort: "updated_desc",
      since: "2026-01-01T00:00:00Z",
      until: "2026-07-28T00:00:00Z",
    });

    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it("reports an empty window as not truncated", async () => {
    const store = await seeded("scan-empty-window");
    const out = await runScan(store, {
      repo: REPO,
      type: "diff",
      topK: 10,
      sort: "updated_desc",
      since: "2026-03-01T00:00:00Z",
      until: "2026-03-20T00:00:00Z",
    });

    expect(out.rows).toHaveLength(0);
    expect(out.truncated).toBe(false);
  });

  it("walks backwards page by page using the oldest row returned", async () => {
    const store = await seeded("scan-walk-back");
    const window = {
      repo: REPO,
      type: "diff" as const,
      topK: 4,
      sort: "updated_desc" as const,
      since: "2026-01-01T00:00:00Z",
    };

    const first = await runScan(store, { ...window, until: "2026-07-28T00:00:00Z" });
    expect(first.truncated).toBe(true);

    const second = await runScan(store, {
      ...window,
      until: first.rows[first.rows.length - 1].updated_at,
    });
    // The walk moves strictly backwards and does not repeat the boundary row.
    expect(second.rows[0].updated_at < first.rows[first.rows.length - 1].updated_at).toBe(true);
    expect(second.rows.map((r) => r.commit_sha)).toEqual(["m06", "m05", "m04", "m03"]);
  });
});

describe("scan mode: default window", () => {
  it("anchors the default `since` to `until` when only `until` is given", async () => {
    const store = await seeded("scan-default-since");
    const out = await runScan(store, {
      repo: REPO,
      type: "diff",
      topK: 10,
      sort: "updated_desc",
      until: "2026-07-22T00:00:00Z",
    });

    // Default window = 7 days back from `until`, i.e. 2026-07-15 .. 2026-07-22.
    expect(out.since).toBe("2026-07-15T00:00:00.000Z");
    expect(out.rows.map((r) => r.commit_sha)).toEqual([
      "ae78c99",
      "ae78c99",
      "ae78c99",
      "9044cb6",
    ]);
  });
});
