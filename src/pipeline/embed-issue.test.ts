import { describe, it, expect, vi } from "vitest";
import type { Env, IssueRecord } from "../types.js";
import { processAndUpsertIssue, type GitHubIssueData } from "./embed-issue.js";
import { computeBodyHash } from "./hash.js";
import { vectorId } from "./vector-id.js";

const REPO = "acme/widgets";

function mkIssue(overrides: Partial<GitHubIssueData> = {}): GitHubIssueData {
  return {
    number: 42,
    title: "a title",
    body: "a body",
    state: "open",
    labels: [{ name: "bug" }],
    milestone: null,
    assignees: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    html_url: `https://github.com/${REPO}/issues/42`,
    ...overrides,
  };
}

/**
 * IssueStore stub holding one record. `upserts` records every write so a test can
 * assert whether the diff baseline advanced — the whole point of issue #209.
 */
function mkStore(existing: IssueRecord | null) {
  const upserts: IssueRecord[] = [];
  const stub = {
    fetch: vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/issue") {
        if (!existing) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(existing), { status: 200 });
      }
      if (url.pathname === "/upsert") {
        upserts.push((await req.json()) as IssueRecord);
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected store path: ${url.pathname}`);
    }),
  } as unknown as DurableObjectStub;
  return { stub, upserts };
}

interface EnvStubOptions {
  /** Vector returned by getByIds; null models a row with no vector (issue #210). */
  vector?: { values: number[]; metadata?: Record<string, unknown> } | null;
  vectorizeThrows?: boolean;
  ftsThrows?: boolean;
}

function mkEnv(options: EnvStubOptions = {}) {
  const vector = options.vector === undefined ? { values: [0.1, 0.2] } : options.vector;
  const upserted: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const ftsWrites: unknown[][] = [];

  const env = {
    GITHUB_TOKEN: "t",
    VECTORIZE: {
      getByIds: vi.fn(async (ids: string[]) => {
        if (options.vectorizeThrows) throw new Error("vectorize down");
        return vector ? [{ id: ids[0], ...vector }] : [];
      }),
      upsert: vi.fn(async (vectors: Array<{ id: string; metadata: Record<string, unknown> }>) => {
        upserted.push(...vectors);
      }),
    },
    DB_FTS: {
      prepare: () => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (options.ftsThrows) throw new Error("d1 down");
            ftsWrites.push(args);
            return {};
          },
        }),
      }),
    },
  } as unknown as Env;

  return { env, upserted, ftsWrites };
}

/** Stored record whose bodyHash matches `issue`, so the hash-skip path is taken. */
async function mkExisting(
  issue: GitHubIssueData,
  overrides: Partial<IssueRecord> = {},
): Promise<IssueRecord> {
  return {
    repo: REPO,
    number: issue.number,
    type: "issue",
    state: issue.state,
    title: issue.title,
    labels: issue.labels.map((l) => l.name),
    milestone: issue.milestone?.title ?? "",
    assignees: issue.assignees.map((a) => a.login),
    bodyHash: await computeBodyHash(issue.title, issue.body ?? ""),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    ...overrides,
  };
}

describe("embed-issue: metadata-only path mirrors the state change", () => {
  it("writes both the dense and the sparse side, then advances the baseline", async () => {
    const issue = mkIssue({ state: "closed" });
    const { stub, upserts } = mkStore(await mkExisting(issue, { state: "open" }));
    const { env, upserted, ftsWrites } = mkEnv();

    const result = await processAndUpsertIssue(env, stub, REPO, issue);

    expect(result).toEqual({
      embedded: false,
      skippedUnchanged: false,
      metadataUpdated: true,
      failed: false,
    });
    expect(upserted).toHaveLength(1);
    expect(upserted[0].metadata.state).toBe("closed");
    expect(upserted[0].id).toBe(await vectorId(REPO, issue.number));
    expect(ftsWrites).toHaveLength(1);
    expect(ftsWrites[0]).toContain("closed");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].state).toBe("closed");
  });

  it("skips both mirrors and still advances the baseline when nothing changed", async () => {
    const issue = mkIssue();
    const { stub, upserts } = mkStore(await mkExisting(issue));
    const { env, upserted, ftsWrites } = mkEnv();

    const result = await processAndUpsertIssue(env, stub, REPO, issue);

    expect(result.skippedUnchanged).toBe(true);
    expect(result.metadataUpdated).toBe(false);
    expect(upserted).toEqual([]);
    expect(ftsWrites).toEqual([]);
    expect(upserts).toHaveLength(1);
  });
});

describe("embed-issue: a failed mirror must stay retryable (issue #209)", () => {
  // The baseline `metadataChanged` is measured against is the IssueStore record.
  // Advancing it past a failed mirror write made the miss permanent: a state-only
  // change never brings the body change the old code was waiting for.
  it("holds the IssueStore baseline when the sparse write fails", async () => {
    const issue = mkIssue({ state: "closed" });
    const { stub, upserts } = mkStore(await mkExisting(issue, { state: "open" }));
    const { env } = mkEnv({ ftsThrows: true });

    const result = await processAndUpsertIssue(env, stub, REPO, issue);

    expect(result.failed).toBe(true);
    expect(result.metadataUpdated).toBe(false);
    expect(upserts).toEqual([]);
  });

  it("holds the IssueStore baseline when the dense write fails", async () => {
    const issue = mkIssue({ state: "closed" });
    const { stub, upserts } = mkStore(await mkExisting(issue, { state: "open" }));
    const { env } = mkEnv({ vectorizeThrows: true });

    const result = await processAndUpsertIssue(env, stub, REPO, issue);

    expect(result.failed).toBe(true);
    expect(upserts).toEqual([]);
  });

  it("retries on the next delivery because the baseline is still stale", async () => {
    const issue = mkIssue({ state: "closed" });
    const existing = await mkExisting(issue, { state: "open" });
    const failing = mkStore(existing);
    await processAndUpsertIssue(mkEnv({ ftsThrows: true }).env, failing.stub, REPO, issue);
    expect(failing.upserts).toEqual([]);

    // Same stale record, mirror healthy this time.
    const recovered = mkStore(existing);
    const { env, upserted, ftsWrites } = mkEnv();
    const result = await processAndUpsertIssue(env, recovered.stub, REPO, issue);

    expect(result.metadataUpdated).toBe(true);
    expect(upserted).toHaveLength(1);
    expect(ftsWrites).toHaveLength(1);
    expect(recovered.upserts[0].state).toBe("closed");
  });
});

describe("embed-issue: a missing vector must not swallow the sparse update", () => {
  // The sparse mirror used to be nested inside the "vector exists" branch, so rows
  // missing a vector (issue #210) lost their state update on both sides at once.
  it("still writes the sparse state and advances the baseline", async () => {
    const issue = mkIssue({ state: "closed" });
    const { stub, upserts } = mkStore(await mkExisting(issue, { state: "open" }));
    const { env, upserted, ftsWrites } = mkEnv({ vector: null });

    const result = await processAndUpsertIssue(env, stub, REPO, issue);

    expect(upserted).toEqual([]);
    expect(ftsWrites).toHaveLength(1);
    expect(ftsWrites[0]).toContain("closed");
    expect(result.failed).toBe(false);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].state).toBe("closed");
  });
});
