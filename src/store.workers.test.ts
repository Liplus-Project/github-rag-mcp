import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { IssueStore } from "./store.js";
import type { DiffRecord, IssueRecord } from "./types.js";

// Each test uses a uniquely-named DO instance for storage isolation. IssueStore
// self-initializes its schema in the constructor (idempotent CREATE TABLE IF NOT
// EXISTS), so no migration step is needed.
function instanceFor(name: string) {
  return env.ISSUE_STORE.get(env.ISSUE_STORE.idFromName(name));
}

const issue = (
  over: Partial<IssueRecord> & Pick<IssueRecord, "repo" | "number">,
): IssueRecord => ({
  type: "issue",
  state: "open",
  title: "title",
  labels: [],
  milestone: "",
  assignees: [],
  bodyHash: "h",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  ...over,
});

describe("IssueStore: issue CRUD", () => {
  it("round-trips an issue record (including label / assignee arrays)", async () => {
    await runInDurableObject(instanceFor("issue-roundtrip"), (s: IssueStore) => {
      const rec = issue({
        repo: "o/r",
        number: 7,
        type: "pull_request",
        state: "open",
        title: "Add retry",
        labels: ["bug", "p1"],
        milestone: "v1",
        assignees: ["alice", "bob"],
        bodyHash: "abc",
      });
      s.upsertIssue(rec);
      expect(s.getIssue("o/r", 7)).toEqual(rec);
    });
  });

  it("returns null for a missing issue", async () => {
    await runInDurableObject(instanceFor("issue-missing"), (s: IssueStore) => {
      expect(s.getIssue("o/r", 999)).toBeNull();
    });
  });

  it("upserts idempotently on (repo, number): second write updates, not duplicates", async () => {
    await runInDurableObject(instanceFor("issue-idem"), (s: IssueStore) => {
      s.upsertIssue(issue({ repo: "o/r", number: 1, state: "open", title: "first" }));
      s.upsertIssue(
        issue({ repo: "o/r", number: 1, state: "closed", title: "second", updatedAt: "2026-02-01T00:00:00Z" }),
      );
      const got = s.getIssue("o/r", 1);
      expect(got?.state).toBe("closed");
      expect(got?.title).toBe("second");
      expect(s.listIssuesByRepo("o/r")).toHaveLength(1);
    });
  });

  it("lists by repo with a state filter, newest first, honoring limit", async () => {
    await runInDurableObject(instanceFor("issue-list"), (s: IssueStore) => {
      s.upsertIssue(issue({ repo: "o/r", number: 1, state: "open", updatedAt: "2026-01-01T00:00:00Z" }));
      s.upsertIssue(issue({ repo: "o/r", number: 2, state: "closed", updatedAt: "2026-01-02T00:00:00Z" }));
      s.upsertIssue(issue({ repo: "o/r", number: 3, state: "open", updatedAt: "2026-01-03T00:00:00Z" }));
      s.upsertIssue(issue({ repo: "other/repo", number: 9, state: "open" }));

      expect(s.listIssuesByRepo("o/r").map((i) => i.number)).toEqual([3, 2, 1]); // updated_at DESC
      expect(s.listIssuesByRepo("o/r", { state: "open" }).map((i) => i.number)).toEqual([3, 1]);
      expect(s.listIssuesByRepo("o/r", { limit: 1 }).map((i) => i.number)).toEqual([3]);
    });
  });
});

describe("IssueStore: recency window (#194)", () => {
  // The store returns the newest `limit` rows *inside* [since, until). Before
  // #194 `until` was not part of the query, so a caller filtering it afterwards
  // over a recency-capped candidate set could never see an old window.
  const diff = (commitDate: string, sha: string): DiffRecord => ({
    repo: "o/r",
    commitSha: sha,
    filePath: `f/${sha}.ts`,
    fileStatus: "modified",
    commitDate,
    commitAuthor: "someone",
    blobShaBefore: null,
    blobShaAfter: null,
    indexedAt: commitDate,
  });

  // 120 rows newer than the target window, plus 2 rows inside it. Any
  // fetch-then-filter shape returns zero here: the cap is 100.
  function seed(s: IssueStore): void {
    for (let i = 0; i < 120; i++) {
      const day = String(10 + Math.floor(i / 24)).padStart(2, "0");
      const hour = String(i % 24).padStart(2, "0");
      s.upsertDiff(diff(`2026-07-${day}T${hour}:00:00Z`, `new${i}`));
    }
    s.upsertDiff(diff("2026-02-03T00:00:00Z", "old1"));
    s.upsertDiff(diff("2026-02-04T00:00:00Z", "old2"));
  }

  it("reaches a window older than the newest `limit` rows", async () => {
    await runInDurableObject(instanceFor("window-old"), (s: IssueStore) => {
      seed(s);
      const got = s.getRecentDiffs({
        repo: "o/r",
        since: "2026-01-01T00:00:00Z",
        until: "2026-03-01T00:00:00Z",
        limit: 100,
      });
      expect(got.map((d) => d.commitSha)).toEqual(["old2", "old1"]);
    });
  });

  it("treats the window as half-open: since inclusive, until exclusive", async () => {
    await runInDurableObject(instanceFor("window-bounds"), (s: IssueStore) => {
      seed(s);
      const got = s.getRecentDiffs({
        repo: "o/r",
        since: "2026-02-03T00:00:00Z",
        until: "2026-02-04T00:00:00Z",
        limit: 100,
      });
      expect(got.map((d) => d.commitSha)).toEqual(["old1"]);
    });
  });

  it("caps inside the window, newest first, when the window overflows", async () => {
    await runInDurableObject(instanceFor("window-cap"), (s: IssueStore) => {
      seed(s);
      const got = s.getRecentDiffs({
        repo: "o/r",
        since: "2026-07-10T00:00:00Z",
        until: "2026-07-10T05:00:00Z",
        limit: 3,
      });
      expect(got.map((d) => d.commitDate)).toEqual([
        "2026-07-10T04:00:00Z",
        "2026-07-10T03:00:00Z",
        "2026-07-10T02:00:00Z",
      ]);
    });
  });

  it("keeps the repo filter and the window independent", async () => {
    await runInDurableObject(instanceFor("window-repo"), (s: IssueStore) => {
      seed(s);
      s.upsertDiff({ ...diff("2026-02-03T12:00:00Z", "other"), repo: "other/repo" });
      const scoped = s.getRecentDiffs({
        repo: "o/r",
        since: "2026-02-01T00:00:00Z",
        until: "2026-03-01T00:00:00Z",
        limit: 100,
      });
      expect(scoped.map((d) => d.commitSha)).toEqual(["old2", "old1"]);

      const unscoped = s.getRecentDiffs({
        since: "2026-02-01T00:00:00Z",
        until: "2026-03-01T00:00:00Z",
        limit: 100,
      });
      expect(unscoped.map((d) => d.commitSha)).toEqual(["old2", "other", "old1"]);
    });
  });

  it("passes `until` through the /recent-diffs endpoint", async () => {
    const stub = instanceFor("window-endpoint");
    await runInDurableObject(stub, (s: IssueStore) => seed(s));
    const res = await stub.fetch(
      new Request(
        "http://store/recent-diffs?repo=o%2Fr&since=2026-01-01T00:00:00Z" +
          "&until=2026-03-01T00:00:00Z&limit=100",
      ),
    );
    expect(res.ok).toBe(true);
    const rows = (await res.json()) as DiffRecord[];
    expect(rows.map((d) => d.commitSha)).toEqual(["old2", "old1"]);
  });

  it("omitting `until` still means up to now", async () => {
    await runInDurableObject(instanceFor("window-open-end"), (s: IssueStore) => {
      seed(s);
      const got = s.getRecentDiffs({
        repo: "o/r",
        since: "2026-01-01T00:00:00Z",
        limit: 200,
      });
      expect(got).toHaveLength(122);
      expect(got[0].commitDate).toBe("2026-07-14T23:00:00Z");
    });
  });

  it("windows the other surfaces on their own timestamp column", async () => {
    await runInDurableObject(instanceFor("window-surfaces"), (s: IssueStore) => {
      s.upsertIssue(issue({ repo: "o/r", number: 1, updatedAt: "2026-02-01T00:00:00Z" }));
      s.upsertIssue(issue({ repo: "o/r", number: 2, updatedAt: "2026-07-01T00:00:00Z" }));
      s.upsertRelease({
        repo: "o/r",
        tagName: "v1",
        name: "v1",
        body: "",
        prerelease: false,
        bodyHash: "h",
        createdAt: "2026-02-01T00:00:00Z",
        publishedAt: "2026-02-02T00:00:00Z",
      });
      s.upsertRelease({
        repo: "o/r",
        tagName: "v2",
        name: "v2",
        body: "",
        prerelease: false,
        bodyHash: "h",
        createdAt: "2026-07-01T00:00:00Z",
        publishedAt: "2026-07-02T00:00:00Z",
      });
      s.upsertDoc({
        repo: "o/r",
        path: "docs/a.md",
        blobSha: "b",
        updatedAt: "2026-02-05T00:00:00Z",
      });
      s.upsertWikiDoc({
        repo: "o/r",
        pageName: "Home",
        extension: "md",
        contentHash: "h",
        updatedAt: "2026-02-06T00:00:00Z",
      });
      s.upsertIssueComment({
        repo: "o/r",
        commentId: 11,
        number: 1,
        author: "a",
        bodyHash: "h",
        createdAt: "2026-02-07T00:00:00Z",
        updatedAt: "2026-02-07T00:00:00Z",
      });
      s.upsertPRReview({
        repo: "o/r",
        reviewId: 21,
        number: 1,
        author: "a",
        state: "approved",
        bodyHash: "h",
        submittedAt: "2026-02-08T00:00:00Z",
        updatedAt: "2026-02-08T00:00:00Z",
      });
      s.upsertPRReviewComment({
        repo: "o/r",
        commentId: 31,
        number: 1,
        author: "a",
        filePath: "src/a.ts",
        line: 3,
        commitId: "sha",
        bodyHash: "h",
        createdAt: "2026-02-09T00:00:00Z",
        updatedAt: "2026-02-09T00:00:00Z",
      });

      const window = { repo: "o/r", since: "2026-01-01T00:00:00Z", until: "2026-03-01T00:00:00Z" };
      expect(s.getRecentActivity(window).map((i) => i.number)).toEqual([1]);
      expect(s.getRecentReleases(window).map((r) => r.tagName)).toEqual(["v1"]);
      expect(s.getRecentDocs(window)).toHaveLength(1);
      expect(s.getRecentWikiDocs(window)).toHaveLength(1);
      expect(s.getRecentIssueComments(window)).toHaveLength(1);
      expect(s.getRecentPRReviews(window)).toHaveLength(1);
      expect(s.getRecentPRReviewComments(window)).toHaveLength(1);
    });
  });
});

describe("IssueStore: poll watermark", () => {
  it("returns null before any watermark is set", async () => {
    await runInDurableObject(instanceFor("wm-null"), (s: IssueStore) => {
      expect(s.getWatermark("o/r")).toBeNull();
    });
  });

  it("round-trips a watermark and normalizes an empty etag to undefined", async () => {
    await runInDurableObject(instanceFor("wm-roundtrip"), (s: IssueStore) => {
      s.setWatermark("o/r", "2026-01-01T00:00:00Z", "etag-123");
      expect(s.getWatermark("o/r")).toEqual({
        repo: "o/r",
        lastPolledAt: "2026-01-01T00:00:00Z",
        etag: "etag-123",
      });

      // No etag -> stored as "" -> read back as undefined.
      s.setWatermark("o/r", "2026-02-01T00:00:00Z");
      expect(s.getWatermark("o/r")).toEqual({
        repo: "o/r",
        lastPolledAt: "2026-02-01T00:00:00Z",
        etag: undefined,
      });
    });
  });
});
