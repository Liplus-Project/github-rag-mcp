import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, WikiDocRecord } from "./types.js";

// `pollWiki` fans out to the embed pipeline (Workers AI + Vectorize + D1 + Store
// DO) and to the two D1 teardown helpers. Everything under test here is upstream
// of that fan-out — page enumeration, the resume cursor, the fetch budget and
// the orphan reap — so those four entry points are replaced with controllable
// fakes and only the *wiki HTTP surface* reaches the stubbed global fetch.
// `sha256Hex` and the rest of `./pipeline.js` stay real.
const {
  processAndUpsertWikiDocMock,
  deleteFtsRowMock,
  deleteEdgesForVectorMock,
} = vi.hoisted(() => ({
  processAndUpsertWikiDocMock: vi.fn(),
  deleteFtsRowMock: vi.fn(),
  deleteEdgesForVectorMock: vi.fn(),
}));

vi.mock("./pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pipeline.js")>();
  return { ...actual, processAndUpsertWikiDoc: processAndUpsertWikiDocMock };
});

vi.mock("./fts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fts.js")>();
  return { ...actual, deleteFtsRow: deleteFtsRowMock };
});

vi.mock("./graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph.js")>();
  return { ...actual, deleteEdgesForVector: deleteEdgesForVectorMock };
});

const { pollWiki } = await import("./poller.js");
const { sha256Hex } = await import("./pipeline.js");

const REPO = "acme/widgets";
const CURSOR_KEY = `wiki:${REPO}`;
const LAP_KEY = `wiki-lap:${REPO}`;
const RAW_PREFIX = `https://raw.githubusercontent.com/wiki/${REPO}/`;

/** A page as the `_pages` index renders it: routed slug + displayed title. */
interface FakeWikiPage {
  slug: string;
  /** Link text. Defaults to the slug with dashes turned back into spaces. */
  title?: string;
}

interface FakeWiki {
  listed: FakeWikiPage[];
  /** Raw filename stem (no extension) -> markdown body, as the wiki git repo holds it. */
  files: Record<string, string>;
  /** Simulate an unreadable `/wiki/_pages` (non-200). */
  indexFails?: boolean;
}

/**
 * Stub the global fetch with a fake GitHub wiki: the `.wiki.git` existence
 * probe, the `_pages` HTML index, and raw.githubusercontent content.
 *
 * `rawRequests` records every raw-content URL the poller issued — the fetch
 * budget and the per-page candidate fan-out are both asserted against it.
 */
function stubWiki(wiki: FakeWiki) {
  const rawRequests: string[] = [];

  const pagesHtml = [
    // GitHub's own UI links live in the same index and share the underscore
    // convention. They must never cost a raw fetch.
    `<div><a href="/${REPO}/wiki/_new">New Page</a></div>`,
    `<div><a href="/${REPO}/wiki/_Sidebar">Sidebar</a></div>`,
    ...wiki.listed.map(
      (p) =>
        `<div class="flex-auto"><a href="/${REPO}/wiki/${p.slug}">` +
        `${p.title ?? p.slug.replace(/-/g, " ")}</a></div>`,
    ),
  ].join("\n");

  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);

    if (url.includes(".wiki.git/info/refs")) {
      return new Response("001e# service=git-upload-pack\n", { status: 200 });
    }

    if (url.endsWith("/wiki/_pages")) {
      if (wiki.indexFails) return new Response("boom", { status: 503 });
      return new Response(pagesHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.startsWith(RAW_PREFIX)) {
      rawRequests.push(url);
      const tail = url.slice(RAW_PREFIX.length);
      const dot = tail.lastIndexOf(".");
      const name = decodeURIComponent(tail.slice(0, dot));
      const ext = tail.slice(dot + 1);
      const body = wiki.files[name];
      if (ext !== "md" || body === undefined) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(body, { status: 200 });
    }

    throw new Error(`unexpected fetch in wiki stub: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  /** Raw filename stems requested, in call order. */
  const requestedNames = (): string[] =>
    rawRequests.map((u) => {
      const tail = u.slice(RAW_PREFIX.length);
      return decodeURIComponent(tail.slice(0, tail.lastIndexOf(".")));
    });

  return { rawRequests, requestedNames };
}

/**
 * In-memory IssueStore stand-in covering the wiki surface: the record list the
 * poller diffs against, the watermark row holding the resume cursor, and the
 * per-page DELETE the reap issues.
 */
function makeWikiStore(seed: WikiDocRecord[] = [], cursor?: string, lapAnchor?: string) {
  const records = new Map<string, WikiDocRecord>(seed.map((w) => [w.pageName, w]));
  const watermarks = new Map<string, { lastPolledAt: string; etag: string }>();
  if (cursor !== undefined) {
    watermarks.set(CURSOR_KEY, { lastPolledAt: "2026-07-31T00:00:00Z", etag: cursor });
  }
  if (lapAnchor !== undefined) {
    watermarks.set(LAP_KEY, { lastPolledAt: "2026-07-31T00:00:00Z", etag: lapAnchor });
  }
  const deletes: string[] = [];

  const stub = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === "/wiki-docs") {
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
        watermarks.set(body.repo, {
          lastPolledAt: body.lastPolledAt,
          etag: body.etag ?? "",
        });
        return new Response("ok");
      }
      if (request.method === "DELETE" && path === "/wiki-doc") {
        const page = url.searchParams.get("page") ?? "";
        deletes.push(page);
        records.delete(page);
        return new Response("ok");
      }
      return new Response("ok");
    },
  };

  return {
    stub: stub as unknown as DurableObjectStub,
    records,
    deletes,
    cursor: () => watermarks.get(CURSOR_KEY)?.etag ?? "",
    lapAnchor: () => watermarks.get(LAP_KEY)?.etag,
  };
}

/** Env whose D1 reports `indexed` as the live wiki_doc rows in search_docs. */
function makeWikiEnv(indexed: string[] = []) {
  const vectorDeletes: string[] = [];
  const deleteByIds = vi.fn(async (ids: string[]) => {
    vectorDeletes.push(...ids);
  });
  const env = {
    GITHUB_TOKEN: "test-token",
    VECTORIZE: { deleteByIds },
    DB_FTS: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: indexed.map((p) => ({ doc_path: p })) }),
        }),
      }),
    },
  } as unknown as Env;
  return { env, vectorDeletes, deleteByIds };
}

/** Slugs the run handed to the embed pipeline. */
const embeddedSlugs = (): string[] =>
  processAndUpsertWikiDocMock.mock.calls.map((call) => String(call[3]));

beforeEach(() => {
  processAndUpsertWikiDocMock.mockReset();
  processAndUpsertWikiDocMock.mockResolvedValue({
    embedded: true,
    skippedUnchanged: false,
    metadataUpdated: false,
    failed: false,
  });
  deleteFtsRowMock.mockReset().mockResolvedValue(undefined);
  deleteEdgesForVectorMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("poller: pollWiki page coverage", () => {
  it("reaches every page across runs instead of restarting at the head", async () => {
    // 50 pages, 20 fetches per run: the pre-fix poller walked pages 1..20 on
    // every run and never reached page 21. Three runs must cover all of them.
    const slugs = Array.from({ length: 50 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const wiki: FakeWiki = {
      listed: slugs.map((slug) => ({ slug, title: slug })),
      files: Object.fromEntries([...slugs, "Home"].map((s) => [s, `body of ${s}`])),
    };

    const seen = new Set<string>();
    const store = makeWikiStore();
    const { env } = makeWikiEnv();

    for (let run = 0; run < 3; run++) {
      const { requestedNames } = stubWiki(wiki);
      const summary = await pollWiki(REPO, env, store.stub);

      expect(summary.fetches).toBeLessThanOrEqual(20);
      for (const name of requestedNames()) seen.add(name);
      vi.unstubAllGlobals();
    }

    // 50 listed pages + Home, which `_pages` never lists.
    expect(seen.size).toBe(51);
    for (const slug of [...slugs, "Home"]) expect(seen.has(slug)).toBe(true);
  });

  it("persists the resume cursor and continues past it", async () => {
    const slugs = ["a", "b", "c", "d", "e", "f"];
    const wiki: FakeWiki = {
      listed: slugs.map((slug) => ({ slug, title: slug })),
      files: Object.fromEntries([...slugs, "Home"].map((s) => [s, `body ${s}`])),
    };
    const store = makeWikiStore();
    const { env } = makeWikiEnv();

    stubWiki(wiki);
    const first = await pollWiki(REPO, env, store.stub, { fetchBudget: 3 });
    vi.unstubAllGlobals();

    expect(first.visited).toBe(3);
    expect(first.wrapped).toBe(false);
    expect(store.cursor()).toBe(first.nextCursor);

    const { requestedNames } = stubWiki(wiki);
    const second = await pollWiki(REPO, env, store.stub, { fetchBudget: 3 });

    expect(second.startCursor).toBe(first.nextCursor);
    expect(requestedNames()).not.toContain(first.nextCursor);
  });

  it("wraps to the head when the cursor sits past the last page", async () => {
    const wiki: FakeWiki = {
      listed: [{ slug: "a" }, { slug: "b" }],
      files: { a: "a", b: "b", Home: "h" },
    };
    const store = makeWikiStore([], "zzz");
    const { env } = makeWikiEnv();
    const { requestedNames } = stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub, { fetchBudget: 10 });

    expect(summary.wrapped).toBe(true);
    expect(requestedNames().sort()).toEqual(["Home", "a", "b"]);
  });

  it("never spends a fetch on GitHub's underscore UI links", async () => {
    const wiki: FakeWiki = {
      listed: [{ slug: "real-page" }],
      files: { "real page": "x", "real-page": "x", Home: "h" },
    };
    const store = makeWikiStore();
    const { env } = makeWikiEnv();
    const { requestedNames } = stubWiki(wiki);

    await pollWiki(REPO, env, store.stub);

    expect(requestedNames().some((n) => n.startsWith("_"))).toBe(false);
    expect(embeddedSlugs()).not.toContain("_new");
  });

  it("indexes Home even though _pages omits it", async () => {
    const wiki: FakeWiki = {
      listed: [{ slug: "other" }],
      files: { other: "o", Home: "home body" },
    };
    const store = makeWikiStore();
    const { env } = makeWikiEnv();
    stubWiki(wiki);

    await pollWiki(REPO, env, store.stub);

    expect(embeddedSlugs()).toContain("Home");
  });

  it("indexes a page whose slug lost a character to routing", async () => {
    // GitHub routes `E. Li+language` to the slug `E.-Li-language`, but the wiki
    // git repo holds `E.-Li+language.md`. Building the raw URL from the slug
    // 404s forever; the link text carries the only recoverable filename.
    const wiki: FakeWiki = {
      listed: [{ slug: "E.-Li-language", title: "E. Li+language" }],
      files: { "E.-Li+language": "spec body", Home: "h" },
    };
    const store = makeWikiStore();
    const { env } = makeWikiEnv();
    const { requestedNames } = stubWiki(wiki);

    await pollWiki(REPO, env, store.stub);

    expect(requestedNames()).toContain("E.-Li+language");
    // Identity stays the slug: vector ID, store key and wiki URL all key on it.
    expect(embeddedSlugs()).toContain("E.-Li-language");
  });

  it("holds the fetch budget even when every page needs a second candidate", async () => {
    const slugs = Array.from({ length: 30 }, (_, i) => `page-${i}`);
    const wiki: FakeWiki = {
      // Title differs from the slug on every page, so each page costs a miss
      // before the slug-named file resolves.
      listed: slugs.map((slug) => ({ slug, title: `T ${slug}` })),
      files: Object.fromEntries([...slugs, "Home"].map((s) => [s, `b ${s}`])),
    };
    const store = makeWikiStore();
    const { env } = makeWikiEnv();
    const { rawRequests } = stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub);

    expect(summary.fetches).toBeLessThanOrEqual(20);
    expect(rawRequests.length).toBeLessThanOrEqual(20);
  });

  it("skips a page whose content hash is unchanged", async () => {
    const body = "stable body";
    const wiki: FakeWiki = {
      listed: [{ slug: "kept" }],
      files: { kept: body, Home: "h" },
    };
    const store = makeWikiStore([
      {
        repo: REPO,
        pageName: "kept",
        extension: "md",
        contentHash: await sha256Hex(body),
        updatedAt: "2026-07-01T00:00:00Z",
      },
    ]);
    const { env } = makeWikiEnv();
    stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub);

    expect(summary.skipped).toBe(1);
    expect(embeddedSlugs()).not.toContain("kept");
  });
});

describe("poller: pollWiki lap completion", () => {
  /** 7 listed pages + the unlisted `Home` = 8, sorted `Home, p0..p6`. */
  const lapWiki = (): FakeWiki => {
    const slugs = Array.from({ length: 7 }, (_, i) => `p${i}`);
    return {
      listed: slugs.map((slug) => ({ slug, title: slug })),
      files: Object.fromEntries([...slugs, "Home"].map((s) => [s, `body ${s}`])),
    };
  };

  it("completes a lap across passes when pages exceed the fetch budget", async () => {
    // The bug: `wrapped` meant "this single pass saw every page", so a wiki
    // with more pages than the per-pass budget could never set it and the
    // documented "call until done" loop never terminated (issue #188).
    const wiki = lapWiki();
    const store = makeWikiStore();
    const { env } = makeWikiEnv();

    const run = async () => {
      stubWiki(wiki);
      const summary = await pollWiki(REPO, env, store.stub, { fetchBudget: 3 });
      vi.unstubAllGlobals();
      return summary;
    };

    // 8 pages / 3 fetches per pass: the lap must close on the third call.
    const first = await run();
    expect(first.pages).toBe(8);
    expect(first.fetches).toBeLessThanOrEqual(3);
    expect(first.wrapped).toBe(false);

    const second = await run();
    expect(second.wrapped).toBe(false);

    const third = await run();
    expect(third.wrapped).toBe(true);
  });

  it("keeps the lap anchor across passes and re-anchors once the lap closes", async () => {
    const wiki = lapWiki();
    const store = makeWikiStore();
    const { env } = makeWikiEnv();

    stubWiki(wiki);
    const first = await pollWiki(REPO, env, store.stub, { fetchBudget: 3 });
    vi.unstubAllGlobals();

    // The first pass anchors the lap at the head and does not move it.
    expect(first.lapAnchor).toBe("");
    expect(store.lapAnchor()).toBe("");
    expect(first.nextCursor).not.toBe("");

    stubWiki(wiki);
    const second = await pollWiki(REPO, env, store.stub, { fetchBudget: 3 });
    vi.unstubAllGlobals();

    expect(second.lapAnchor).toBe("");
    expect(second.startCursor).toBe(first.nextCursor);

    stubWiki(wiki);
    const third = await pollWiki(REPO, env, store.stub, { fetchBudget: 3 });
    vi.unstubAllGlobals();

    // Lap closed on the page before the anchor — `p6`, the last in slug order.
    expect(third.wrapped).toBe(true);
    expect(store.lapAnchor()).toBe("p6");
  });

  it("does not report a lap the cron already walked most of", async () => {
    // A pass that happens to start one page before the lap's final page must
    // not be read as "everything is covered": the anchor, not the pass, owns
    // the verdict.
    const wiki = lapWiki();
    const store = makeWikiStore([], "p4", "p4");
    const { env } = makeWikiEnv();
    stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub, { fetchBudget: 2 });

    expect(summary.lapAnchor).toBe("p4");
    // Lap runs p5, p6, Home, p0..p4; this pass only reaches p5 and p6.
    expect(summary.wrapped).toBe(false);
  });

  it("opens a fresh lap when an explicit cursor overrides the stored one", async () => {
    const wiki = lapWiki();
    const store = makeWikiStore([], "p6", "p4");
    const { env } = makeWikiEnv();
    stubWiki(wiki);

    // `cursor=` (empty) is the documented "restart from the head" call; it must
    // restart the lap too, otherwise the very next pass would report a lap the
    // walk never made.
    const summary = await pollWiki(REPO, env, store.stub, { fetchBudget: 2, cursor: "" });

    expect(summary.startCursor).toBe("");
    expect(summary.lapAnchor).toBe("");
    expect(summary.wrapped).toBe(false);
    expect(store.lapAnchor()).toBe("");
  });
});

describe("poller: pollWiki budget below one page's candidate count", () => {
  /** 3 listed pages whose title differs from the slug, so each costs a miss on
   *  the title-derived name before the slug-named file resolves. Plus the
   *  unlisted `Home`, which resolves on its first candidate. Slug order is
   *  `Home, p1, p2, p3` (comparison is case-insensitive). */
  const twoCandidateWiki = (): FakeWiki => ({
    listed: [1, 2, 3].map((i) => ({ slug: `p${i}`, title: `T p${i}` })),
    files: { p1: "b1", p2: "b2", p3: "b3", Home: "h" },
  });

  it("advances the cursor when the budget is smaller than the first page's candidate list", async () => {
    // The stall: the walk breaks *before* `visited++` when the budget runs out
    // mid-probe (issue #185), so a budget under one page's candidate count left
    // the cursor untouched and every later call re-probed the same page
    // (issue #192). Only the first page of a pass may overspend, and only far
    // enough to observe its own candidate list.
    const wiki = twoCandidateWiki();
    const store = makeWikiStore([], "Home");
    const { env } = makeWikiEnv();

    const cursors: string[] = [];
    for (let pass = 0; pass < 3; pass++) {
      stubWiki(wiki);
      const summary = await pollWiki(REPO, env, store.stub, { fetchBudget: 1 });
      vi.unstubAllGlobals();

      expect(summary.startCursor).not.toBe(summary.nextCursor);
      expect(summary.visited).toBe(1);
      // Two candidates observed: the title-derived miss and the slug-named hit.
      expect(summary.fetches).toBe(2);
      cursors.push(summary.nextCursor);
    }

    expect(cursors).toEqual(["p1", "p2", "p3"]);
    expect(embeddedSlugs()).toEqual(["p1", "p2", "p3"]);
  });

  it("records the failure once the whole candidate list has 404ed", async () => {
    // Exempting the first page from the budget must not resurrect the failure
    // #185 removed: the miss is only counted because every candidate was
    // actually observed, which is also what lets the cursor move past it.
    const wiki: FakeWiki = {
      listed: [{ slug: "p1", title: "T p1" }],
      files: { Home: "h" },
    };
    const store = makeWikiStore([], "Home");
    const { env } = makeWikiEnv();
    const { rawRequests } = stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub, { fetchBudget: 1 });

    // 2 filename candidates x 2 extensions, all 404.
    expect(rawRequests.length).toBe(4);
    expect(summary.fetches).toBe(4);
    expect(summary.failed).toBe(1);
    expect(summary.nextCursor).toBe("p1");
  });

  it("holds the budget for every page after the first", async () => {
    // The exemption is scoped to `visited === 0`. Once a page has been visited,
    // a probe that the budget truncates still breaks before `visited++`, so no
    // unobserved failure is recorded and the pass cannot overspend.
    const wiki = twoCandidateWiki();
    const store = makeWikiStore();
    const { env } = makeWikiEnv();
    const { rawRequests } = stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub, { fetchBudget: 2 });

    // `Home` resolves on its single candidate; `p1` gets one attempt and is
    // abandoned mid-list.
    expect(summary.fetches).toBe(2);
    expect(rawRequests.length).toBe(2);
    expect(summary.visited).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.nextCursor).toBe("Home");
  });
});

describe("poller: pollWiki orphan reap", () => {
  it("reaps a page that survives in the index but not in the store", async () => {
    // The production failure: the store row was gone, so the store-only diff
    // saw nothing to delete and the search_docs / Vectorize / edge rows for a
    // renamed-away page stayed resolvable for months.
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: { current: "c", Home: "h" },
    };
    const store = makeWikiStore(); // store knows nothing
    const { env, vectorDeletes } = makeWikiEnv(["current", "renamed-away"]);
    stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub);

    expect(summary.removed).toBe(1);
    expect(vectorDeletes).toHaveLength(1);
    expect(deleteFtsRowMock).toHaveBeenCalledTimes(1);
    expect(deleteEdgesForVectorMock).toHaveBeenCalledTimes(1);
    expect(store.deletes).toEqual(["renamed-away"]);
  });

  it("still reaps a store-only orphan", async () => {
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: { current: "c", Home: "h" },
    };
    const store = makeWikiStore([
      {
        repo: REPO,
        pageName: "stale",
        extension: "md",
        contentHash: "h",
        updatedAt: "2026-05-01T00:00:00Z",
      },
    ]);
    const { env } = makeWikiEnv([]);
    stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub);

    expect(summary.removed).toBe(1);
    expect(store.deletes).toEqual(["stale"]);
  });

  it("tears down the D1 rows even when the Vectorize delete throws", async () => {
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: { current: "c", Home: "h" },
    };
    const store = makeWikiStore();
    const { env, deleteByIds } = makeWikiEnv(["orphan"]);
    deleteByIds.mockRejectedValue(new Error("vectorize outage"));
    stubWiki(wiki);

    await pollWiki(REPO, env, store.stub);

    expect(deleteFtsRowMock).toHaveBeenCalledTimes(1);
    expect(store.deletes).toEqual(["orphan"]);
  });

  it("caps reaps per run and defers the rest", async () => {
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: { current: "c", Home: "h" },
    };
    const store = makeWikiStore();
    const orphans = Array.from({ length: 9 }, (_, i) => `orphan-${i}`);
    const { env } = makeWikiEnv(["current", ...orphans]);
    stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub);

    expect(summary.removed).toBe(5);
    expect(summary.orphansDeferred).toBe(4);
  });

  it("withholds the reap for a page the short enumeration dropped", async () => {
    // The partial-enumeration failure (issue #187): `_pages` came back missing
    // `live-page`, but the page is still there. A set-level diff cannot see the
    // difference between that and a real deletion, so the guard addresses the
    // page itself — its content still serves, so the delete is withheld.
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: { current: "c", Home: "h", "live-page": "still here" },
    };
    const store = makeWikiStore([
      {
        repo: REPO,
        pageName: "live-page",
        extension: "md",
        contentHash: "h",
        updatedAt: "2026-05-01T00:00:00Z",
      },
    ]);
    const { env, vectorDeletes } = makeWikiEnv(["current", "live-page"]);
    stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub);

    expect(summary.removed).toBe(0);
    expect(summary.orphansWithheld).toBe(1);
    expect(vectorDeletes).toEqual([]);
    expect(deleteFtsRowMock).not.toHaveBeenCalled();
    expect(deleteEdgesForVectorMock).not.toHaveBeenCalled();
    expect(store.deletes).toEqual([]);
    expect(store.records.has("live-page")).toBe(true);
  });

  it("reaps the genuinely deleted page in the same run it withholds a live one", async () => {
    // The guard must not degrade into "stop reaping when anything looks off":
    // the verdict is per page, so a real deletion still drains while a live
    // page in the same candidate set is spared.
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: { current: "c", Home: "h", "live-page": "still here" },
    };
    const store = makeWikiStore();
    const { env } = makeWikiEnv(["current", "live-page", "really-deleted"]);
    stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub);

    expect(summary.removed).toBe(1);
    expect(summary.orphansWithheld).toBe(1);
    expect(store.deletes).toEqual(["really-deleted"]);
  });

  it("withholds the reap when the existence probe cannot conclude", async () => {
    // A 5xx is not evidence of deletion. Withholding costs one deferred run;
    // deleting on it costs a live page.
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: { current: "c", Home: "h" },
    };
    const store = makeWikiStore();
    const { env, vectorDeletes } = makeWikiEnv(["current", "unreachable"]);
    stubWiki(wiki);

    const inner = globalThis.fetch as unknown as (input: string | URL) => Promise<Response>;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith(`${RAW_PREFIX}unreachable.`)) {
        return new Response("upstream error", { status: 503 });
      }
      return inner(input);
    });

    const summary = await pollWiki(REPO, env, store.stub);

    expect(summary.removed).toBe(0);
    expect(summary.orphansWithheld).toBe(1);
    expect(vectorDeletes).toEqual([]);
    expect(store.deletes).toEqual([]);
  });

  it("keeps the probe off the walk's fetch budget and bounds its cost", async () => {
    // The guard's ceiling is delete budget x extension count, spent outside the
    // walk. `fetches` must still report only what the walk itself issued.
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: { current: "c", Home: "h" },
    };
    const store = makeWikiStore();
    const orphans = Array.from({ length: 9 }, (_, i) => `orphan-${i}`);
    const { env } = makeWikiEnv(["current", ...orphans]);
    const { rawRequests } = stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub, { fetchBudget: 4 });

    expect(summary.fetches).toBeLessThanOrEqual(4);
    expect(summary.removed).toBe(5);
    // 4 walk attempts + 5 reaped candidates probed across `md` and `markdown`.
    expect(rawRequests.length).toBeLessThanOrEqual(4 + 5 * 2);
  });

  it("reaps a deleted page sitting behind a run of withheld candidates", async () => {
    // Issue #197: a withheld candidate used to spend a delete slot. The orphan
    // list is stably sorted, so five withheld heads filled the whole budget on
    // every run and the page that really was deleted, ordering after them, was
    // never even looked at until the enumeration recovered.
    const live = Array.from({ length: 5 }, (_, i) => `a-live-${i}`);
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: {
        current: "c",
        Home: "h",
        // Present in the wiki but missing from `_pages`: the short enumeration.
        ...Object.fromEntries(live.map((p) => [p, "still here"])),
      },
    };
    const store = makeWikiStore();
    const { env } = makeWikiEnv(["current", ...live, "z-really-deleted"]);
    stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub);

    expect(summary.orphansWithheld).toBe(5);
    expect(summary.removed).toBe(1);
    expect(store.deletes).toEqual(["z-really-deleted"]);
    // All six candidates were reached, so nothing was deferred.
    expect(summary.orphansDeferred).toBe(0);
  });

  it("caps the probes per run and defers the candidates it never reached", async () => {
    // The probe budget is what keeps "walk the whole orphan list" bounded: 20
    // live candidates, none of them deletable, must not cost 20 probes.
    const live = Array.from({ length: 20 }, (_, i) => `live-${String(i).padStart(2, "0")}`);
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: {
        current: "c",
        Home: "h",
        ...Object.fromEntries(live.map((p) => [p, "still here"])),
      },
    };
    const store = makeWikiStore();
    const { env } = makeWikiEnv(["current", ...live]);
    const { requestedNames } = stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub);

    // MAX_WIKI_REAP_PROBES_PER_REPO_PER_RUN = 15. Each live candidate answers
    // 200 on its first extension, so one probe is one raw request here.
    const probed = requestedNames().filter((n) => n.startsWith("live-"));
    expect(probed).toHaveLength(15);
    expect(summary.orphansWithheld).toBe(15);
    expect(summary.removed).toBe(0);
    // Deferred = candidates this run never reached, not "past the delete cap".
    expect(summary.orphansDeferred).toBe(5);
  });

  it("reaps nothing when the page index could not be read", async () => {
    // An unreadable `_pages` yields an empty slug set. Treating that as "every
    // page was deleted" would wipe the repo's entire wiki index.
    const wiki: FakeWiki = {
      listed: [{ slug: "current" }],
      files: { current: "c" },
      indexFails: true,
    };
    const store = makeWikiStore([
      {
        repo: REPO,
        pageName: "current",
        extension: "md",
        contentHash: "h",
        updatedAt: "2026-05-01T00:00:00Z",
      },
    ]);
    const { env, vectorDeletes } = makeWikiEnv(["current"]);
    stubWiki(wiki);

    const summary = await pollWiki(REPO, env, store.stub);

    expect(summary.enumerated).toBe(false);
    expect(summary.removed).toBe(0);
    expect(vectorDeletes).toEqual([]);
    expect(store.deletes).toEqual([]);
  });
});
