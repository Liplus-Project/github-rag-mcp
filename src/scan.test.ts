import { describe, it, expect } from "vitest";
import { runScan, type ScanParams } from "./scan.js";

const params: ScanParams = { repo: "o/r", topK: 3, sort: "updated_desc", type: "issue" };
const issue = {
  repo: "o/r", number: 1, type: "pull_request", title: "PR", state: "open",
  labels: [], assignees: [], milestone: "", updatedAt: "2026-08-01", createdAt: "2026-08-01",
};

function fakeStore(probe: () => Promise<Response>, records: unknown[] = [], sourceFailure = false) {
  const calls: string[] = [];
  return {
    calls,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      calls.push(url.pathname);
      if (url.pathname === "/scan-repo-exists") {
        expect([...url.searchParams.keys()]).toEqual(["repo"]);
        expect(url.searchParams.get("repo")).toBe("o/r");
        return probe();
      }
      return sourceFailure ? new Response("failed", { status: 503 }) : Response.json(records);
    },
  };
}

describe("scan repo probe boundaries", () => {
  it.each([
    ["type", { type: "issue" }],
    ["state", { type: "pull_request", state: "closed" }],
    ["labels", { type: "pull_request", labels: ["missing"] }],
  ])("skips probe when raw candidates are removed by %s", async (_name, filters) => {
    const store = fakeStore(async () => { throw new Error("unexpected probe"); }, [issue]);
    const out = await runScan(store, { ...params, ...filters } as ScanParams);
    expect(out.rows).toEqual([]);
    expect(out.filtersUnmatched).toEqual([]);
    expect(store.calls).toEqual(["/recent"]);
  });

  it("skips probe without repo and when candidates exist", async () => {
    for (const input of [{ ...params, repo: undefined }, { ...params, type: "pull_request" as const }]) {
      const store = fakeStore(async () => { throw new Error("unexpected probe"); }, [issue]);
      const out = await runScan(store, input);
      expect(out.filtersUnmatched).toEqual([]);
      expect(store.calls).toEqual(["/recent"]);
    }
  });

  it("does not probe incomplete candidate reads", async () => {
    const store = fakeStore(async () => Response.json({ exists: false }), [], true);
    const out = await runScan(store, params);
    expect(out.incomplete).toBe(true);
    expect(out.filtersUnmatched).toEqual([]);
    expect(store.calls).toEqual(["/recent"]);
  });

  it.each([
    ["HTTP error", async () => new Response("error", { status: 500 })],
    ["transport error", async () => { throw new Error("offline"); }],
    ["invalid JSON", async () => new Response("not JSON")],
    ["missing boolean", async () => Response.json({})],
    ["wrong boolean type", async () => Response.json({ exists: 0 })],
    ["null", async () => Response.json(null)],
    ["present", async () => Response.json({ exists: true })],
  ])("does not claim absence for %s", async (_name, probe) => {
    const store = fakeStore(probe);
    expect((await runScan(store, params)).filtersUnmatched).toEqual([]);
    expect(store.calls).toEqual(["/recent", "/scan-repo-exists"]);
  });

  it("reports only an explicit successful absence result", async () => {
    const store = fakeStore(async () => Response.json({ exists: false }));
    expect((await runScan(store, params)).filtersUnmatched).toEqual(["repo"]);
  });
});
