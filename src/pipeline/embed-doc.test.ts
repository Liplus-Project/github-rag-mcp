import { describe, it, expect, vi } from "vitest";
import type { Env } from "../types.js";
import { processAndUpsertDoc, processAndUpsertWikiDoc } from "./embed-doc.js";

// A failed FTS5 write has to fail the whole upsert. The store record carries the
// version the next poll compares against, so writing it after a lost FTS5 row
// told the next poll the page was current, and the row stayed stale for good
// (issue #282).

const REPO = "acme/widgets";

function mkEnv(ftsFails: boolean) {
  const env = {
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) },
    VECTORIZE: { upsert: vi.fn(async () => undefined) },
    DB_FTS: {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            if (ftsFails) throw new Error("d1 down");
            return {};
          },
        }),
      }),
    },
  } as unknown as Env;
  const storeWrites: string[] = [];
  const storeStub = {
    fetch: vi.fn(async (req: Request) => {
      storeWrites.push(new URL(req.url).pathname);
      return new Response("ok");
    }),
  } as unknown as DurableObjectStub;
  return { env, storeStub, storeWrites };
}

describe("embed-doc: FTS5 failure keeps the stored version", () => {
  it("reports a doc as failed and leaves its store record alone", async () => {
    const { env, storeStub, storeWrites } = mkEnv(true);

    const result = await processAndUpsertDoc(env, storeStub, REPO, "docs/a.md", "body", "sha1");

    expect(result.failed).toBe(true);
    expect(storeWrites).toEqual([]);
  });

  it("reports a wiki page as failed and leaves its store record alone", async () => {
    const { env, storeStub, storeWrites } = mkEnv(true);

    const result = await processAndUpsertWikiDoc(env, storeStub, REPO, "Page", "md", "body");

    expect(result.failed).toBe(true);
    expect(storeWrites).toEqual([]);
  });

  it("writes the store record once the FTS5 row is in", async () => {
    const { env, storeStub, storeWrites } = mkEnv(false);

    const result = await processAndUpsertDoc(env, storeStub, REPO, "docs/a.md", "body", "sha1");

    expect(result.embedded).toBe(true);
    expect(storeWrites).toEqual(["/upsert-doc"]);
  });
});
