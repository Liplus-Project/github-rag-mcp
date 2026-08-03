import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "./types.js";

// `pollDiffs` fans out to the commit-diff pipeline (GitHub detail fetch + Workers
// AI embed + Vectorize + D1 + Store DO). The watermark contract under test is
// upstream of all of that, so the two pipeline entry points are replaced with
// controllable fakes and only the *commit list* call reaches the stubbed global
// fetch. Everything else in `./pipeline.js` stays real.
const {
  fetchCommitDetailMock,
  processAndUpsertCommitDiffMock,
  processAndUpsertIssueMock,
  processAndUpsertReleaseMock,
} = vi.hoisted(() => ({
  fetchCommitDetailMock: vi.fn(),
  processAndUpsertCommitDiffMock: vi.fn(),
  processAndUpsertIssueMock: vi.fn(),
  processAndUpsertReleaseMock: vi.fn(),
}));

vi.mock("./pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pipeline.js")>();
  return {
    ...actual,
    fetchCommitDetail: fetchCommitDetailMock,
    processAndUpsertCommitDiff: processAndUpsertCommitDiffMock,
    processAndUpsertIssue: processAndUpsertIssueMock,
    processAndUpsertRelease: processAndUpsertReleaseMock,
  };
});

const {
  pollDiffs,
  pollRepo,
  pollReleases,
  nextForwardDiffWatermark,
  nextBackfillDiffWatermark,
  nextIssueWatermark,
  MAX_EMBEDDINGS_PER_RUN,
  MAX_RELEASE_UPSERTS_PER_REPO_PER_RUN,
  MAX_DOC_FETCHES_PER_REPO_PER_RUN,
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
function makeStore(
  seed: Record<string, string> = {},
  etagSeed: Record<string, string> = {},
) {
  const watermarks = new Map<string, string>(Object.entries(seed));
  const etags = new Map<string, string>(Object.entries(etagSeed));
  /** Records written through `/upsert` (the empty-hash retry markers). */
  const upserts: Array<{ number: number; bodyHash: string }> = [];
  /** Records written through `/upsert-release` (same retry markers, release side). */
  const releaseUpserts: Array<{ tagName: string; bodyHash: string }> = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/watermark") {
        const key = url.searchParams.get("repo") ?? "";
        const value = watermarks.get(key);
        if (!value) return new Response("not found", { status: 404 });
        const etag = etags.get(key);
        return Response.json({ repo: key, lastPolledAt: value, etag });
      }
      if (request.method === "POST" && url.pathname === "/watermark") {
        const body = (await request.json()) as {
          repo: string;
          lastPolledAt: string;
          etag?: string;
        };
        watermarks.set(body.repo, body.lastPolledAt);
        // The store column defaults to '' — an omitted ETag clears the stored one.
        if (body.etag) etags.set(body.repo, body.etag);
        else etags.delete(body.repo);
        return new Response("ok");
      }
      if (request.method === "POST" && url.pathname === "/upsert") {
        const body = (await request.json()) as { number: number; bodyHash: string };
        upserts.push({ number: body.number, bodyHash: body.bodyHash });
        return new Response("ok");
      }
      if (request.method === "POST" && url.pathname === "/upsert-release") {
        const body = (await request.json()) as { tagName: string; bodyHash: string };
        releaseUpserts.push({ tagName: body.tagName, bodyHash: body.bodyHash });
        return new Response("ok");
      }
      return new Response("ok");
    },
  };
  return {
    stub: stub as unknown as DurableObjectStub,
    watermarks,
    etags,
    upserts,
    releaseUpserts,
  };
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

/** One issue as the GitHub list endpoint returns it (subset the poller reads). */
function fakeIssue(number: number, updatedAt: string) {
  return {
    number,
    title: `issue ${number}`,
    body: "body",
    state: "open" as const,
    labels: [],
    milestone: null,
    assignees: [],
    created_at: updatedAt,
    updated_at: updatedAt,
    html_url: `https://github.com/${REPO}/issues/${number}`,
  };
}

/** `n` issues one minute apart, ascending — the order GitHub returns them in. */
function issueSeries(n: number) {
  return Array.from({ length: n }, (_, i) =>
    fakeIssue(i + 1, new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString()),
  );
}

const ISSUE_ETAG = 'W/"issues-v1"';

/**
 * Stub the global fetch with a fake GitHub issue-list endpoint.
 *
 * Mirrors the contract `pollRepo` depends on: `sort=updated&direction=asc`,
 * `since` filtering, `per_page` pagination, and a conditional request that
 * answers 304 when the caller echoes the stored ETag back. The 304 is what makes
 * an ETag stored over unfinished work fatal rather than merely wasteful.
 */
function stubIssueList(issues: ReturnType<typeof fakeIssue>[]) {
  const sinceQueries: Array<string | undefined> = [];

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["If-None-Match"] === ISSUE_ETAG) {
      return new Response(null, { status: 304 });
    }

    const since = url.searchParams.get("since") ?? undefined;
    const perPage = Number(url.searchParams.get("per_page") ?? "100");
    const page = Number(url.searchParams.get("page") ?? "1");
    if (page === 1) sinceQueries.push(since);

    // GitHub documents `since` as "updated after" — model the exclusive reading,
    // so a watermark pinned exactly at an item's timestamp would lose it.
    const selected = issues
      .filter((i) => (since ? Date.parse(i.updated_at) > Date.parse(since) : true))
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
      .slice((page - 1) * perPage, page * perPage);

    return new Response(JSON.stringify(selected), {
      status: 200,
      headers: { "Content-Type": "application/json", etag: ISSUE_ETAG },
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { sinceQueries };
}

/** One release as the GitHub list endpoint returns it (subset the poller reads). */
function fakeRelease(tag: string) {
  return {
    tag_name: tag,
    name: `Release ${tag}`,
    body: "notes",
    prerelease: false,
    created_at: "2026-07-01T00:00:00.000Z",
    published_at: "2026-07-01T00:00:00.000Z",
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  };
}

const RELEASE_ETAG = 'W/"releases-v2"';

/**
 * Stub the global fetch with a fake GitHub releases endpoint.
 *
 * The conditional-request contract is the load-bearing part: echoing back the
 * ETag the poller stored answers 304, which is what turns "stored an ETag over
 * unfinished work" into a stall rather than a wasted request.
 */
function stubReleaseList(releases: ReturnType<typeof fakeRelease>[]) {
  const conditionalHits: string[] = [];

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const sent = headers["If-None-Match"];
    if (sent) conditionalHits.push(sent);
    if (sent === RELEASE_ETAG) {
      return new Response(null, { status: 304 });
    }
    return new Response(JSON.stringify(releases), {
      status: 200,
      headers: { "Content-Type": "application/json", etag: RELEASE_ETAG },
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { conditionalHits };
}

/** Tags handed to the embed pipeline, i.e. the releases a run attempted. */
const attemptedReleases = (): string[] =>
  processAndUpsertReleaseMock.mock.calls.map((call) =>
    String((call[3] as { tag_name: string }).tag_name),
  );

/** Issue numbers handed to the embed pipeline, i.e. the items a run attempted. */
const attemptedIssues = (): number[] =>
  processAndUpsertIssueMock.mock.calls.map((call) => Number((call[3] as { number: number }).number));

const env = { GITHUB_TOKEN: "test-token" } as unknown as Env;

/** SHAs handed to the detail fetch, i.e. the commits a run actually attempted. */
const attemptedShas = (): string[] =>
  fetchCommitDetailMock.mock.calls.map((call) => String(call[1]));

beforeEach(() => {
  fetchCommitDetailMock.mockReset();
  processAndUpsertCommitDiffMock.mockReset();
  processAndUpsertIssueMock.mockReset();
  processAndUpsertReleaseMock.mockReset();
  // Default: every issue embeds cleanly.
  processAndUpsertIssueMock.mockResolvedValue({
    embedded: true,
    skippedUnchanged: false,
    metadataUpdated: false,
    failed: false,
  });
  // Default: every release embeds cleanly.
  processAndUpsertReleaseMock.mockResolvedValue({
    embedded: true,
    skippedUnchanged: false,
    metadataUpdated: false,
    failed: false,
  });
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

describe("poller: nextIssueWatermark", () => {
  const since = "2026-07-01T00:00:00.000Z";
  const candidate = "2026-07-01T12:00:00.000Z";

  it("takes the fetch bound when every item was ingested", () => {
    expect(nextIssueWatermark(since, candidate, undefined)).toBe(candidate);
  });

  it("pins just before the first uningested item", () => {
    expect(
      nextIssueWatermark(since, candidate, "2026-07-01T02:00:00.000Z"),
    ).toBe("2026-07-01T01:59:59.000Z");
  });

  it("pins on an initial sync, where there is no watermark yet", () => {
    expect(
      nextIssueWatermark(undefined, candidate, "2026-07-01T02:00:00.000Z"),
    ).toBe("2026-07-01T01:59:59.000Z");
  });

  it("never regresses below the watermark it started from", () => {
    expect(nextIssueWatermark(since, candidate, since)).toBe(since);
  });

  it("holds the watermark when the boundary item carries no usable timestamp", () => {
    expect(nextIssueWatermark(since, candidate, "not-a-date")).toBe(since);
    expect(nextIssueWatermark(undefined, candidate, "not-a-date")).toBeUndefined();
  });
});

describe("poller: pollRepo watermark / retry boundary", () => {
  it("keeps items the embedding budget deferred inside the next run's window", async () => {
    // 60 items against a per-run embedding budget of 50.
    const issues = issueSeries(60);
    const { stub, watermarks, upserts } = makeStore();
    stubIssueList(issues);

    await pollRepo(REPO, env, stub);

    // The budget stops at 50; the rest are marked for retry, not embedded.
    expect(attemptedIssues()).toEqual(issues.slice(0, 50).map((i) => i.number));
    expect(upserts.map((u) => u.number)).toEqual(
      issues.slice(50).map((i) => i.number),
    );
    expect(upserts.every((u) => u.bodyHash === "")).toBe(true);

    // Watermark parked before item 51 rather than at the poll start time.
    const wm = watermarks.get(REPO)!;
    expect(Date.parse(wm)).toBeLessThan(Date.parse(issues[50].updated_at));
    expect(Date.parse(wm)).toBeGreaterThanOrEqual(Date.parse(issues[49].updated_at));

    // Next run: the deferred items are back in the window. Before issue #210 the
    // watermark had already moved past them and they were never fetched again.
    processAndUpsertIssueMock.mockClear();
    await pollRepo(REPO, env, stub);

    expect(attemptedIssues()).toEqual(issues.slice(50).map((i) => i.number));
  });

  it("withholds the ETag while work is left behind, so the retry is not answered 304", async () => {
    const issues = issueSeries(60);
    const { stub, etags } = makeStore();
    stubIssueList(issues);

    await pollRepo(REPO, env, stub);

    expect(etags.get(REPO)).toBeUndefined();
  });

  it("advances to the poll start time and stores the ETag once everything landed", async () => {
    const issues = issueSeries(3);
    const { stub, watermarks, etags } = makeStore();
    stubIssueList(issues);

    await pollRepo(REPO, env, stub);

    expect(attemptedIssues()).toEqual([1, 2, 3]);
    expect(Date.parse(watermarks.get(REPO)!)).toBeGreaterThan(
      Date.parse(issues[2].updated_at),
    );
    expect(etags.get(REPO)).toBe(ISSUE_ETAG);
  });

  it("pins the watermark before an item whose embed failed", async () => {
    const issues = issueSeries(3);
    const { stub, watermarks } = makeStore();
    stubIssueList(issues);

    processAndUpsertIssueMock.mockImplementation(
      async (
        _env: unknown,
        _stub: unknown,
        _repo: string,
        issue: { number: number },
      ) =>
        issue.number === 2
          ? { embedded: false, skippedUnchanged: false, metadataUpdated: false, failed: true }
          : { embedded: true, skippedUnchanged: false, metadataUpdated: false, failed: false },
    );

    await pollRepo(REPO, env, stub);

    const wm = watermarks.get(REPO)!;
    expect(Date.parse(wm)).toBeLessThan(Date.parse(issues[1].updated_at));

    // Item 2 is back in the next window rather than stranded behind the watermark.
    processAndUpsertIssueMock.mockClear();
    processAndUpsertIssueMock.mockResolvedValue({
      embedded: true,
      skippedUnchanged: false,
      metadataUpdated: false,
      failed: false,
    });
    await pollRepo(REPO, env, stub);

    expect(attemptedIssues()).toContain(2);
  });

  it("drains a backlog larger than the budget across runs without skipping", async () => {
    const issues = issueSeries(130);
    const { stub } = makeStore();
    stubIssueList(issues);

    const seen = new Set<number>();
    for (let run = 0; run < 3; run++) {
      processAndUpsertIssueMock.mockClear();
      await pollRepo(REPO, env, stub);
      for (const n of attemptedIssues()) seen.add(n);
    }

    // Every item reached the pipeline across the three runs; none fell into the
    // gap between one run's budget and the next run's `since`.
    expect(seen.size).toBe(130);
  });
});

describe("poller: the fan-out caps that stand in for an embedding guard", () => {
  // `pollReleases` and `pollDocs` carry no embedding cap of their own. Issue #211
  // removed the branches that used to hold one, because each was unreachable: the
  // loop's embed count can never exceed its fan-out count, and the fan-out cap
  // fires first at a value below MAX_EMBEDDINGS_PER_RUN. That relation between
  // constants is the whole reason those loops are safe without a guard, and it is
  // the kind of thing a later cap adjustment breaks silently — this repo has
  // retuned fan-out caps more than once (issue #134 took the comment fetch cap
  // from 30 to 10). So the relation is asserted here rather than left to the
  // comments at the cap sites.
  //
  // If either assertion below fails, raising the cap was not by itself wrong —
  // but the loop it belongs to now needs its embedding guard back, folded into
  // that loop's ETag-hold condition (`leftWorkBehind` in `pollReleases`,
  // `holdEtag` in `pollDocs`) so a deferred item still holds the ETag.
  it("keeps both fan-out caps below the embedding budget", () => {
    expect(MAX_RELEASE_UPSERTS_PER_REPO_PER_RUN).toBeLessThan(MAX_EMBEDDINGS_PER_RUN);
    expect(MAX_DOC_FETCHES_PER_REPO_PER_RUN).toBeLessThan(MAX_EMBEDDINGS_PER_RUN);
  });
});

describe("poller: pollReleases ETag hold", () => {
  // Before issue #211 the ETag write looked at the upsert cap alone. An embed
  // failure marks the release with an empty `bodyHash` for retry exactly the way
  // the cap does, but the run still stored the fresh ETag — so the next cron was
  // answered 304 and returned before it reached the marked release, which then
  // waited for some *other* release to change.
  const KEY = `releases:${REPO}`;
  const PRIOR_ETAG = 'W/"releases-v1"';
  const seeded = () =>
    makeStore({ [KEY]: "2026-07-01T00:00:00.000Z" }, { [KEY]: PRIOR_ETAG });

  it("holds the prior ETag when a release failed to embed", async () => {
    const { stub, etags } = seeded();
    stubReleaseList([fakeRelease("v1.0.0"), fakeRelease("v1.1.0")]);

    processAndUpsertReleaseMock.mockImplementation(
      async (_env: unknown, _stub: unknown, _repo: string, release: { tag_name: string }) =>
        release.tag_name === "v1.1.0"
          ? { embedded: false, skippedUnchanged: false, metadataUpdated: false, failed: true }
          : { embedded: true, skippedUnchanged: false, metadataUpdated: false, failed: false },
    );

    await pollReleases(REPO, env, stub);

    expect(attemptedReleases()).toEqual(["v1.0.0", "v1.1.0"]);
    expect(etags.get(KEY)).toBe(PRIOR_ETAG);
  });

  it("reprocesses the failed release on the next run, which is what the hold buys", async () => {
    const { stub } = seeded();
    stubReleaseList([fakeRelease("v1.0.0")]);
    processAndUpsertReleaseMock.mockResolvedValue({
      embedded: false,
      skippedUnchanged: false,
      metadataUpdated: false,
      failed: true,
    });

    await pollReleases(REPO, env, stub);

    // Next run: the held ETag does not match the current list (this run proved
    // that by getting a 200 for it), so the list comes back 200 and the release
    // is attempted again.
    const { conditionalHits } = stubReleaseList([fakeRelease("v1.0.0")]);
    processAndUpsertReleaseMock.mockClear();
    processAndUpsertReleaseMock.mockResolvedValue({
      embedded: true,
      skippedUnchanged: false,
      metadataUpdated: false,
      failed: false,
    });
    await pollReleases(REPO, env, stub);

    expect(conditionalHits).toEqual([PRIOR_ETAG]);
    expect(attemptedReleases()).toEqual(["v1.0.0"]);
  });

  it("stores the fresh ETag when every release landed", async () => {
    const { stub, etags } = seeded();
    stubReleaseList([fakeRelease("v1.0.0")]);

    await pollReleases(REPO, env, stub);

    expect(etags.get(KEY)).toBe(RELEASE_ETAG);
  });

  it("still holds the ETag when the upsert cap deferred releases", async () => {
    // The issue #149 guard, kept: 12 releases against a per-run upsert cap of 10.
    const releases = Array.from({ length: 12 }, (_, i) => fakeRelease(`v1.0.${i}`));
    const { stub, etags, releaseUpserts } = seeded();
    stubReleaseList(releases);

    await pollReleases(REPO, env, stub);

    expect(attemptedReleases()).toHaveLength(10);
    // The two over-cap releases are marked for retry, not embedded.
    expect(releaseUpserts.map((r) => r.tagName)).toEqual(["v1.0.10", "v1.0.11"]);
    expect(releaseUpserts.every((r) => r.bodyHash === "")).toBe(true);
    expect(etags.get(KEY)).toBe(PRIOR_ETAG);
  });

  it("returns early on 304 without touching the pipeline", async () => {
    // The stall this hold prevents: with the fresh ETag stored, this is the shape
    // every subsequent run would take while a marked release sat unprocessed.
    const { stub } = makeStore(
      { [KEY]: "2026-07-01T00:00:00.000Z" },
      { [KEY]: RELEASE_ETAG },
    );
    stubReleaseList([fakeRelease("v1.0.0")]);

    await pollReleases(REPO, env, stub);

    expect(attemptedReleases()).toEqual([]);
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
