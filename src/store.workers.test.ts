import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { IssueStore } from "./store.js";
import type { IssueRecord } from "./types.js";

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
