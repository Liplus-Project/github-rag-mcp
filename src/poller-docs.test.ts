import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, DocRecord } from "./types.js";

// `pollDocs` fans out to the embed pipeline (Contents API + Workers AI +
// Vectorize + D1 + Store DO) and to the D1 FTS teardown helper. What is under
// test here is the *reap* — the delete fan-out and its per-run budget — so the
// embed entry point and the teardown helper are replaced with controllable
// fakes and only the Git Trees API call reaches the stubbed global fetch.
// `docVectorId` and the rest of `./pipeline.js` stay real.
const { processAndUpsertDocMock, deleteFtsRowMock } = vi.hoisted(() => ({
  processAndUpsertDocMock: vi.fn(),
  deleteFtsRowMock: vi.fn(),
}));

vi.mock("./pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pipeline.js")>();
  return { ...actual, processAndUpsertDoc: processAndUpsertDocMock };
});

vi.mock("./fts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fts.js")>();
  return { ...actual, deleteFtsRow: deleteFtsRowMock };
});

const { pollDocs } = await import("./poller.js");
const { docVectorId } = await import("./pipeline.js");

const REPO = "acme/widgets";
const WATERMARK_KEY = `docs:${REPO}`;
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/HEAD?recursive=1`;

/** Constant mirrored from `src/poller.ts`. */
const DELETE_BUDGET = 5;

/**
 * Stub the global fetch with a fake Git Trees API returning `paths` as blobs.
 *
 * `etag` is what the response carries; `expectNotModified` makes the stub assert
 * the conditional-request contract by returning 304 when the poller sends back
 * the matching `If-None-Match`.
 */
function stubTree(paths: string[], etag = 'W/"tree-1"') {
  const conditionalHits: string[] = [];

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== TREE_URL) {
      throw new Error(`unexpected fetch in docs stub: ${url}`);
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const sent = headers["If-None-Match"];
    if (sent) conditionalHits.push(sent);
    if (sent === etag) {
      return new Response(null, { status: 304 });
    }
    return new Response(
      JSON.stringify({
        sha: "treesha",
        truncated: false,
        tree: paths.map((path) => ({ path, type: "blob", sha: `blob-${path}` })),
      }),
      { status: 200, headers: { "Content-Type": "application/json", ETag: etag } },
    );
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, conditionalHits };
}

/**
 * In-memory IssueStore stand-in covering the docs surface: the record list the
 * poller diffs against, the docs watermark row holding the tree ETag, and the
 * per-path DELETE the reap issues.
 */
function makeDocStore(seed: DocRecord[] = [], etag?: string) {
  const records = new Map<string, DocRecord>(seed.map((d) => [d.path, d]));
  const watermarks = new Map<string, { lastPolledAt: string; etag?: string }>();
  if (etag !== undefined) {
    watermarks.set(WATERMARK_KEY, { lastPolledAt: "2026-08-01T00:00:00Z", etag });
  }
  const deletes: string[] = [];

  const stub = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === "/docs") {
        return Response.json([...records.values()]);
      }
      if (request.method === "GET" && path === "/watermark") {
        const key = url.searchParams.get("repo") ?? "";
        const wm = watermarks.get(key);
        if (!wm) return new Response("not found", { status: 404 });
        return Response.json({ repo: key, ...wm });
      }
      if (request.method === "POST" && path === "/watermark") {
        const body = (await request.json()) as {
          repo: string;
          lastPolledAt: string;
          etag?: string;
        };
        watermarks.set(body.repo, { lastPolledAt: body.lastPolledAt, etag: body.etag });
        return new Response("ok");
      }
      if (request.method === "DELETE" && path === "/doc") {
        const docPath = url.searchParams.get("path") ?? "";
        deletes.push(docPath);
        records.delete(docPath);
        return new Response("ok");
      }
      return new Response("ok");
    },
  };

  return {
    stub: stub as unknown as DurableObjectStub,
    records,
    deletes,
    etag: () => watermarks.get(WATERMARK_KEY)?.etag,
  };
}

function makeDocEnv() {
  const vectorDeletes: string[] = [];
  const deleteByIds = vi.fn(async (ids: string[]) => {
    vectorDeletes.push(...ids);
  });
  const env = {
    GITHUB_TOKEN: "test-token",
    VECTORIZE: { deleteByIds },
    DB_FTS: {} as unknown,
  } as unknown as Env;
  return { env, vectorDeletes };
}

/** A stored doc whose blob SHA matches what `stubTree` reports, so it is
 *  "unchanged" and never enters the embed path. */
const stored = (path: string): DocRecord => ({
  repo: REPO,
  path,
  blobSha: `blob-${path}`,
  updatedAt: "2026-08-01T00:00:00Z",
});

beforeEach(() => {
  processAndUpsertDocMock.mockReset();
  processAndUpsertDocMock.mockResolvedValue({ embedded: true, failed: false });
  deleteFtsRowMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("poller: pollDocs delete fan-out", () => {
  it("reaps only the doc absent from the tree, on all three surfaces", async () => {
    // One doc still in the store, gone from the tree. All three surfaces are
    // keyed to the same `docVectorId`, and the surviving doc is left alone.
    stubTree(["docs/keep.md"]);
    const store = makeDocStore([stored("docs/keep.md"), stored("docs/gone.md")]);
    const { env, vectorDeletes } = makeDocEnv();

    await pollDocs(REPO, env, store.stub);

    const goneId = await docVectorId(REPO, "docs/gone.md");

    expect(store.deletes).toEqual(["docs/gone.md"]);
    expect(vectorDeletes).toEqual([goneId]);
    expect(deleteFtsRowMock).toHaveBeenCalledTimes(1);
    expect(deleteFtsRowMock.mock.calls[0][1]).toBe(goneId);
    expect(store.records.has("docs/keep.md")).toBe(true);
  });

  it("keeps tearing down the later surfaces when Vectorize fails", async () => {
    // The surfaces are torn down independently. Pre-fix one outer try wrapped
    // the whole item, so a Vectorize failure skipped the store DELETE and left
    // the row behind — while the FTS5 row, guarded by its own inner try, was
    // already gone. The D1 rows are the ones users actually retrieve.
    stubTree(["docs/keep.md"]);
    const store = makeDocStore([stored("docs/keep.md"), stored("docs/gone.md")]);
    const { env } = makeDocEnv();
    (env.VECTORIZE.deleteByIds as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("vectorize down"),
    );

    await pollDocs(REPO, env, store.stub);

    expect(deleteFtsRowMock).toHaveBeenCalledTimes(1);
    expect(store.deletes).toEqual(["docs/gone.md"]);
  });

  it("keeps tearing down the store record when the FTS5 delete fails", async () => {
    stubTree(["docs/keep.md"]);
    const store = makeDocStore([stored("docs/keep.md"), stored("docs/gone.md")]);
    const { env, vectorDeletes } = makeDocEnv();
    deleteFtsRowMock.mockRejectedValue(new Error("d1 down"));

    await pollDocs(REPO, env, store.stub);

    expect(vectorDeletes).toHaveLength(1);
    expect(store.deletes).toEqual(["docs/gone.md"]);
  });

  it("leaves the reap alone when nothing was deleted", async () => {
    stubTree(["docs/keep.md"]);
    const store = makeDocStore([stored("docs/keep.md")]);
    const { env, vectorDeletes } = makeDocEnv();

    await pollDocs(REPO, env, store.stub);

    expect(store.deletes).toEqual([]);
    expect(vectorDeletes).toEqual([]);
    expect(deleteFtsRowMock).not.toHaveBeenCalled();
  });
});

describe("poller: pollDocs delete budget", () => {
  it("caps deletions per run and drains the rest on later runs", async () => {
    // The case that raised the issue: a single PR removed 66 `.md` files, all of
    // which land on the next run. Unbounded, that is 3 subrequests x 66 in one
    // LIGHT_CRON invocation shared with pollRepo and pollReleases (issue #203).
    const deletedPaths = Array.from(
      { length: DELETE_BUDGET * 2 + 1 },
      (_, i) => `docs/gone-${String(i).padStart(2, "0")}.md`,
    );
    const store = makeDocStore([stored("docs/keep.md"), ...deletedPaths.map(stored)]);
    const { env } = makeDocEnv();

    stubTree(["docs/keep.md"]);
    await pollDocs(REPO, env, store.stub);
    expect(store.deletes).toHaveLength(DELETE_BUDGET);

    // Monotonic drain: a reaped doc's store row is gone, so the leftover set
    // only shrinks. No path is reaped twice and none is skipped.
    stubTree(["docs/keep.md"]);
    await pollDocs(REPO, env, store.stub);
    expect(store.deletes).toHaveLength(DELETE_BUDGET * 2);

    stubTree(["docs/keep.md"]);
    await pollDocs(REPO, env, store.stub);
    expect(store.deletes).toHaveLength(deletedPaths.length);

    expect([...store.deletes].sort()).toEqual([...deletedPaths].sort());
    expect(new Set(store.deletes).size).toBe(deletedPaths.length);
    expect(store.records.has("docs/keep.md")).toBe(true);
    expect(store.records.size).toBe(1);
  });

  it("holds the tree ETag back while deletions are outstanding", async () => {
    // Advancing the ETag with a backlog left would make the next run answer 304
    // and return before it ever looks at `deletedDocs` — the drain would stall
    // until the tree happened to change again (issue #203).
    const deletedPaths = Array.from(
      { length: DELETE_BUDGET + 1 },
      (_, i) => `docs/gone-${i}.md`,
    );
    const store = makeDocStore([stored("docs/keep.md"), ...deletedPaths.map(stored)]);
    const { env } = makeDocEnv();

    stubTree(["docs/keep.md"]);
    await pollDocs(REPO, env, store.stub);
    expect(store.deletes).toHaveLength(DELETE_BUDGET);
    expect(store.etag()).toBeUndefined();

    // Next run: the poller sends no If-None-Match, so it sees the tree again and
    // reaps the leftover.
    const { conditionalHits } = stubTree(["docs/keep.md"]);
    await pollDocs(REPO, env, store.stub);
    expect(conditionalHits).toEqual([]);
    expect(store.deletes).toHaveLength(deletedPaths.length);

    // Backlog cleared — now the ETag is allowed to advance.
    expect(store.etag()).toBe('W/"tree-1"');
  });

  it("advances the tree ETag when the reap finished inside its budget", async () => {
    stubTree(["docs/keep.md"]);
    const store = makeDocStore([stored("docs/keep.md"), stored("docs/gone.md")]);
    const { env } = makeDocEnv();

    await pollDocs(REPO, env, store.stub);

    expect(store.deletes).toEqual(["docs/gone.md"]);
    expect(store.etag()).toBe('W/"tree-1"');
  });
});
