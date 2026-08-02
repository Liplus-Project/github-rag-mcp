import { describe, it, expect, vi, afterEach } from "vitest";
import type { Env } from "./types.js";
import {
  purgeLegacyDocVectors,
  DEFAULT_PURGE_LIMIT,
  MAX_PURGE_LIMIT,
} from "./purge-legacy.js";
import { docVectorId } from "./pipeline.js";
import { legacyDocVectorId } from "./pipeline/legacy-vector-id.js";

const REPO = "acme/widgets";
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/HEAD?recursive=1`;

/** Stub the global fetch with a fake Git Trees API returning `paths` as blobs. */
function stubTree(paths: string[], truncated = false) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url !== TREE_URL) {
      throw new Error(`unexpected fetch in purge stub: ${url}`);
    }
    return new Response(
      JSON.stringify({
        sha: "treesha",
        truncated,
        tree: [
          // A directory entry and a non-`.md` blob: neither is a doc candidate.
          { path: "docs", type: "tree", sha: "dirsha" },
          { path: "src/index.ts", type: "blob", sha: "blob-ts" },
          ...paths.map((path) => ({ path, type: "blob", sha: `blob-${path}` })),
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeEnv() {
  const vectorDeletes: string[] = [];
  const batchSizes: number[] = [];
  const deleteByIds = vi.fn(async (ids: string[]) => {
    batchSizes.push(ids.length);
    vectorDeletes.push(...ids);
  });
  const env = {
    GITHUB_TOKEN: "test-token",
    VECTORIZE: { deleteByIds },
  } as unknown as Env;
  return { env, vectorDeletes, batchSizes, deleteByIds };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("purge-legacy: legacy doc vector ID reconstruction", () => {
  it("rebuilds the pre-migration scheme `{repo}#doc-{path}`", () => {
    expect(legacyDocVectorId(REPO, "docs/x.md")).toBe(`${REPO}#doc-docs/x.md`);
  });

  it("never collides with a current-generation ID", async () => {
    // The purge only deletes IDs it builds itself, and the two formats are
    // disjoint — this pins that a current vector can never be named by accident.
    const current = await docVectorId(REPO, "docs/x.md");
    expect(current.startsWith("d:")).toBe(true);
    expect(legacyDocVectorId(REPO, "docs/x.md")).not.toBe(current);
  });
});

describe("purge-legacy: dry run", () => {
  it("reports the count without touching Vectorize", async () => {
    stubTree(["README.md", "docs/a.md", "docs/b.md"]);
    const { env, vectorDeletes, deleteByIds } = makeEnv();

    const summary = await purgeLegacyDocVectors(REPO, env, { dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.candidates).toBe(3);
    expect(summary.targeted).toBe(3);
    expect(summary.deleted).toBe(0);
    expect(summary.done).toBe(true);
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(vectorDeletes).toEqual([]);
  });

  it("reports the same candidate set the real run would delete", async () => {
    stubTree(["README.md", "docs/a.md"]);
    const dry = makeEnv();
    const wet = makeEnv();

    const dryRun = await purgeLegacyDocVectors(REPO, dry.env, { dryRun: true });
    stubTree(["README.md", "docs/a.md"]);
    const realRun = await purgeLegacyDocVectors(REPO, wet.env, {});

    expect(dryRun.targeted).toBe(realRun.deleted);
    expect(wet.vectorDeletes).toEqual([
      legacyDocVectorId(REPO, "README.md"),
      legacyDocVectorId(REPO, "docs/a.md"),
    ]);
  });
});

describe("purge-legacy: candidate set", () => {
  it("deletes only legacy IDs derived from `.md` blobs in the tree", async () => {
    stubTree(["README.md", "docs/a.md"]);
    const { env, vectorDeletes } = makeEnv();

    const summary = await purgeLegacyDocVectors(REPO, env, {});

    expect(vectorDeletes).toEqual([
      legacyDocVectorId(REPO, "README.md"),
      legacyDocVectorId(REPO, "docs/a.md"),
    ]);
    expect(vectorDeletes.every((id) => id.startsWith(`${REPO}#doc-`))).toBe(true);
    expect(summary.deleted).toBe(2);
  });

  it("covers explicit paths first, ahead of the tree", async () => {
    // Paths already gone from the tree are the confirmed orphans; a capped run
    // must reach them before spending its budget on live files.
    stubTree(["README.md", "docs/a.md"]);
    const { env, vectorDeletes } = makeEnv();

    await purgeLegacyDocVectors(REPO, env, {
      paths: [".claude/CLAUDE.md", ".claude/rules/x.md"],
    });

    expect(vectorDeletes.slice(0, 2)).toEqual([
      legacyDocVectorId(REPO, ".claude/CLAUDE.md"),
      legacyDocVectorId(REPO, ".claude/rules/x.md"),
    ]);
    expect(vectorDeletes).toHaveLength(4);
  });

  it("dedupes a path present in both the tree and the explicit list", async () => {
    stubTree(["README.md"]);
    const { env, vectorDeletes } = makeEnv();

    const summary = await purgeLegacyDocVectors(REPO, env, { paths: ["README.md"] });

    expect(summary.candidates).toBe(1);
    expect(vectorDeletes).toEqual([legacyDocVectorId(REPO, "README.md")]);
  });

  it("skips IDs over the 64-byte Vectorize cap instead of sending them", async () => {
    // A legacy ID that long was rejected at upsert time — that overflow is why
    // the hashed scheme exists — so no vector can be keyed to it.
    const longPath = `docs/${"a".repeat(80)}.md`;
    stubTree(["README.md", longPath]);
    const { env, vectorDeletes } = makeEnv();

    const summary = await purgeLegacyDocVectors(REPO, env, {});

    expect(summary.skippedOversize).toBe(1);
    expect(summary.candidates).toBe(1);
    expect(vectorDeletes).toEqual([legacyDocVectorId(REPO, "README.md")]);
  });

  it("surfaces a truncated tree listing", async () => {
    stubTree(["README.md"], true);
    const { env } = makeEnv();

    const summary = await purgeLegacyDocVectors(REPO, env, { dryRun: true });

    expect(summary.treeTruncated).toBe(true);
  });
});

describe("purge-legacy: per-run cap", () => {
  it("caps a run and reports the excess to the caller", async () => {
    const paths = Array.from({ length: 7 }, (_, i) => `docs/${i}.md`);
    stubTree(paths);
    const { env, vectorDeletes } = makeEnv();

    const summary = await purgeLegacyDocVectors(REPO, env, { limit: 3 });

    expect(summary.targeted).toBe(3);
    expect(summary.deleted).toBe(3);
    expect(summary.remaining).toBe(4);
    expect(summary.nextCursor).toBe(3);
    expect(summary.done).toBe(false);
    expect(vectorDeletes).toHaveLength(3);
  });

  it("drains the rest across calls when fed its own nextCursor", async () => {
    const paths = Array.from({ length: 7 }, (_, i) => `docs/${i}.md`);
    const { env, vectorDeletes } = makeEnv();

    let cursor: number | null = 0;
    let calls = 0;
    while (cursor !== null) {
      stubTree(paths);
      const summary: Awaited<ReturnType<typeof purgeLegacyDocVectors>> =
        await purgeLegacyDocVectors(REPO, env, { limit: 3, cursor });
      cursor = summary.nextCursor;
      calls++;
    }

    expect(calls).toBe(3);
    expect(vectorDeletes).toEqual(paths.map((p) => legacyDocVectorId(REPO, p)));
    expect(new Set(vectorDeletes).size).toBe(paths.length);
  });

  it("reports done with an empty slice once the cursor is past the end", async () => {
    stubTree(["README.md"]);
    const { env, vectorDeletes } = makeEnv();

    const summary = await purgeLegacyDocVectors(REPO, env, { cursor: 10 });

    expect(summary.targeted).toBe(0);
    expect(summary.remaining).toBe(0);
    expect(summary.done).toBe(true);
    expect(vectorDeletes).toEqual([]);
  });

  it("batches the delete calls rather than one call per ID", async () => {
    const paths = Array.from({ length: 1200 }, (_, i) => `docs/${i}.md`);
    stubTree(paths);
    const { env, batchSizes } = makeEnv();

    const summary = await purgeLegacyDocVectors(REPO, env, { limit: MAX_PURGE_LIMIT });

    expect(summary.deleted).toBe(1200);
    expect(batchSizes).toEqual([500, 500, 200]);
  });

  it("defaults the limit to DEFAULT_PURGE_LIMIT", async () => {
    const paths = Array.from({ length: DEFAULT_PURGE_LIMIT + 5 }, (_, i) => `docs/${i}.md`);
    stubTree(paths);
    const { env } = makeEnv();

    const summary = await purgeLegacyDocVectors(REPO, env, { dryRun: true });

    expect(summary.limit).toBe(DEFAULT_PURGE_LIMIT);
    expect(summary.targeted).toBe(DEFAULT_PURGE_LIMIT);
    expect(summary.remaining).toBe(5);
  });
});
