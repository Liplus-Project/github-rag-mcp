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

// ── Run-wide subrequest budget (issue #248) ──────────────────

const {
  runWikiSurfaces,
  wikiFetchBudgetForPass,
  rotateReposForRun,
  isSubrequestExhaustion,
} = await import("./poller.js");

/** `MAX_WIKI_FETCHES_PER_REPO_PER_RUN`, mirrored: the constant is module-private
 *  and what these assertions are about is the run budget outranking it. */
const PER_REPO_FETCH_CAP = 20;

/**
 * Stub the global fetch with several fake wikis at once.
 *
 * The single-repo `stubWiki` above keys everything off the `REPO` constant, and
 * the defect this suite covers is only visible across repos: every per-repo
 * budget holds while their sum overruns the invocation ceiling.
 *
 * `throwAfter` makes `fetch()` raise rather than answer once that many raw
 * requests have been issued, so the walk's classification of an *unobserved*
 * miss can be asserted. `throwMessage` picks which kind: the default is an
 * ordinary network blip, and passing the subrequest-exhaustion text reproduces
 * the production failure shape, which the poller must treat differently — one
 * is this page's problem, the other is the whole run's.
 */
function stubMultiWiki(
  wikis: Record<string, FakeWiki>,
  opts: { throwAfter?: number; throwMessage?: string } = {},
) {
  const rawByRepo = new Map<string, string[]>();
  let rawCount = 0;

  const pagesHtmlFor = (repo: string, wiki: FakeWiki): string =>
    wiki.listed
      .map(
        (p) =>
          `<div class="flex-auto"><a href="/${repo}/wiki/${p.slug}">` +
          `${p.title ?? p.slug.replace(/-/g, " ")}</a></div>`,
      )
      .join("\n");

  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);

    if (url.startsWith("https://github.com/") && url.includes(".wiki.git/info/refs")) {
      const repo = url.slice("https://github.com/".length, url.indexOf(".wiki.git"));
      return new Response("001e# service=git-upload-pack\n", {
        status: wikis[repo] ? 200 : 404,
      });
    }

    if (url.endsWith("/wiki/_pages")) {
      const repo = url.slice("https://github.com/".length, url.indexOf("/wiki/_pages"));
      const wiki = wikis[repo];
      if (!wiki || wiki.indexFails) return new Response("boom", { status: 503 });
      return new Response(pagesHtmlFor(repo, wiki), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    const rawRoot = "https://raw.githubusercontent.com/wiki/";
    if (url.startsWith(rawRoot)) {
      const tail = url.slice(rawRoot.length);
      // `owner/repo/Page.ext` — the repo is the first two path segments.
      const slash = tail.indexOf("/", tail.indexOf("/") + 1);
      const repo = tail.slice(0, slash);
      const file = tail.slice(slash + 1);

      rawCount++;
      const seen = rawByRepo.get(repo) ?? [];
      seen.push(file);
      rawByRepo.set(repo, seen);

      if (opts.throwAfter !== undefined && rawCount > opts.throwAfter) {
        throw new Error(opts.throwMessage ?? "Network connection lost.");
      }

      const dot = file.lastIndexOf(".");
      const name = decodeURIComponent(file.slice(0, dot));
      const ext = file.slice(dot + 1);
      const body = wikis[repo]?.files[name];
      if (ext !== "md" || body === undefined) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(body, { status: 200 });
    }

    throw new Error(`unexpected fetch in multi-wiki stub: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  return {
    /** Raw-content requests issued for one repo. Empty = never walked. */
    rawFor: (repo: string): string[] => rawByRepo.get(repo) ?? [],
  };
}

/** IssueStore stand-in spanning several repos, so cursors can be compared. */
function makeMultiStore() {
  const watermarks = new Map<string, { lastPolledAt: string; etag: string }>();

  const stub = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === "/wiki-docs") return Response.json([]);
      if (request.method === "GET" && path === "/watermark") {
        const wm = watermarks.get(url.searchParams.get("repo") ?? "");
        if (!wm) return new Response("not found", { status: 404 });
        return Response.json(wm);
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
      return new Response("ok");
    },
  };

  return {
    stub: stub as unknown as DurableObjectStub,
    cursor: (repo: string) => watermarks.get(`wiki:${repo}`)?.etag,
  };
}

/** A wiki whose enumeration totals `pages`. Nothing is in the store, so every
 *  fetched page embeds and the pass costs its worst case — which is what brings
 *  the run budget into play within a realistic repo count.
 *
 *  One of the `pages` is `Home`: `listWikiPages` unions it into every
 *  enumeration whether or not `_pages` lists it, so a fixture without a `Home`
 *  file hands the walk a genuine all-candidate 404 on every run. */
function deepWiki(pages: number): FakeWiki {
  const slugs = Array.from(
    { length: pages - 1 },
    (_, i) => `p${String(i).padStart(2, "0")}`,
  );
  return {
    listed: slugs.map((slug) => ({ slug, title: slug })),
    files: Object.fromEntries([...slugs, "Home"].map((s) => [s, `body of ${s}`])),
  };
}

const repoList = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `acme/r${String(i).padStart(2, "0")}`);

const wikiSet = (repos: string[], pages: number): Record<string, FakeWiki> =>
  Object.fromEntries(repos.map((r) => [r, deepWiki(pages)]));

/** Capture the poller's console output for one run. The per-repo summary line
 *  is the only place a pass's `failed` / `inconclusive` counts surface once
 *  `runWikiSurfaces` has swallowed the summaries. */
function captureConsole() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const warn = vi.spyOn(console, "warn").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  return {
    lines,
    restore: () => {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    },
    /** The end-of-pass summary line for one repo, if the pass ran. Matched on
     *  the `N pages,` field as well as the prefix: warn lines share the
     *  `{repo} wiki: ` prefix and would otherwise be picked up instead. */
    summaryFor: (repo: string) =>
      lines.find((l) => l.startsWith(`${repo} wiki: `) && / \d+ pages, /.test(l)),
  };
}

const TICK = Date.parse("2026-08-15T03:45:00Z");

describe("poller: wiki run-wide subrequest budget", () => {
  it("hands a repo the full per-repo cap while the run budget is untouched", () => {
    expect(wikiFetchBudgetForPass(900)).toBe(PER_REPO_FETCH_CAP);
  });

  it("lets the run budget outrank the per-repo cap once the remainder is thin", () => {
    // The remainder must cover the pass's fixed cost — overhead plus a reap
    // that fills both of its budgets — before it funds a single page, so the
    // cap falls below the per-repo constant well before the budget is spent.
    const thin = wikiFetchBudgetForPass(120);
    expect(thin).toBeGreaterThan(0);
    expect(thin).toBeLessThan(PER_REPO_FETCH_CAP);
    // Monotonic in the remainder: a repo later in the run never gets more.
    expect(wikiFetchBudgetForPass(200)).toBeGreaterThanOrEqual(thin);
  });

  it("returns zero rather than a token budget when a pass cannot be funded", () => {
    // Zero is the caller's signal to skip the repo outright. A pass always runs
    // its first page's whole candidate list (issue #192), so a budget of 1 would
    // be overrun rather than respected, and the pass would spend its fixed
    // overhead to make one page of progress.
    expect(wikiFetchBudgetForPass(14)).toBe(0);
    expect(wikiFetchBudgetForPass(0)).toBe(0);
    expect(wikiFetchBudgetForPass(-100)).toBe(0);
    // One unit above the floor funds exactly one page, not zero.
    expect(wikiFetchBudgetForPass(15)).toBe(1);
  });

  it("leaves no repo of the production six-repo run recording a failure", async () => {
    // The observed shape (2026-08-15T03:45Z tick), page counts included: five
    // repos indexed normally, one wiki not enabled, and the sixth reported 8
    // failures for pages nobody had looked at — every per-repo budget held while
    // their sum blew the invocation ceiling, and the tail wore all of it.
    //
    // Both outcomes for a trailing repo are correct now and neither records a
    // failure: walked within the remaining share, or deferred untouched. What
    // must not happen is the third one, a failure for a page never fetched.
    const repos = [
      "acme/webhook-mcp", // 5 pages
      "acme/rag-mcp", // 7
      "acme/desktop", // wiki not enabled
      "acme/language", // 87 — the one that eats the run
      "acme/dipper", // 5
      "acme/neuron-graph", // 12 — the tail that reported 8 failures
    ];
    const wikis: Record<string, FakeWiki> = {
      "acme/webhook-mcp": deepWiki(5),
      "acme/rag-mcp": deepWiki(7),
      "acme/language": deepWiki(87),
      "acme/dipper": deepWiki(5),
      "acme/neuron-graph": deepWiki(12),
    };
    const multi = stubMultiWiki(wikis);
    const store = makeMultiStore();
    const { env } = makeWikiEnv();
    const con = captureConsole();

    try {
      await runWikiSurfaces(repos, env, store.stub, TICK);
    } finally {
      con.restore();
    }

    let walked = 0;
    for (const repo of repos) {
      const summary = con.summaryFor(repo);
      if (summary === undefined) {
        // Deferred: never called, so its cursor cannot have moved.
        expect(multi.rawFor(repo)).toEqual([]);
        expect(store.cursor(repo)).toBeUndefined();
        continue;
      }
      walked++;
      expect(summary).toContain("0 failed");
      expect(summary).toContain("0 inconclusive");
    }
    // Guard against the assertions above passing vacuously on a run that
    // deferred everything: the share must fund real work, not just refuse it.
    expect(walked).toBeGreaterThanOrEqual(3);
    // The exception the fix exists to prevent must not appear at all.
    expect(con.lines.some((l) => l.includes("Too many subrequests"))).toBe(false);
  });

  it("defers repos it cannot fund instead of walking them into exhaustion", async () => {
    // Enough repos that the declared share cannot cover them all in one run.
    const repos = repoList(12);
    const multi = stubMultiWiki(wikiSet(repos, 30));
    const store = makeMultiStore();
    const { env } = makeWikiEnv();
    const con = captureConsole();

    try {
      await runWikiSurfaces(repos, env, store.stub, TICK);
    } finally {
      con.restore();
    }

    const ordered = rotateReposForRun(repos, TICK);
    const walked = ordered.filter((r) => multi.rawFor(r).length > 0);
    const deferred = ordered.filter((r) => multi.rawFor(r).length === 0);

    expect(walked.length).toBeGreaterThan(0);
    expect(deferred.length).toBeGreaterThan(0);
    // Deferral is a suffix of the run order, never a hole in the middle.
    expect(ordered.slice(0, walked.length)).toEqual(walked);

    for (const repo of deferred) {
      // Untouched cursor is the whole point: the next run resumes these repos
      // exactly where the previous one left them, rather than recording a
      // failure for a page that was never fetched.
      expect(store.cursor(repo)).toBeUndefined();
      expect(con.summaryFor(repo)).toBeUndefined();
    }
    expect(con.lines.some((l) => l.includes("Wiki run share exhausted"))).toBe(true);
  });

  it("brings a deferred repo to the head of the order on a later tick", async () => {
    // Without rotation the tail of `POLL_REPOS` is starved every run, which is
    // the same "loop position decides the outcome" defect the budget removes.
    const repos = repoList(12);
    const store = makeMultiStore();
    const { env } = makeWikiEnv();

    const runAt = async (tick: number) => {
      const multi = stubMultiWiki(wikiSet(repos, 30));
      const con = captureConsole();
      try {
        await runWikiSurfaces(repos, env, store.stub, tick);
      } finally {
        con.restore();
        vi.unstubAllGlobals();
      }
      return new Set(repos.filter((r) => multi.rawFor(r).length > 0));
    };

    const first = await runAt(TICK);
    const deferred = repos.filter((r) => !first.has(r));
    expect(deferred.length).toBeGreaterThan(0);

    // Walk forward one tick at a time; every deferred repo must get walked
    // within one full rotation of the list.
    const covered = new Set(first);
    for (let hour = 1; hour < repos.length; hour++) {
      for (const r of await runAt(TICK + hour * 3_600_000)) covered.add(r);
    }
    for (const repo of deferred) expect(covered.has(repo)).toBe(true);
  });

  it("records an unobserved probe miss as inconclusive, not as a failure", async () => {
    // A `fetch()` that throws says nothing about whether the page exists. The
    // old message asserted "all candidates 404" for it, which is how eight
    // present pages were reported as missing.
    const repos = repoList(2);
    stubMultiWiki(wikiSet(repos, 5), { throwAfter: 0 });
    const store = makeMultiStore();
    const { env } = makeWikiEnv();
    const con = captureConsole();

    try {
      await runWikiSurfaces(repos, env, store.stub, TICK);
    } finally {
      con.restore();
    }

    for (const repo of repos) {
      const summary = con.summaryFor(repo);
      expect(summary).toBeDefined();
      expect(summary).toContain("0 failed");
      expect(summary).not.toContain("0 inconclusive");
    }
    // The misleading literal is gone; the replacement names the cause.
    expect(con.lines.some((l) => l.includes("all candidates 404"))).toBe(false);
    expect(con.lines.some((l) => l.includes("probe threw; absence not observed"))).toBe(
      true,
    );
  });

  it("still reports an observed all-404 miss as a failure", async () => {
    // The other side of the split: a page listed in `_pages` whose file is
    // genuinely absent answers 404 on every candidate, and that *is* an
    // observation. It must keep counting as a failure.
    const wiki = deepWiki(3);
    delete wiki.files.p01;
    stubMultiWiki({ "acme/r00": wiki });
    const store = makeMultiStore();
    const { env } = makeWikiEnv();
    const con = captureConsole();

    try {
      await runWikiSurfaces(["acme/r00"], env, store.stub, TICK);
    } finally {
      con.restore();
    }

    const summary = con.summaryFor("acme/r00");
    expect(summary).toContain("1 failed");
    expect(summary).toContain("0 inconclusive");
    expect(con.lines.some((l) => l.includes("every candidate answered 404"))).toBe(true);
  });

  it("does not break a deep wiki's multi-run drain", async () => {
    // `liplus-language` shape: 87 pages against a 20-page pass budget, so the
    // lap takes several runs. The run-wide budget sits above the per-repo one
    // and must not disturb that walk when it is the only repo in the list.
    const wikis = { "acme/deep": deepWiki(87) };
    const store = makeMultiStore();
    const { env } = makeWikiEnv();

    const seen = new Set<string>();
    for (let run = 0; run < 5; run++) {
      const multi = stubMultiWiki(wikis);
      const con = captureConsole();
      try {
        await runWikiSurfaces(["acme/deep"], env, store.stub, TICK + run * 3_600_000);
      } finally {
        con.restore();
        vi.unstubAllGlobals();
      }
      for (const file of multi.rawFor("acme/deep")) {
        seen.add(decodeURIComponent(file.slice(0, file.lastIndexOf("."))));
      }
      // A single-repo run always affords the full per-repo cap.
      expect(con.summaryFor("acme/deep")).toContain(`/${PER_REPO_FETCH_CAP} fetches`);
    }

    // 87 pages at 20 per run: five runs cover every one of them.
    expect(seen.size).toBe(87);
  });

  it("rotates the run order by tick without changing the list", () => {
    const repos = repoList(6);
    const leaders = new Set<string>();
    for (let hour = 0; hour < repos.length; hour++) {
      const ordered = rotateReposForRun(repos, TICK + hour * 3_600_000);
      expect([...ordered].sort()).toEqual([...repos].sort());
      leaders.add(ordered[0]);
    }
    // Every repo leads exactly once across one full rotation.
    expect(leaders.size).toBe(repos.length);
    // Same tick, same order — the offset is derived, not random.
    expect(rotateReposForRun(repos, TICK)).toEqual(rotateReposForRun(repos, TICK));
    expect(rotateReposForRun([], TICK)).toEqual([]);
  });
});

// ── Steady-state cost profile and the observed wall (issue #248) ─────

/**
 * IssueStore stand-in that already holds every page of every wiki, hashed to
 * match, so the walk's hash comparison skips each one.
 *
 * This is the profile production actually runs in and the one `deepWiki` gets
 * backwards. An unchanged page never reaches `processAndUpsertWikiDoc`, so it
 * is charged its fetch attempts and nothing else — a sixth of what a changed
 * page costs. A suite that only ever presents changed pages measures the
 * expensive shape and leaves the common one untested, which is how a run-wide
 * share that cannot engage on the observed tick passed review.
 */
async function makeIndexedStore(wikis: Record<string, FakeWiki>) {
  const watermarks = new Map<string, { lastPolledAt: string; etag: string }>();
  const byRepo = new Map<string, WikiDocRecord[]>();

  for (const [repo, wiki] of Object.entries(wikis)) {
    const records: WikiDocRecord[] = [];
    for (const [name, body] of Object.entries(wiki.files)) {
      records.push({
        repo,
        pageName: name,
        extension: "md",
        contentHash: await sha256Hex(body),
        updatedAt: "2026-08-01T00:00:00Z",
      });
    }
    byRepo.set(repo, records);
  }

  const stub = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === "/wiki-docs") {
        return Response.json(byRepo.get(url.searchParams.get("repo") ?? "") ?? []);
      }
      if (request.method === "GET" && path === "/watermark") {
        const wm = watermarks.get(url.searchParams.get("repo") ?? "");
        if (!wm) return new Response("not found", { status: 404 });
        return Response.json(wm);
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
      return new Response("ok");
    },
  };

  return {
    stub: stub as unknown as DurableObjectStub,
    cursor: (repo: string) => watermarks.get(`wiki:${repo}`)?.etag,
  };
}

/** The repo list and page counts of the 2026-08-15T03:45Z tick, in order.
 *  `liplus-desktop` has no wiki, so it is absent from the wiki map. */
const OBSERVED_REPOS = [
  "acme/webhook-mcp",
  "acme/rag-mcp",
  "acme/desktop",
  "acme/language",
  "acme/dipper",
  "acme/neuron-graph",
];

const observedWikis = (): Record<string, FakeWiki> => ({
  "acme/webhook-mcp": deepWiki(5),
  "acme/rag-mcp": deepWiki(7),
  "acme/language": deepWiki(87),
  "acme/dipper": deepWiki(5),
  "acme/neuron-graph": deepWiki(12),
});

const SUBREQUEST_EXHAUSTION = "Too many subrequests by single Worker invocation.";

describe("poller: wiki steady-state profile and the observed wall", () => {
  it("charges an unchanged page only its fetch, not the embed fan-out", async () => {
    // The load-bearing asymmetry. Everything below follows from it: the
    // accounted cost of a run depends on how much changed, not on page count.
    const wikis = { "acme/r00": deepWiki(6) };
    const fresh = makeMultiStore();
    const indexed = await makeIndexedStore(wikis);
    const { env } = makeWikiEnv();

    stubMultiWiki(wikis);
    const changed = await pollWiki("acme/r00", env, fresh.stub, { fetchBudget: 20 });
    vi.unstubAllGlobals();

    stubMultiWiki(wikis);
    const unchanged = await pollWiki("acme/r00", env, indexed.stub, { fetchBudget: 20 });
    vi.unstubAllGlobals();

    expect(changed.embedded).toBe(6);
    expect(unchanged.embedded).toBe(0);
    expect(unchanged.skipped).toBe(6);
    // Same pages, same fetches, and the accounted spend differs by the whole
    // embed fan-out.
    expect(unchanged.fetches).toBe(changed.fetches);
    expect(unchanged.subrequests).toBeLessThan(changed.subrequests / 2);
  });

  it("does not engage the declared share on the observed steady-state run", async () => {
    // Honest negative test. On the profile that actually threw in production,
    // the accounted spend of the whole six-repo run is far under the declared
    // share, so nothing defers and the run proceeds in the order that threw.
    //
    // This is the limitation stated in `WIKI_SUBREQUEST_BUDGET_PER_RUN`, pinned
    // so it cannot quietly stop being true: the share is not what protects this
    // shape, and a future change that makes this test fail has either fixed the
    // unit gap or broken the cost model — both worth stopping for.
    const wikis = observedWikis();
    const store = await makeIndexedStore(wikis);
    const multi = stubMultiWiki(wikis);
    const { env } = makeWikiEnv();
    const con = captureConsole();

    try {
      await runWikiSurfaces(OBSERVED_REPOS, env, store.stub, TICK);
    } finally {
      con.restore();
    }

    // Every repo walked; nothing deferred.
    for (const repo of OBSERVED_REPOS) {
      if (repo === "acme/desktop") continue; // no wiki — skipped, not deferred
      expect(multi.rawFor(repo).length).toBeGreaterThan(0);
    }
    expect(con.lines.some((l) => l.includes("deferred to the next run"))).toBe(false);

    // And the accounted total sits well under the share, which is why.
    const total = con.lines
      .map((l) => /, (\d+) subrequests,/.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .reduce((a, n) => a + Number(n), 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(150);
  });

  it("stops the whole run when the invocation reports subrequest exhaustion", async () => {
    // What actually covers the observed failure. The share is an estimate that
    // may never engage; the wall is observed, and the run ends on it.
    const wikis = observedWikis();
    const store = await makeIndexedStore(wikis);
    // 14 raw requests in: past the first two repos, inside a later one.
    const multi = stubMultiWiki(wikis, {
      throwAfter: 14,
      throwMessage: SUBREQUEST_EXHAUSTION,
    });
    const { env } = makeWikiEnv();
    const con = captureConsole();

    try {
      await runWikiSurfaces(OBSERVED_REPOS, env, store.stub, TICK);
    } finally {
      con.restore();
    }

    // No repo records a failure for a page it never observed. This is the
    // literal acceptance criterion: 8 false failures became 0.
    for (const repo of OBSERVED_REPOS) {
      const summary = con.summaryFor(repo);
      if (summary === undefined) continue;
      expect(summary).toContain("0 failed");
    }
    // The run stopped rather than grinding every remaining repo into the wall.
    expect(con.lines.some((l) => l.includes("out of subrequests (observed)"))).toBe(true);

    const ordered = rotateReposForRun(OBSERVED_REPOS, TICK);
    const walked = ordered.filter((r) => multi.rawFor(r).length > 0);
    const unreached = ordered.filter((r) => multi.rawFor(r).length === 0);
    expect(walked.length).toBeLessThan(ordered.length);
    expect(unreached.length).toBeGreaterThan(0);
    for (const repo of unreached) {
      // Repos the run never reached kept their cursors; the next tick resumes
      // them where the previous run left off.
      expect(store.cursor(repo)).toBeUndefined();
    }
  });

  it("holds the cursor on the page the wall interrupted", async () => {
    // A page whose probes threw was never observed, so the cursor must not
    // advance past it — the same treatment the fetch-budget guard gives an
    // inconclusive probe, on the measured axis instead of the estimated one.
    const wikis = { "acme/r00": deepWiki(9) };
    const store = await makeIndexedStore(wikis);
    const { env } = makeWikiEnv();

    // Let three pages resolve, then hit the wall on the fourth.
    stubMultiWiki(wikis, { throwAfter: 3, throwMessage: SUBREQUEST_EXHAUSTION });
    const con = captureConsole();
    let summary;
    try {
      summary = await pollWiki("acme/r00", env, store.stub, { fetchBudget: 20 });
    } finally {
      con.restore();
    }

    expect(summary.exhausted).toBe(true);
    expect(summary.visited).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.inconclusive).toBe(0);
    // Slug order puts `Home` first, so the three observed pages are Home, p00,
    // p01 and the wall lands on p02. The cursor sits on the last page actually
    // observed, not on the one that threw.
    expect(summary.nextCursor).toBe("p01");
    expect(store.cursor("acme/r00")).toBe("p01");
    // The reap is skipped wholesale — its probes would hit the same wall.
    expect(summary.removed).toBe(0);
    expect(con.lines.some((l) => l.includes("reap skipped this run"))).toBe(true);
  });

  it("keeps an ordinary network error on the per-page axis", async () => {
    // The contrast that makes the exhaustion branch meaningful. A blip is this
    // page's problem: it counts as inconclusive, the cursor advances past it,
    // and the run carries on to the remaining repos.
    const wikis = { "acme/r00": deepWiki(4), "acme/r01": deepWiki(4) };
    const store = await makeIndexedStore(wikis);
    const multi = stubMultiWiki(wikis, { throwAfter: 0 });
    const { env } = makeWikiEnv();
    const con = captureConsole();

    try {
      await runWikiSurfaces(["acme/r00", "acme/r01"], env, store.stub, TICK);
    } finally {
      con.restore();
    }

    // Both repos were walked — a blip does not end the run.
    expect(multi.rawFor("acme/r00").length).toBeGreaterThan(0);
    expect(multi.rawFor("acme/r01").length).toBeGreaterThan(0);
    expect(con.lines.some((l) => l.includes("out of subrequests (observed)"))).toBe(false);
    for (const repo of ["acme/r00", "acme/r01"]) {
      expect(con.summaryFor(repo)).toContain("0 failed");
      expect(con.summaryFor(repo)).not.toContain("0 inconclusive");
    }
  });

  it("classifies the exhaustion message and nothing else", () => {
    expect(isSubrequestExhaustion(new Error(SUBREQUEST_EXHAUSTION))).toBe(true);
    expect(isSubrequestExhaustion(new Error("Too many subrequests"))).toBe(true);
    expect(isSubrequestExhaustion(new Error("Network connection lost."))).toBe(false);
    expect(isSubrequestExhaustion(new Error("429 Too Many Requests"))).toBe(false);
    expect(isSubrequestExhaustion("Too many subrequests")).toBe(true);
    expect(isSubrequestExhaustion(undefined)).toBe(false);
  });
});
