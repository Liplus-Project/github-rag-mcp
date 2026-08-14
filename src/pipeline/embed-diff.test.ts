import { describe, it, expect, vi } from "vitest";
import type { Env } from "../types.js";
import { processAndUpsertCommitDiff, type GitHubCommitDetail } from "./embed-diff.js";
import {
  MAX_EMBEDDING_BATCH_BYTES,
  TOKEN_OVERHEAD_PER_INPUT,
  WORKERS_AI_BATCH_CONTEXT_LIMIT,
  utf8ByteLength,
} from "./embedding.js";
import { diffVectorId } from "./vector-id.js";

const REPO = "acme/widgets";

function mkCommit(patches: string[]): GitHubCommitDetail {
  return {
    sha: "c0ffee",
    commit: {
      message: "a commit message",
      author: { name: "author", date: "2026-01-01T00:00:00Z" },
    },
    author: { login: "author" },
    files: patches.map((patch, i) => ({
      filename: `src/file-${i}.ts`,
      status: "modified",
      patch,
      sha: `blob${i}`,
    })),
  };
}

interface EnvStubOptions {
  /** Batch indices (in call order) whose embed call should throw. */
  embedFailsOnCall?: number[];
}

function mkEnv(options: EnvStubOptions = {}) {
  /** Inputs handed to each Workers AI call, in call order. */
  const aiCalls: string[][] = [];
  const upsertedIds: string[][] = [];

  const env = {
    GITHUB_TOKEN: "t",
    AI: {
      run: vi.fn(async (_model: string, input: { text: string[] }) => {
        const callIndex = aiCalls.length;
        aiCalls.push(input.text);
        if (options.embedFailsOnCall?.includes(callIndex)) {
          throw new Error("workers ai rejected the batch");
        }
        return { data: input.text.map(() => [0.1, 0.2]) };
      }),
    },
    VECTORIZE: {
      upsert: vi.fn(async (vectors: Array<{ id: string }>) => {
        upsertedIds.push(vectors.map((v) => v.id));
      }),
    },
    DB_FTS: {
      prepare: () => ({
        bind: () => ({ run: async () => ({}) }),
      }),
    },
  } as unknown as Env;

  return { env, aiCalls, upsertedIds };
}

function mkStore() {
  return {
    fetch: vi.fn(async () => new Response("{}", { status: 200 })),
  } as unknown as DurableObjectStub;
}

/** A patch of the shape the ceiling rejected: dense punctuation, short identifiers,
 *  a `+` on every line — where bge-m3 splits far finer than an ASCII prose ratio. */
function mkDiffPatch(chars: number): string {
  const line = "+  const value = obj?.[key] ?? { a: 1, b: [2, 3] };\n";
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

/** What the planner charges one Workers AI call. Upper-bounds its token count. */
function callCharge(texts: string[]): number {
  return texts.reduce(
    (sum, text) => sum + utf8ByteLength(text) + TOKEN_OVERHEAD_PER_INPUT,
    0,
  );
}

/** What the retired character budget charged the same call (#242). Kept in the
 *  tests only, to hold the regression fixtures inside the shape it passed. */
function retiredCharCharge(texts: string[]): number {
  return texts.reduce((sum, text) => sum + text.length + 2, 0);
}

describe("embed-diff: the batch axis is the UTF-8 byte budget, not the file count", () => {
  it("still sends an ordinary commit as one call", async () => {
    // 30 files well past the retired count cap of 20, each a small patch.
    const { env, aiCalls } = mkEnv();
    const commit = mkCommit(Array.from({ length: 30 }, (_, i) => `@@ -1 +1 @@\n+line ${i}`));

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit);

    expect(result).toEqual({
      embedded: 30,
      skipped: 0,
      failed: 0,
      batches: 1,
      alreadyIndexed: 0,
      deferred: 0,
    });
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]).toHaveLength(30);
  });

  it("splits a commit of large patches that a file count would have kept in one call", async () => {
    // Twenty maximal patches — exactly one chunk under the retired count cap, and
    // the shape the endpoint rejected in production ("Max context reached 85920
    // tokens but model supports only 60000"), taking every file in the chunk down
    // with the call.
    const { env, aiCalls, upsertedIds } = mkEnv();
    const commit = mkCommit(Array.from({ length: 20 }, () => "あ".repeat(9000)));

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit);

    expect(result.embedded).toBe(20);
    expect(result.failed).toBe(0);
    expect(aiCalls.length).toBeGreaterThan(1);
    expect(result.batches).toBe(aiCalls.length);

    // Every call carrying more than one input stays inside the budget.
    for (const call of aiCalls) {
      if (call.length > 1) {
        expect(callCharge(call)).toBeLessThanOrEqual(MAX_EMBEDDING_BATCH_BYTES);
      }
    }

    // No file is dropped or duplicated on the way through the split.
    expect(aiCalls.flat()).toHaveLength(20);
    expect(new Set(upsertedIds.flat()).size).toBe(20);
  });

  it("splits the 18-file commit shape that an estimated budget let through", async () => {
    // The payload that kept failing after #237 shipped: 18 files of ordinary diff
    // patch, no single one of them oversized. bge-m3 tokenizes a patch at roughly
    // 1.4 characters per token — `+`/`-` prefixes, indentation, punctuation and
    // short identifiers all split small — so the retired estimator's ASCII ratio of
    // 3 came in about 2.1x under the truth, judged the whole commit to fit one
    // 30000-token batch, and handed the endpoint 60678 tokens against a ceiling of
    // 60000. The chunk failed whole, and the diff watermark held on the commit.
    const { env, aiCalls, upsertedIds } = mkEnv();
    const commit = mkCommit(Array.from({ length: 18 }, () => mkDiffPatch(4700)));

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit);

    const allInputs = aiCalls.flat();
    // The fixture is only a regression test while it stays in the failing zone: over
    // the ceiling as one call, yet inside the budget the estimator would have
    // computed for it — roughly 85200 ASCII characters, which its ratio of 3 read as
    // about 28400 tokens against the 30000 that #237 set. The second assertion
    // divides the charge rather than the bare character sum, which overstates the
    // estimator's figure by the special tokens and so errs toward failing. Both
    // halves are asserted, so a later edit to the patch size cannot quietly move the
    // fixture out of the shape it reproduces.
    expect(callCharge(allInputs)).toBeGreaterThan(WORKERS_AI_BATCH_CONTEXT_LIMIT);
    expect(Math.ceil(callCharge(allInputs) / 3)).toBeLessThanOrEqual(30000);

    expect(aiCalls.length).toBeGreaterThan(1);
    for (const call of aiCalls) {
      expect(callCharge(call)).toBeLessThanOrEqual(MAX_EMBEDDING_BATCH_BYTES);
    }

    // Splitting is only the fix if every file still lands.
    expect(result.embedded).toBe(18);
    expect(result.failed).toBe(0);
    expect(new Set(upsertedIds.flat()).size).toBe(18);
  });

  it("splits the 16-file Japanese commit that a character budget let through", async () => {
    // The payload that kept failing after #242 shipped: 16 files of Japanese-heavy
    // patch, charged at most 60000 characters and sent as one call, answered with
    // `Max context reached 68736 tokens but model supports only 60000` — 1.146 tokens
    // per character. Byte fallback is what breaks the character premise: a character
    // the vocabulary lacks is decomposed into its UTF-8 bytes, so one 3-byte
    // character can cost 3 tokens where the budget charged it 1.
    const { env, aiCalls, upsertedIds } = mkEnv();
    const commit = mkCommit(Array.from({ length: 16 }, () => "あ".repeat(3700)));

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit);

    const allInputs = aiCalls.flat();
    // The fixture reproduces the shape only while it stays in the failing zone: one
    // call under the retired character budget, over the ceiling in what it actually
    // costs. Both halves are asserted, so a later edit to the patch size cannot
    // quietly move it out of the shape it reproduces.
    expect(retiredCharCharge(allInputs)).toBeLessThanOrEqual(WORKERS_AI_BATCH_CONTEXT_LIMIT);
    expect(callCharge(allInputs)).toBeGreaterThan(WORKERS_AI_BATCH_CONTEXT_LIMIT);

    expect(aiCalls.length).toBeGreaterThan(1);
    for (const call of aiCalls) {
      expect(callCharge(call)).toBeLessThanOrEqual(MAX_EMBEDDING_BATCH_BYTES);
    }

    expect(result.embedded).toBe(16);
    expect(result.failed).toBe(0);
    expect(new Set(upsertedIds.flat()).size).toBe(16);
  });

  it("keeps each embed call paired with its own slice of files", async () => {
    // Vectors are matched to files by position, so a split has to cut the inputs
    // and the files on the same boundary. Reading each call's file paths back out
    // of its inputs and rebuilding the vector IDs from them catches a slice that
    // drifted — the failure mode that would file every patch under a neighbour.
    const { env, aiCalls, upsertedIds } = mkEnv();
    const commit = mkCommit(Array.from({ length: 6 }, () => "あ".repeat(9000)));

    await processAndUpsertCommitDiff(env, mkStore(), REPO, commit);

    expect(upsertedIds).toHaveLength(aiCalls.length);
    for (let batch = 0; batch < aiCalls.length; batch++) {
      // Input format is "{message}\n\n{path}\n\n{patch}".
      const paths = aiCalls[batch].map((text) => text.split("\n\n")[1]);
      const expected = await Promise.all(
        paths.map((path) => diffVectorId(REPO, commit.sha, path)),
      );
      expect(upsertedIds[batch]).toEqual(expected);
    }
  });

  it("loses only the failing batch when one embed call is rejected", async () => {
    const { env, aiCalls, upsertedIds } = mkEnv({ embedFailsOnCall: [0] });
    const commit = mkCommit(Array.from({ length: 6 }, () => "あ".repeat(9000)));

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit);

    expect(result.failed).toBe(aiCalls[0].length);
    expect(result.embedded).toBe(6 - aiCalls[0].length);
    expect(upsertedIds.flat()).toHaveLength(result.embedded);
  });

  it("skips files with no patch and reports them separately", async () => {
    const { env, aiCalls } = mkEnv();
    const commit = mkCommit(["@@ -1 +1 @@\n+one"]);
    commit.files!.push({ filename: "assets/logo.png", status: "modified", sha: "blobX" });

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit);

    expect(result).toEqual({
      embedded: 1,
      skipped: 1,
      failed: 0,
      batches: 1,
      alreadyIndexed: 0,
      deferred: 0,
    });
    expect(aiCalls[0]).toHaveLength(1);
  });
});

describe("embed-diff: a file-heavy commit is split across runs, not thinned", () => {
  it("indexes up to maxFiles and reports the rest as deferred", async () => {
    const { env, aiCalls, upsertedIds } = mkEnv();
    const commit = mkCommit(
      Array.from({ length: 44 }, (_, i) => `@@ -1 +1 @@\n+line ${i}`),
    );

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit, {
      maxFiles: 18,
    });

    expect(result.embedded).toBe(18);
    expect(result.deferred).toBe(26);
    expect(result.failed).toBe(0);
    // The bound is on files indexed, not on files seen: nothing past it is touched.
    expect(aiCalls.flat()).toHaveLength(18);
    expect(upsertedIds.flat()).toHaveLength(18);
  });

  it("takes the leading files first so the split has a stable order", async () => {
    const { env, aiCalls } = mkEnv();
    const commit = mkCommit(Array.from({ length: 5 }, (_, i) => `patch ${i}`));

    await processAndUpsertCommitDiff(env, mkStore(), REPO, commit, { maxFiles: 2 });

    // Input format is "{message}\n\n{path}\n\n{patch}".
    const paths = aiCalls.flat().map((text) => text.split("\n\n")[1]);
    expect(paths).toEqual(["src/file-0.ts", "src/file-1.ts"]);
  });

  it("resumes past the files a previous run already indexed", async () => {
    const { env, aiCalls } = mkEnv();
    const commit = mkCommit(Array.from({ length: 5 }, (_, i) => `patch ${i}`));

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit, {
      maxFiles: 2,
      indexedFilePaths: new Set(["src/file-0.ts", "src/file-1.ts"]),
    });

    const paths = aiCalls.flat().map((text) => text.split("\n\n")[1]);
    expect(paths).toEqual(["src/file-2.ts", "src/file-3.ts"]);
    expect(result.alreadyIndexed).toBe(2);
    expect(result.embedded).toBe(2);
    expect(result.deferred).toBe(1);
  });

  it("closes the split — the last run reports nothing deferred", async () => {
    // Repeated bounded calls, each fed the paths the previous ones landed, must
    // reach every file exactly once. A resume set that failed to shrink the pending
    // list would loop on the same prefix and never report deferred=0.
    const { env } = mkEnv();
    const commit = mkCommit(Array.from({ length: 7 }, (_, i) => `patch ${i}`));
    const indexed = new Set<string>();
    let runs = 0;
    let last!: Awaited<ReturnType<typeof processAndUpsertCommitDiff>>;

    do {
      if (runs++ > 10) throw new Error("split did not converge");
      last = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit, {
        maxFiles: 3,
        indexedFilePaths: new Set(indexed),
      });
      for (let i = 0; i < last.embedded; i++) {
        indexed.add(`src/file-${indexed.size}.ts`);
      }
    } while (last.deferred > 0);

    expect(runs).toBe(3);
    expect(indexed.size).toBe(7);
    expect(last.deferred).toBe(0);
  });

  it("leaves the unbounded call untouched (the webhook path)", async () => {
    const { env, aiCalls } = mkEnv();
    const commit = mkCommit(Array.from({ length: 12 }, (_, i) => `patch ${i}`));

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit);

    expect(result.embedded).toBe(12);
    expect(result.deferred).toBe(0);
    expect(result.alreadyIndexed).toBe(0);
    expect(aiCalls.flat()).toHaveLength(12);
  });

  it("reports a fully-indexed commit as done rather than re-embedding it", async () => {
    const { env, aiCalls } = mkEnv();
    const commit = mkCommit(Array.from({ length: 3 }, (_, i) => `patch ${i}`));

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit, {
      maxFiles: 2,
      indexedFilePaths: new Set([
        "src/file-0.ts",
        "src/file-1.ts",
        "src/file-2.ts",
      ]),
    });

    expect(result).toEqual({
      embedded: 0,
      skipped: 0,
      failed: 0,
      batches: 0,
      alreadyIndexed: 3,
      deferred: 0,
    });
    expect(aiCalls).toHaveLength(0);
  });
});
