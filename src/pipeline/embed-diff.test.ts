import { describe, it, expect, vi } from "vitest";
import type { Env } from "../types.js";
import { processAndUpsertCommitDiff, type GitHubCommitDetail } from "./embed-diff.js";
import { estimateEmbeddingTokens, MAX_EMBEDDING_BATCH_TOKENS } from "./embedding.js";
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

describe("embed-diff: the batch axis is the token budget, not the file count", () => {
  it("still sends an ordinary commit as one call", async () => {
    // 30 files well past the retired count cap of 20, each a small patch.
    const { env, aiCalls } = mkEnv();
    const commit = mkCommit(Array.from({ length: 30 }, (_, i) => `@@ -1 +1 @@\n+line ${i}`));

    const result = await processAndUpsertCommitDiff(env, mkStore(), REPO, commit);

    expect(result).toEqual({ embedded: 30, skipped: 0, failed: 0, batches: 1 });
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
        const total = call.reduce((sum, text) => sum + estimateEmbeddingTokens(text), 0);
        expect(total).toBeLessThanOrEqual(MAX_EMBEDDING_BATCH_TOKENS);
      }
    }

    // No file is dropped or duplicated on the way through the split.
    expect(aiCalls.flat()).toHaveLength(20);
    expect(new Set(upsertedIds.flat()).size).toBe(20);
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

    expect(result).toEqual({ embedded: 1, skipped: 1, failed: 0, batches: 1 });
    expect(aiCalls[0]).toHaveLength(1);
  });
});
