import { describe, it, expect, vi, afterEach } from "vitest";
import type { Env } from "./types.js";
import {
  backfillIssueState,
  fetchOpenItemNumbers,
  DEFAULT_ISSUE_STATE_LIMIT,
} from "./backfill-issue-state.js";

const REPO = "acme/widgets";

/** Stub the GitHub `state=open` listing, paginating at 100 like the real API. */
function stubOpenListing(openNumbers: number[]) {
  const pages: Array<Array<{ number: number }>> = [];
  for (let i = 0; i < openNumbers.length; i += 100) {
    pages.push(openNumbers.slice(i, i + 100).map((number) => ({ number })));
  }
  // A full last page must be followed by an empty one, or the walk cannot stop.
  if (pages.length === 0 || pages[pages.length - 1].length === 100) pages.push([]);

  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/repos/${REPO}/issues`);
    expect(url.searchParams.get("state")).toBe("open");
    const page = Number(url.searchParams.get("page"));
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Minimal D1 stub over an in-memory row list; understands only the two
 *  statements this module issues (the ordered open-row SELECT and the state
 *  UPDATE by vector_id). */
function mkDb(rows: Array<{ vector_id: string; number: number; state: string }>) {
  const updated: string[] = [];
  const batches: number[] = [];

  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => {
          const [, cursor, limit] = args as [string, number, number];
          const results = rows
            .filter((r) => r.state === "open" && r.number > cursor)
            .sort((a, b) => a.number - b.number)
            .slice(0, limit)
            .map((r) => ({ vector_id: r.vector_id, number: r.number }));
          return { results };
        },
        // Returned by db.batch below, not executed directly.
        __apply: () => {
          if (!sql.includes("UPDATE search_docs SET state = 'closed'")) {
            throw new Error(`unexpected statement: ${sql}`);
          }
          const [vectorId] = args as [string];
          const row = rows.find((r) => r.vector_id === vectorId);
          if (row) row.state = "closed";
          updated.push(vectorId);
        },
      }),
    }),
    batch: async (stmts: Array<{ __apply: () => void }>) => {
      batches.push(stmts.length);
      for (const s of stmts) s.__apply();
      return [];
    },
  } as unknown as D1Database;

  return { db, rows, updated, batches };
}

function mkEnv(
  rows: Array<{ vector_id: string; number: number; state: string }>,
  opts: { missingVectors?: string[]; vectorizeThrows?: boolean } = {},
) {
  const store = mkDb(rows);
  const upserted: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const getBatchSizes: number[] = [];

  const env = {
    GITHUB_TOKEN: "test-token",
    DB_FTS: store.db,
    VECTORIZE: {
      getByIds: vi.fn(async (ids: string[]) => {
        getBatchSizes.push(ids.length);
        if (opts.vectorizeThrows) throw new Error("vectorize down");
        return ids
          .filter((id) => !(opts.missingVectors ?? []).includes(id))
          .map((id) => ({ id, values: [0.1, 0.2], metadata: { repo: REPO, state: "open" } }));
      }),
      upsert: vi.fn(async (vectors: Array<{ id: string; metadata: Record<string, unknown> }>) => {
        upserted.push(...vectors);
      }),
    },
  } as unknown as Env;

  return { env, ...store, upserted, getBatchSizes };
}

/** `n` indexed rows numbered 1..n, all stored as open. */
function openRows(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    vector_id: `i:${i + 1 + offset}`,
    number: i + 1 + offset,
    state: "open",
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("backfill-issue-state: the open set", () => {
  it("paginates until a short page and returns every open number", async () => {
    const numbers = Array.from({ length: 150 }, (_, i) => i + 1);
    const fetchMock = stubOpenListing(numbers);

    const open = await fetchOpenItemNumbers(REPO, "test-token");

    expect(open.size).toBe(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to answer from a truncated listing", async () => {
    // Every page full: the walk can never conclude, and guessing would close
    // items that are actually open.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }))),
          { status: 200 },
        ),
      ),
    );

    await expect(fetchOpenItemNumbers(REPO, "test-token")).rejects.toThrow(/partial open set/);
  });

  it("surfaces a GitHub API error instead of treating it as an empty open set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));

    await expect(fetchOpenItemNumbers(REPO, "test-token")).rejects.toThrow(/403/);
  });
});

describe("backfill-issue-state: stale detection", () => {
  it("closes only the rows GitHub no longer lists as open", async () => {
    stubOpenListing([2, 4]);
    const { env, rows, updated, upserted } = mkEnv(openRows(5));

    const summary = await backfillIssueState(REPO, env, {});

    expect(summary.openOnGitHub).toBe(2);
    expect(summary.scanned).toBe(5);
    expect(summary.stale).toBe(3);
    expect(updated).toEqual(["i:1", "i:3", "i:5"]);
    expect(rows.filter((r) => r.state === "open").map((r) => r.number)).toEqual([2, 4]);
    expect(upserted.map((v) => v.id)).toEqual(["i:1", "i:3", "i:5"]);
    expect(upserted.every((v) => v.metadata.state === "closed")).toBe(true);
    // Only `state` moves; the rest of the metadata is carried through as-is.
    expect(upserted[0].metadata.repo).toBe(REPO);
  });

  it("writes nothing when every indexed open row is still open", async () => {
    stubOpenListing([1, 2, 3]);
    const { env, updated, upserted } = mkEnv(openRows(3));

    const summary = await backfillIssueState(REPO, env, {});

    expect(summary.stale).toBe(0);
    expect(updated).toEqual([]);
    expect(upserted).toEqual([]);
    expect(summary.done).toBe(true);
  });

  it("is idempotent — a second pass finds nothing left to do", async () => {
    stubOpenListing([2]);
    const { env, updated } = mkEnv(openRows(3));

    await backfillIssueState(REPO, env, {});
    stubOpenListing([2]);
    const second = await backfillIssueState(REPO, env, {});

    expect(second.stale).toBe(0);
    expect(updated).toEqual(["i:1", "i:3"]);
  });
});

describe("backfill-issue-state: dry run", () => {
  it("reports the stale count without writing to either side", async () => {
    stubOpenListing([2]);
    const { env, rows, updated, upserted } = mkEnv(openRows(4));

    const summary = await backfillIssueState(REPO, env, { dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.stale).toBe(3);
    expect(summary.ftsUpdated).toBe(0);
    expect(summary.vectorsUpdated).toBe(0);
    expect(updated).toEqual([]);
    expect(upserted).toEqual([]);
    expect(rows.every((r) => r.state === "open")).toBe(true);
  });
});

describe("backfill-issue-state: per-call budget", () => {
  it("caps the scan and hands back a resumable cursor", async () => {
    stubOpenListing([]);
    const { env } = mkEnv(openRows(7));

    const summary = await backfillIssueState(REPO, env, { limit: 3 });

    expect(summary.scanned).toBe(3);
    expect(summary.nextCursor).toBe(3);
    expect(summary.done).toBe(false);
  });

  it("drains the rest across calls when fed its own nextCursor", async () => {
    const { env, updated } = mkEnv(openRows(7));

    let cursor: number | null = 0;
    let calls = 0;
    while (cursor !== null) {
      stubOpenListing([]);
      const summary: Awaited<ReturnType<typeof backfillIssueState>> =
        await backfillIssueState(REPO, env, { limit: 3, cursor });
      cursor = summary.nextCursor;
      calls++;
    }

    expect(calls).toBe(3);
    expect(updated).toEqual(["i:1", "i:2", "i:3", "i:4", "i:5", "i:6", "i:7"]);
  });

  it("defaults the per-call budget to DEFAULT_ISSUE_STATE_LIMIT", async () => {
    stubOpenListing([]);
    const { env } = mkEnv(openRows(1));

    const summary = await backfillIssueState(REPO, env, {});

    expect(summary.limit).toBe(DEFAULT_ISSUE_STATE_LIMIT);
  });

  it("batches the Vectorize reads rather than one call per row", async () => {
    stubOpenListing([]);
    const { env, getBatchSizes } = mkEnv(openRows(120));

    await backfillIssueState(REPO, env, { limit: 200 });

    expect(getBatchSizes).toEqual([50, 50, 20]);
  });
});

describe("backfill-issue-state: partial index states", () => {
  it("counts a missing vector without letting it block the sparse repair", async () => {
    // A row with no vector is the issue #210 surface; its sparse half still exists
    // and is still wrong, so it gets fixed.
    stubOpenListing([]);
    const { env, updated, upserted } = mkEnv(openRows(3), { missingVectors: ["i:2"] });

    const summary = await backfillIssueState(REPO, env, {});

    expect(summary.vectorsMissing).toBe(1);
    expect(summary.vectorsUpdated).toBe(2);
    expect(upserted.map((v) => v.id)).toEqual(["i:1", "i:3"]);
    expect(updated).toEqual(["i:1", "i:2", "i:3"]);
  });

  it("leaves the sparse rows open when the dense write fails, so the retry re-covers them", async () => {
    stubOpenListing([]);
    const { env, rows, updated } = mkEnv(openRows(3), { vectorizeThrows: true });

    await expect(backfillIssueState(REPO, env, {})).rejects.toThrow(/vectorize down/);

    expect(updated).toEqual([]);
    expect(rows.every((r) => r.state === "open")).toBe(true);
  });
});
