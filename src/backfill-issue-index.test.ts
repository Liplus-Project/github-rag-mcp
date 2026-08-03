import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "./types.js";

// The embed fan-out (Workers AI + Vectorize + D1 + Store DO) is out of scope for
// the gap-walk contract under test, so the pipeline entry point is a fake and only
// the GitHub calls reach the stubbed global fetch.
const { processAndUpsertIssueMock } = vi.hoisted(() => ({
  processAndUpsertIssueMock: vi.fn(),
}));

vi.mock("./pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pipeline.js")>();
  return { ...actual, processAndUpsertIssue: processAndUpsertIssueMock };
});

const {
  backfillIssueIndex,
  fetchHighestItemNumber,
  DEFAULT_INDEX_BACKFILL_LIMIT,
  MAX_INDEX_BACKFILL_LIMIT,
} = await import("./backfill-issue-index.js");

const REPO = "acme/widgets";

/**
 * Stub the two GitHub surfaces the module uses: the one-entry listing that
 * reports the highest number, and the per-number item fetch.
 *
 * `present` is the set of numbers GitHub actually has; anything else 404s, which
 * is how a deleted or transferred number looks.
 */
function stubGitHub(maxNumber: number, present: Set<number>) {
  const fetched: number[] = [];

  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const detail = url.pathname.match(/^\/repos\/.+\/issues\/(\d+)$/);

    if (detail) {
      const number = Number(detail[1]);
      fetched.push(number);
      if (!present.has(number)) return new Response("Not Found", { status: 404 });
      return new Response(
        JSON.stringify({
          number,
          title: `item ${number}`,
          body: "body",
          state: "closed",
          labels: [],
          milestone: null,
          assignees: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          html_url: `https://github.com/${REPO}/issues/${number}`,
        }),
        { status: 200 },
      );
    }

    expect(url.searchParams.get("direction")).toBe("desc");
    return new Response(
      JSON.stringify(maxNumber > 0 ? [{ number: maxNumber }] : []),
      { status: 200 },
    );
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetched };
}

/** D1 stub understanding only the indexed-number SELECT this module issues. */
function mkDb(indexedNumbers: number[]) {
  const queries: Array<{ from: number; to: number }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => {
          if (!sql.includes("SELECT DISTINCT number")) {
            throw new Error(`unexpected statement: ${sql}`);
          }
          const [, from, to] = args as [string, number, number];
          queries.push({ from, to });
          return {
            results: indexedNumbers
              .filter((n) => n > from && n <= to)
              .map((n) => ({ number: n })),
          };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, queries };
}

function mkEnv(indexedNumbers: number[]) {
  const { db, queries } = mkDb(indexedNumbers);
  const env = {
    GITHUB_TOKEN: "test-token",
    DB_FTS: db,
    ISSUE_STORE: {
      idFromName: () => "id",
      get: () => ({ fetch: async () => new Response("ok") }),
    },
  } as unknown as Env;
  return { env, queries };
}

/** Numbers handed to the embed pipeline. */
const ingested = (): number[] =>
  processAndUpsertIssueMock.mock.calls.map((c) => Number((c[3] as { number: number }).number));

/** Every integer in `1..n`. */
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

beforeEach(() => {
  processAndUpsertIssueMock.mockReset();
  processAndUpsertIssueMock.mockResolvedValue({
    embedded: true,
    skippedUnchanged: false,
    metadataUpdated: false,
    failed: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("backfill-issue-index: the number ceiling", () => {
  it("reads the highest number from the newest-created item", async () => {
    stubGitHub(1690, new Set());
    expect(await fetchHighestItemNumber(REPO, "test-token")).toBe(1690);
  });

  it("reports 0 for a repository with no issues and no pull requests", async () => {
    stubGitHub(0, new Set());
    expect(await fetchHighestItemNumber(REPO, "test-token")).toBe(0);
  });

  it("surfaces a GitHub API error instead of treating it as an empty repository", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await expect(fetchHighestItemNumber(REPO, "test-token")).rejects.toThrow(/403/);
  });
});

describe("backfill-issue-index: gap detection", () => {
  it("ingests only the numbers with no indexed row", async () => {
    const { fetched } = stubGitHub(10, new Set(range(10)));
    const { env } = mkEnv([1, 2, 3, 5, 8, 9, 10]);

    const summary = await backfillIssueIndex(REPO, env, {});

    expect(summary.candidates).toBe(3);
    expect(fetched).toEqual([4, 6, 7]);
    expect(ingested()).toEqual([4, 6, 7]);
    expect(summary.indexed).toBe(3);
    expect(summary.done).toBe(true);
    expect(summary.nextCursor).toBeNull();
  });

  it("forces the ingest past the body-hash check", async () => {
    stubGitHub(2, new Set([1, 2]));
    const { env } = mkEnv([1]);

    await backfillIssueIndex(REPO, env, {});

    expect(processAndUpsertIssueMock.mock.calls[0][4]).toEqual({ force: true });
  });

  it("writes nothing when the index already covers the whole number space", async () => {
    const { fetched } = stubGitHub(10, new Set(range(10)));
    const { env } = mkEnv(range(10));

    const summary = await backfillIssueIndex(REPO, env, {});

    expect(summary.candidates).toBe(0);
    expect(fetched).toEqual([]);
    expect(summary.done).toBe(true);
  });

  it("counts a number GitHub does not have without calling the pipeline", async () => {
    // 3 was deleted or transferred: it is missing from the index and from GitHub.
    stubGitHub(4, new Set([1, 2, 4]));
    const { env } = mkEnv([1, 2]);

    const summary = await backfillIssueIndex(REPO, env, {});

    expect(summary.absent).toBe(1);
    expect(summary.indexed).toBe(1);
    expect(ingested()).toEqual([4]);
  });

  it("counts an embed failure separately so a later call retries it", async () => {
    stubGitHub(2, new Set([1, 2]));
    const { env } = mkEnv([]);
    processAndUpsertIssueMock.mockImplementation(
      async (_e: unknown, _s: unknown, _r: string, issue: { number: number }) =>
        issue.number === 1
          ? { embedded: false, skippedUnchanged: false, metadataUpdated: false, failed: true }
          : { embedded: true, skippedUnchanged: false, metadataUpdated: false, failed: false },
    );

    const summary = await backfillIssueIndex(REPO, env, {});

    expect(summary.failed).toBe(1);
    expect(summary.indexed).toBe(1);
  });

  it("surfaces a non-404 item fetch error rather than counting it as absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        if (/\/issues\/\d+$/.test(url.pathname)) {
          return new Response("rate limited", { status: 403 });
        }
        return new Response(JSON.stringify([{ number: 2 }]), { status: 200 });
      }),
    );
    const { env } = mkEnv([]);

    await expect(backfillIssueIndex(REPO, env, {})).rejects.toThrow(/403/);
  });
});

describe("backfill-issue-index: per-call budget", () => {
  it("stops at the limit and hands back a cursor on the number it stopped at", async () => {
    stubGitHub(10, new Set(range(10)));
    const { env } = mkEnv([]);

    const summary = await backfillIssueIndex(REPO, env, { limit: 3 });

    expect(ingested()).toEqual([1, 2, 3]);
    expect(summary.nextCursor).toBe(3);
    expect(summary.done).toBe(false);
  });

  it("drains the whole gap across calls when fed its own nextCursor", async () => {
    const { env } = mkEnv([4, 5]);

    let cursor: number | null = 0;
    let calls = 0;
    while (cursor !== null) {
      stubGitHub(10, new Set(range(10)));
      const summary: Awaited<ReturnType<typeof backfillIssueIndex>> =
        await backfillIssueIndex(REPO, env, { limit: 3, cursor });
      cursor = summary.nextCursor;
      calls++;
    }

    expect(ingested()).toEqual([1, 2, 3, 6, 7, 8, 9, 10]);
    expect(calls).toBe(3);
  });

  it("resumes after the cursor without re-examining what came before", async () => {
    const { fetched } = stubGitHub(10, new Set(range(10)));
    const { env, queries } = mkEnv([]);

    await backfillIssueIndex(REPO, env, { cursor: 7 });

    expect(fetched).toEqual([8, 9, 10]);
    expect(queries[0].from).toBe(7);
  });

  it("defaults the per-call budget to DEFAULT_INDEX_BACKFILL_LIMIT", async () => {
    stubGitHub(0, new Set());
    const { env } = mkEnv([]);

    const summary = await backfillIssueIndex(REPO, env, {});

    expect(summary.limit).toBe(DEFAULT_INDEX_BACKFILL_LIMIT);
  });

  it("terminates on a cursor already past the highest number", async () => {
    stubGitHub(10, new Set(range(10)));
    const { env } = mkEnv([]);

    const summary = await backfillIssueIndex(REPO, env, { cursor: 99 });

    expect(summary.candidates).toBe(0);
    expect(summary.done).toBe(true);
  });

  it("chunks the indexed-set query rather than reading the whole index at once", async () => {
    stubGitHub(450, new Set());
    const { env, queries } = mkEnv(range(450));

    await backfillIssueIndex(REPO, env, {});

    expect(queries).toEqual([
      { from: 0, to: 200 },
      { from: 200, to: 400 },
      { from: 400, to: 450 },
    ]);
  });
});

describe("backfill-issue-index: the per-call budget constants", () => {
  // Production re-measurement is unavailable (the issue #210 sweep took every
  // indexed repository to 100% coverage, so no candidates remain), which leaves
  // the 2026-08-03 observation plus this assertion as the whole guard.
  it("keeps the ceiling below the measured subrequest envelope", () => {
    // c ≈ 40 subrequests per candidate against the 1000-subrequest invocation
    // budget puts the arithmetic ceiling at 24, and limit=25 was observed to lose
    // its last candidate on all 48 production calls.
    expect(MAX_INDEX_BACKFILL_LIMIT).toBeLessThan(24);
    // 15 is the largest value production completed with failed=0.
    expect(DEFAULT_INDEX_BACKFILL_LIMIT).toBeLessThanOrEqual(15);
    expect(DEFAULT_INDEX_BACKFILL_LIMIT).toBeLessThanOrEqual(MAX_INDEX_BACKFILL_LIMIT);
  });
});

describe("backfill-issue-index: the cursor invariant", () => {
  /** Fail exactly the candidates named; everything else lands. */
  function failOn(numbers: number[]) {
    processAndUpsertIssueMock.mockImplementation(
      async (_e: unknown, _s: unknown, _r: string, issue: { number: number }) => ({
        embedded: !numbers.includes(issue.number),
        skippedUnchanged: false,
        metadataUpdated: false,
        failed: numbers.includes(issue.number),
      }),
    );
  }

  it("holds the cursor one below the first failed candidate", async () => {
    stubGitHub(10, new Set(range(10)));
    const { env } = mkEnv([]);
    failOn([3]);

    const summary = await backfillIssueIndex(REPO, env, { limit: 5 });

    // 1..5 attempted, 3 failed: the next call must reopen exactly on 3.
    expect(summary.nextCursor).toBe(2);
    expect(summary.done).toBe(false);
  });

  it("does not report done while a candidate is left uningested", async () => {
    stubGitHub(3, new Set(range(3)));
    const { env } = mkEnv([]);
    failOn([2]);

    const summary = await backfillIssueIndex(REPO, env, {});

    // The scan reached the top of the number space, but 2 never landed.
    expect(summary.scannedTo).toBe(3);
    expect(summary.done).toBe(false);
    expect(summary.nextCursor).toBe(1);
  });

  it("does not hold the cursor on a number GitHub no longer has", async () => {
    // 2 is absent from GitHub, so no call will ever ingest it; holding there
    // would stall the sweep permanently instead of bounding a retry.
    stubGitHub(3, new Set([1, 3]));
    const { env } = mkEnv([]);

    const summary = await backfillIssueIndex(REPO, env, {});

    expect(summary.absent).toBe(1);
    expect(summary.done).toBe(true);
    expect(summary.nextCursor).toBeNull();
  });

  it("makes a stall visible as a cursor that did not move", async () => {
    stubGitHub(10, new Set(range(10)));
    const { env } = mkEnv([]);
    failOn([6]);

    const summary = await backfillIssueIndex(REPO, env, { limit: 3, cursor: 5 });

    expect(summary.failed).toBe(1);
    expect(summary.nextCursor).toBe(5);
  });

  it("steps over a permanently failing number when the caller advances the cursor", async () => {
    const { fetched } = stubGitHub(10, new Set(range(10)));
    const { env } = mkEnv([]);
    failOn([6]);

    // Recovery path: cursor = nextCursor + 1 of the stalled call above.
    const summary = await backfillIssueIndex(REPO, env, { limit: 3, cursor: 6 });

    expect(fetched).toEqual([7, 8, 9]);
    expect(summary.failed).toBe(0);
    expect(summary.nextCursor).toBe(9);
  });

  it("loses nothing across calls when the per-call budget cuts off mid-batch", async () => {
    const { env } = mkEnv([]);
    const landed: number[] = [];
    let attemptsThisCall = 0;

    // Budget model taken from the 2026-08-03 measurement: the last candidate of
    // an over-large call is the one the subrequest budget cuts off.
    processAndUpsertIssueMock.mockImplementation(
      async (_e: unknown, _s: unknown, _r: string, issue: { number: number }) => {
        attemptsThisCall++;
        if (attemptsThisCall >= 3) {
          return { embedded: false, skippedUnchanged: false, metadataUpdated: false, failed: true };
        }
        landed.push(issue.number);
        return { embedded: true, skippedUnchanged: false, metadataUpdated: false, failed: false };
      },
    );

    let cursor: number | null = 0;
    let calls = 0;
    while (cursor !== null && calls < 20) {
      stubGitHub(10, new Set(range(10)));
      attemptsThisCall = 0;
      const summary: Awaited<ReturnType<typeof backfillIssueIndex>> =
        await backfillIssueIndex(REPO, env, { limit: 3, cursor });
      cursor = summary.nextCursor;
      calls++;
    }

    // Every number lands exactly once, in order, despite every call losing its
    // third candidate to the budget.
    expect(landed).toEqual(range(10));
    expect(cursor).toBeNull();
  });
});

describe("backfill-issue-index: dry run", () => {
  it("measures the gap over the whole scan range without fetching or writing", async () => {
    const { fetched } = stubGitHub(10, new Set(range(10)));
    const { env } = mkEnv([1, 2]);

    const summary = await backfillIssueIndex(REPO, env, { dryRun: true, limit: 3 });

    // The fetch budget is not spent, so the measurement is not truncated by it.
    expect(summary.candidates).toBe(8);
    expect(summary.attempted).toBe(0);
    expect(fetched).toEqual([]);
    expect(ingested()).toEqual([]);
    expect(summary.done).toBe(true);
  });
});
