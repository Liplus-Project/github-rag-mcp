import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "./types.js";

// `pollDiffs` fans out to the commit-diff pipeline (GitHub detail fetch + Workers
// AI embed + Vectorize + D1 + Store DO). The watermark contract under test is
// upstream of all of that, so the two pipeline entry points are replaced with
// controllable fakes and only the *commit list* call reaches the stubbed global
// fetch. Everything else in `./pipeline.js` stays real.
const { fetchCommitDetailMock, processAndUpsertCommitDiffMock } = vi.hoisted(() => ({
  fetchCommitDetailMock: vi.fn(),
  processAndUpsertCommitDiffMock: vi.fn(),
}));

vi.mock("./pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pipeline.js")>();
  return {
    ...actual,
    fetchCommitDetail: fetchCommitDetailMock,
    processAndUpsertCommitDiff: processAndUpsertCommitDiffMock,
  };
});

const {
  pollDiffs,
  nextForwardDiffWatermark,
  nextBackfillDiffWatermark,
} = await import("./poller.js");

const REPO = "acme/widgets";
const FORWARD_KEY = `diffs:${REPO}`;
const BACKFILL_KEY = `diffs_backfill:${REPO}`;

/** A commit as the GitHub list endpoint returns it (subset the poller reads). */
interface FakeCommit {
  sha: string;
  date: string;
}

const commit = (sha: string, date: string): FakeCommit => ({ sha, date });

/**
 * In-memory stand-in for the IssueStore Durable Object stub: implements the
 * `/watermark` GET + POST surface the diff poller uses, backed by a Map the
 * test can read and seed.
 */
function makeStore(seed: Record<string, string> = {}) {
  const watermarks = new Map<string, string>(Object.entries(seed));
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/watermark") {
        const key = url.searchParams.get("repo") ?? "";
        const value = watermarks.get(key);
        if (!value) return new Response("not found", { status: 404 });
        return Response.json({ repo: key, lastPolledAt: value });
      }
      if (request.method === "POST" && url.pathname === "/watermark") {
        const body = (await request.json()) as { repo: string; lastPolledAt: string };
        watermarks.set(body.repo, body.lastPolledAt);
        return new Response("ok");
      }
      return new Response("ok");
    },
  };
  return { stub: stub as unknown as DurableObjectStub, watermarks };
}

/**
 * Stub the global fetch with a fake GitHub commit-list endpoint over `commits`.
 *
 * Mirrors the real contract the poller depends on: `since` / `until` filter by
 * commit date, results come back newest-first, and `per_page` truncates the
 * *newest* end — which is precisely why the poller has to enumerate a window
 * before it may advance a watermark.
 */
function stubCommitList(commits: FakeCommit[], opts: { fail?: boolean } = {}) {
  const listQueries: Array<{ since?: string; until?: string; per_page: number }> = [];

  const fetchMock = vi.fn(async (input: string | URL) => {
    if (opts.fail) throw new Error("simulated GitHub list outage");
    const url = new URL(String(input));
    const since = url.searchParams.get("since") ?? undefined;
    const until = url.searchParams.get("until") ?? undefined;
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    listQueries.push({ since, until, per_page: perPage });

    const selected = commits
      .filter((c) => (since ? Date.parse(c.date) > Date.parse(since) : true))
      .filter((c) => (until ? Date.parse(c.date) <= Date.parse(until) : true))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, perPage)
      .map((c) => ({ sha: c.sha, commit: { author: { date: c.date } } }));

    return new Response(JSON.stringify(selected), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { listQueries };
}

const env = { GITHUB_TOKEN: "test-token" } as unknown as Env;

/** SHAs handed to the detail fetch, i.e. the commits a run actually attempted. */
const attemptedShas = (): string[] =>
  fetchCommitDetailMock.mock.calls.map((call) => String(call[1]));

beforeEach(() => {
  fetchCommitDetailMock.mockReset();
  processAndUpsertCommitDiffMock.mockReset();
  // Default: every commit ingests cleanly.
  fetchCommitDetailMock.mockImplementation(async (_repo: string, sha: string) => ({
    sha,
    commit: { message: "m" },
    files: [],
  }));
  processAndUpsertCommitDiffMock.mockResolvedValue({
    embedded: 1,
    skipped: 0,
    failed: 0,
    batches: 1,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("poller: nextForwardDiffWatermark", () => {
  const since = "2026-07-01T00:00:00.000Z";
  const windowEnd = "2026-07-02T00:00:00.000Z";

  it("advances to the window end when every commit in the window ingested", () => {
    const next = nextForwardDiffWatermark(since, windowEnd, [
      { sha: "a", date: "2026-07-01T01:00:00.000Z", status: "ok" },
      { sha: "b", date: "2026-07-01T02:00:00.000Z", status: "ok" },
    ]);
    expect(next).toBe(windowEnd);
  });

  it("stops just before the first failed commit", () => {
    const next = nextForwardDiffWatermark(since, windowEnd, [
      { sha: "a", date: "2026-07-01T01:00:00.000Z", status: "ok" },
      { sha: "b", date: "2026-07-01T02:00:00.000Z", status: "failed" },
      { sha: "c", date: "2026-07-01T03:00:00.000Z", status: "ok" },
    ]);
    // One second of margin so GitHub's exclusive `since` still re-includes `b`.
    expect(next).toBe("2026-07-01T01:59:59.000Z");
  });

  it("stops just before the first deferred (over-cap) commit", () => {
    const next = nextForwardDiffWatermark(since, windowEnd, [
      { sha: "a", date: "2026-07-01T01:00:00.000Z", status: "ok" },
      { sha: "b", date: "2026-07-01T02:00:00.000Z", status: "deferred" },
    ]);
    expect(next).toBe("2026-07-01T01:59:59.000Z");
  });

  it("never regresses below the watermark it started from", () => {
    const next = nextForwardDiffWatermark(since, windowEnd, [
      { sha: "a", date: since, status: "failed" },
    ]);
    expect(next).toBe(since);
  });

  it("holds the watermark when the boundary commit carries no usable date", () => {
    expect(
      nextForwardDiffWatermark(since, windowEnd, [{ sha: "a", status: "failed" }]),
    ).toBe(since);
    expect(
      nextForwardDiffWatermark(since, windowEnd, [
        { sha: "a", date: "not-a-date", status: "failed" },
      ]),
    ).toBe(since);
  });
});

describe("poller: nextBackfillDiffWatermark", () => {
  const current = "2026-07-02T00:00:00.000Z";

  it("advances to the oldest commit of a fully ingested page", () => {
    // Backward phase walks newest-first.
    const next = nextBackfillDiffWatermark(current, [
      { sha: "a", date: "2026-07-01T03:00:00.000Z", status: "ok" },
      { sha: "b", date: "2026-07-01T02:00:00.000Z", status: "ok" },
    ]);
    expect(next).toBe("2026-07-01T02:00:00.000Z");
  });

  it("freezes at the last success before a failure, keeping it in the next window", () => {
    const next = nextBackfillDiffWatermark(current, [
      { sha: "a", date: "2026-07-01T03:00:00.000Z", status: "ok" },
      { sha: "b", date: "2026-07-01T02:00:00.000Z", status: "failed" },
      { sha: "c", date: "2026-07-01T01:00:00.000Z", status: "ok" },
    ]);
    // `until=03:00` still covers the failed 02:00 commit on the next run.
    expect(next).toBe("2026-07-01T03:00:00.000Z");
  });

  it("leaves the watermark unchanged when the newest commit failed or none were seen", () => {
    expect(
      nextBackfillDiffWatermark(current, [
        { sha: "a", date: "2026-07-01T03:00:00.000Z", status: "failed" },
      ]),
    ).toBeUndefined();
    expect(nextBackfillDiffWatermark(current, [])).toBeUndefined();
  });
});

describe("poller: pollDiffs forward watermark / retry boundary", () => {
  it("keeps a failed commit inside the next run's window", async () => {
    const commits = [
      commit("c1", "2026-07-01T01:00:00.000Z"),
      commit("c2", "2026-07-01T02:00:00.000Z"),
      commit("c3", "2026-07-01T03:00:00.000Z"),
    ];
    const { stub, watermarks } = makeStore({
      [FORWARD_KEY]: "2026-07-01T00:00:00.000Z",
      // Park the backfill phase on exhausted history so it does not interfere.
      [BACKFILL_KEY]: "2026-06-01T00:00:00.000Z",
    });
    stubCommitList(commits);

    // c2 fails to ingest; c1 and c3 succeed.
    fetchCommitDetailMock.mockImplementation(async (_repo: string, sha: string) => {
      if (sha === "c2") throw new Error("simulated detail fetch failure");
      return { sha, commit: { message: "m" }, files: [] };
    });

    await pollDiffs(REPO, env, stub);

    expect(attemptedShas()).toEqual(["c1", "c2", "c3"]);
    // Watermark parked before c2 rather than jumping to the poll start time.
    const wm = watermarks.get(FORWARD_KEY)!;
    expect(Date.parse(wm)).toBeLessThan(Date.parse("2026-07-01T02:00:00.000Z"));
    expect(Date.parse(wm)).toBeGreaterThanOrEqual(
      Date.parse("2026-07-01T01:00:00.000Z"),
    );

    // Next run: c2 is back in the window (this is the regression the issue reports).
    fetchCommitDetailMock.mockReset();
    fetchCommitDetailMock.mockImplementation(async (_repo: string, sha: string) => ({
      sha,
      commit: { message: "m" },
      files: [],
    }));
    await pollDiffs(REPO, env, stub);

    expect(attemptedShas()).toContain("c2");
    expect(attemptedShas()).toContain("c3");
  });

  it("treats a non-throwing pipeline failure (embed / Vectorize / D1) as unfinished", async () => {
    const commits = [
      commit("c1", "2026-07-01T01:00:00.000Z"),
      commit("c2", "2026-07-01T02:00:00.000Z"),
    ];
    const { stub, watermarks } = makeStore({
      [FORWARD_KEY]: "2026-07-01T00:00:00.000Z",
      [BACKFILL_KEY]: "2026-06-01T00:00:00.000Z",
    });
    stubCommitList(commits);

    // `processAndUpsertCommitDiff` reports per-file failure by return value.
    processAndUpsertCommitDiffMock.mockImplementation(
      async (_env: unknown, _stub: unknown, _repo: string, detail: { sha: string }) =>
        detail.sha === "c1"
          ? { embedded: 1, skipped: 0, failed: 0, batches: 1 }
          : { embedded: 0, skipped: 0, failed: 3, batches: 1 },
    );

    await pollDiffs(REPO, env, stub);

    const wm = watermarks.get(FORWARD_KEY)!;
    expect(Date.parse(wm)).toBeLessThan(Date.parse("2026-07-01T02:00:00.000Z"));
  });

  it("holds the watermark when the commit list call fails", async () => {
    const start = "2026-07-01T00:00:00.000Z";
    const { stub, watermarks } = makeStore({
      [FORWARD_KEY]: start,
      [BACKFILL_KEY]: "2026-06-01T00:00:00.000Z",
    });
    stubCommitList([], { fail: true });

    await pollDiffs(REPO, env, stub);

    expect(watermarks.get(FORWARD_KEY)).toBe(start);
    expect(attemptedShas()).toEqual([]);
  });

  it("drains a burst larger than the per-run cap across runs without skipping", async () => {
    // 7 commits in one window against a per-run cap of 5.
    const commits = Array.from({ length: 7 }, (_, i) =>
      commit(`c${i + 1}`, `2026-07-01T0${i + 1}:00:00.000Z`),
    );
    const { stub, watermarks } = makeStore({
      [FORWARD_KEY]: "2026-07-01T00:00:00.000Z",
      [BACKFILL_KEY]: "2026-06-01T00:00:00.000Z",
    });
    stubCommitList(commits);

    await pollDiffs(REPO, env, stub);
    // Oldest-first: the run takes c1..c5, not the newest 5 GitHub lists first.
    expect(attemptedShas()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    const wm = watermarks.get(FORWARD_KEY)!;
    expect(Date.parse(wm)).toBeLessThan(Date.parse("2026-07-01T06:00:00.000Z"));

    fetchCommitDetailMock.mockClear();
    await pollDiffs(REPO, env, stub);
    // The remaining two are picked up rather than skipped past.
    expect(attemptedShas()).toContain("c6");
    expect(attemptedShas()).toContain("c7");
  });

  it("advances to the poll start time once the window is fully ingested", async () => {
    const start = "2026-07-01T00:00:00.000Z";
    const { stub, watermarks } = makeStore({
      [FORWARD_KEY]: start,
      [BACKFILL_KEY]: "2026-06-01T00:00:00.000Z",
    });
    stubCommitList([commit("c1", "2026-07-01T01:00:00.000Z")]);

    await pollDiffs(REPO, env, stub);

    const wm = watermarks.get(FORWARD_KEY)!;
    expect(Date.parse(wm)).toBeGreaterThan(Date.parse("2026-07-01T01:00:00.000Z"));
    // An empty follow-up window keeps advancing (no stall on the idle path).
    await pollDiffs(REPO, env, stub);
    expect(Date.parse(watermarks.get(FORWARD_KEY)!)).toBeGreaterThanOrEqual(
      Date.parse(wm),
    );
  });
});

describe("poller: pollDiffs backfill watermark", () => {
  it("does not step over a failed commit", async () => {
    const commits = [
      commit("b1", "2026-06-01T03:00:00.000Z"),
      commit("b2", "2026-06-01T02:00:00.000Z"),
      commit("b3", "2026-06-01T01:00:00.000Z"),
    ];
    const { stub, watermarks } = makeStore({
      // Forward phase sees nothing (its window is newer than every fixture).
      [FORWARD_KEY]: "2026-07-01T00:00:00.000Z",
      [BACKFILL_KEY]: "2026-06-01T04:00:00.000Z",
    });
    stubCommitList(commits);

    fetchCommitDetailMock.mockImplementation(async (_repo: string, sha: string) => {
      if (sha === "b2") throw new Error("simulated detail fetch failure");
      return { sha, commit: { message: "m" }, files: [] };
    });

    await pollDiffs(REPO, env, stub);

    // Frozen at b1 so b2 stays inside the next `until` window.
    expect(watermarks.get(BACKFILL_KEY)).toBe("2026-06-01T03:00:00.000Z");

    fetchCommitDetailMock.mockReset();
    fetchCommitDetailMock.mockClear();
    fetchCommitDetailMock.mockImplementation(async (_repo: string, sha: string) => ({
      sha,
      commit: { message: "m" },
      files: [],
    }));
    await pollDiffs(REPO, env, stub);

    expect(attemptedShas()).toContain("b2");
    expect(watermarks.get(BACKFILL_KEY)).toBe("2026-06-01T01:00:00.000Z");
  });
});
