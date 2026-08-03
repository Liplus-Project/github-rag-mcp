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
