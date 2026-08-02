import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "./types.js";

// `handlePushEvent` fans out to the embed pipeline, the commit-diff pipeline,
// Vectorize, and the D1 FTS teardown helper. What is under test here is the
// *doc delete* fan-out, so the FTS teardown helper is replaced with a
// controllable fake and Vectorize / the Store DO get in-memory stand-ins.
// `docVectorId` and the rest of `./pipeline.js` stay real. The payloads below
// carry commits without an `id`, so the diff-indexing branch short-circuits and
// no HTTP call is made — global fetch is deliberately left unstubbed, and a
// test that started making one would fail loudly rather than hit the network.
const { deleteFtsRowMock } = vi.hoisted(() => ({ deleteFtsRowMock: vi.fn() }));

vi.mock("./fts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fts.js")>();
  return { ...actual, deleteFtsRow: deleteFtsRowMock };
});

const { handlePushEvent } = await import("./webhook.js");
const { docVectorId } = await import("./pipeline.js");

const REPO = "acme/widgets";

/** A default-branch push whose commits only remove files. `id` is omitted so
 *  the per-commit diff indexing branch is skipped. */
function pushPayload(removed: string[]): Record<string, unknown> {
  return {
    repository: { full_name: REPO, default_branch: "main" },
    ref: "refs/heads/main",
    head_commit: { id: "headsha" },
    commits: [{ added: [], modified: [], removed }],
  };
}

/** In-memory IssueStore stand-in covering the per-path DELETE the reap issues. */
function makeDocStore() {
  const deletes: string[] = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "DELETE" && url.pathname === "/doc") {
        deletes.push(url.searchParams.get("path") ?? "");
        return new Response("ok");
      }
      return new Response("ok");
    },
  };
  return { stub: stub as unknown as DurableObjectStub, deletes };
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

/** Read back the `docs` block of the 202 the handler returns. */
async function docsResult(response: Response) {
  const body = (await response.json()) as {
    docs: { removed: number; deleted: number; failed: number };
  };
  return body.docs;
}

beforeEach(() => {
  deleteFtsRowMock.mockReset().mockResolvedValue(undefined);
});

describe("webhook: push doc delete fan-out", () => {
  it("tears down all three surfaces for a removed doc", async () => {
    const store = makeDocStore();
    const { env, vectorDeletes } = makeDocEnv();

    const res = await handlePushEvent(pushPayload(["docs/gone.md"]), env, store.stub);

    const goneId = await docVectorId(REPO, "docs/gone.md");
    expect(vectorDeletes).toEqual([goneId]);
    expect(deleteFtsRowMock).toHaveBeenCalledTimes(1);
    expect(deleteFtsRowMock.mock.calls[0][1]).toBe(goneId);
    expect(store.deletes).toEqual(["docs/gone.md"]);
    expect(await docsResult(res)).toMatchObject({ removed: 1, deleted: 1 });
  });

  it("keeps tearing down the later surfaces when Vectorize fails", async () => {
    // The defect this issue was filed on: one outer try wrapped the whole item,
    // so a Vectorize throw jumped straight to the catch and neither the FTS5
    // row nor the store row was ever touched. The D1 rows are the ones users
    // actually retrieve, so the stale doc kept coming back in search results.
    const store = makeDocStore();
    const { env } = makeDocEnv();
    (env.VECTORIZE.deleteByIds as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("vectorize down"),
    );

    const res = await handlePushEvent(pushPayload(["docs/gone.md"]), env, store.stub);

    expect(deleteFtsRowMock).toHaveBeenCalledTimes(1);
    expect(store.deletes).toEqual(["docs/gone.md"]);
    // `deleted` counts docs whose three surfaces all came down, so a partial
    // teardown is visible as `removed > deleted` in the delivery-log body.
    // The cron reap counts attempts instead; see the comment on the loop.
    expect(await docsResult(res)).toMatchObject({ removed: 1, deleted: 0 });
  });

  it("keeps tearing down the store record when the FTS5 delete fails", async () => {
    const store = makeDocStore();
    const { env, vectorDeletes } = makeDocEnv();
    deleteFtsRowMock.mockRejectedValue(new Error("d1 down"));

    const res = await handlePushEvent(pushPayload(["docs/gone.md"]), env, store.stub);

    expect(vectorDeletes).toHaveLength(1);
    expect(store.deletes).toEqual(["docs/gone.md"]);
    expect(await docsResult(res)).toMatchObject({ removed: 1, deleted: 0 });
  });

  it("keeps tearing down the other surfaces when the store DELETE fails", async () => {
    const { env, vectorDeletes } = makeDocEnv();
    const stub = {
      async fetch(): Promise<Response> {
        throw new Error("store down");
      },
    } as unknown as DurableObjectStub;

    const res = await handlePushEvent(pushPayload(["docs/gone.md"]), env, stub);

    expect(vectorDeletes).toHaveLength(1);
    expect(deleteFtsRowMock).toHaveBeenCalledTimes(1);
    expect(await docsResult(res)).toMatchObject({ removed: 1, deleted: 0 });
  });

  it("keeps reaping later docs after one of them fails", async () => {
    // One failing surface must not abort the loop for the rest of the push.
    const store = makeDocStore();
    const { env, vectorDeletes } = makeDocEnv();
    const firstId = await docVectorId(REPO, "docs/a.md");
    (env.VECTORIZE.deleteByIds as ReturnType<typeof vi.fn>).mockImplementation(
      async (ids: string[]) => {
        if (ids[0] === firstId) throw new Error("vectorize down");
        vectorDeletes.push(...ids);
      },
    );

    const res = await handlePushEvent(
      pushPayload(["docs/a.md", "docs/b.md"]),
      env,
      store.stub,
    );

    expect(store.deletes).toEqual(["docs/a.md", "docs/b.md"]);
    expect(vectorDeletes).toEqual([await docVectorId(REPO, "docs/b.md")]);
    expect(await docsResult(res)).toMatchObject({ removed: 2, deleted: 1 });
  });

  it("leaves the reap alone when the push removed no docs", async () => {
    const store = makeDocStore();
    const { env, vectorDeletes } = makeDocEnv();

    await handlePushEvent(pushPayload(["src/main.ts"]), env, store.stub);

    expect(store.deletes).toEqual([]);
    expect(vectorDeletes).toEqual([]);
    expect(deleteFtsRowMock).not.toHaveBeenCalled();
  });
});
