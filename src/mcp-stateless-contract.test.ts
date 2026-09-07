/**
 * Worker <-> bridge protocol contract (issue #224).
 *
 * The Worker's protocol revision is a private contract between the two
 * artifacts of this repository: the Worker at `src/` and the npx bridge at
 * `mcp-server/`. `server.json` declares stdio transport only, so no third-party
 * client reaches the Worker directly — which is exactly why nothing outside
 * this repository verifies the contract, and why it is asserted here.
 *
 * The two sides are wired to each other in-process: the bridge's real client
 * module talks to the real `createMcpHandler` wiring over a fetch that lands on
 * the handler instead of the network. What is NOT covered is anything needing
 * Worker bindings — `tools/call` reaches Vectorize / Workers AI / D1, so the
 * call path is verified against the deployed Worker after merge, not here.
 */

import { describe, it, expect } from "vitest";
import { createMcpHandler } from "agents/mcp/server";
import { createRemoteClient } from "../mcp-server/server/remote-client.js";
import { createRagMcpServer, buildGraphItem } from "./mcp.js";
import type { GraphNeighbor } from "./graph.js";
import type { Env } from "./types.js";

const ENDPOINT = "https://github-rag-mcp.liplus.workers.dev";

const PROPS = {
  githubUserId: 4242,
  githubLogin: "smileygames",
  accessToken: "gho_test_token",
};

/**
 * The Worker's `/mcp` wiring, as `index.ts` builds it. Bindings are absent —
 * `createRagMcpServer` only captures `env`, and nothing below `tools/call`
 * dereferences it.
 */
function workerHandler() {
  const env = {} as Env;
  return createMcpHandler(() => createRagMcpServer(env), {
    route: "/mcp",
    legacy: "reject",
  });
}

/**
 * A fetch that lands on the handler. The Host header is set explicitly because
 * the handler applies DNS-rebinding protection against the endpoint hostname,
 * and a `Request` built in-process carries no Host of its own.
 */
function fetchInto(handler: ReturnType<typeof workerHandler>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const base = input instanceof Request ? input : new Request(input, init);
    const headers = new Headers(base.headers);
    headers.set("host", new URL(base.url).host);
    return handler(new Request(base, { headers }), {} as Env, {
      props: PROPS,
    } as unknown as ExecutionContext);
  }) as typeof fetch;
}

describe("worker <-> bridge stateless contract", () => {
  it("serves the bridge's pinned client without a session handshake", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const handler = workerHandler();
    const into = fetchInto(handler);

    const recording: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const body = await req.clone().text();
      seen.push({
        method: req.method,
        sessionHeader: req.headers.get("mcp-session-id"),
        body: body ? JSON.parse(body) : null,
      });
      return into(req);
    };

    const remote = createRemoteClient({
      workerUrl: ENDPOINT,
      clientVersion: "0.0.0-test",
      fetch: recording,
    });

    const client = await remote.getClient();
    const tools = await client.listTools();
    expect(tools.tools.map((t: { name: string }) => t.name)).toEqual(["search"]);

    // The whole exchange, connect included, is POST-only and session-free.
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.method).toBe("POST");
      expect(call.sessionHeader).toBeNull();
    }

    // No `initialize`: connecting to a pinned modern endpoint probes with
    // `server/discover` instead of opening a session.
    const methods = seen.map((c) => (c.body as { method?: string })?.method);
    expect(methods).not.toContain("initialize");
    expect(methods[0]).toBe("server/discover");

    // Every request carries the per-request envelope the revision requires.
    for (const call of seen) {
      const params = (call.body as { params?: { _meta?: Record<string, unknown> } })?.params;
      expect(params?._meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
      expect(params?._meta?.["io.modelcontextprotocol/clientCapabilities"]).toBeDefined();
    }

    await remote.reset();
  });

  it("publishes the full search schema over the modern wire", async () => {
    const remote = createRemoteClient({
      workerUrl: ENDPOINT,
      clientVersion: "0.0.0-test",
      fetch: fetchInto(workerHandler()),
    });

    const client = await remote.getClient();
    const [search] = (await client.listTools()).tools;

    // The drift check compares source text; this asserts the schema actually
    // survives registration and serialization to the client.
    const props = (search.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(
      [
        "assignee",
        "fusion",
        "graph_expand",
        "graph_hops",
        "include_content",
        "labels",
        "milestone",
        "path_prefix",
        "query",
        "repo",
        "rerank",
        "since",
        "sort",
        "state",
        "top_k",
        "type",
        "until",
        "vector_ids",
      ].sort(),
    );

    await remote.reset();
  });

  // gh#239: fetch mode returns the index's copy of a body, not the live source.
  // A caller that cannot tell those apart reads a prefix as a whole document,
  // so the served text — the one surface every client sees — has to say which
  // it is, and has to say that the id is a handle rather than a citation.
  it("publishes fetch mode as index-derived, truncated, and handle-keyed", async () => {
    const remote = createRemoteClient({
      workerUrl: ENDPOINT,
      clientVersion: "0.0.0-test",
      fetch: fetchInto(workerHandler()),
    });

    const client = await remote.getClient();
    const [search] = (await client.listTools()).tools;
    const description = search.description as string;

    expect(description).toContain("vector_ids");
    expect(description).toMatch(/no GitHub API call/i);

    const vectorIds = (
      search.inputSchema as { properties?: Record<string, { description?: string }> }
    ).properties?.["vector_ids"];
    expect(vectorIds?.description).toMatch(/INDEXED copy/);
    expect(vectorIds?.description).toContain("8000");
    expect(vectorIds?.description).toContain("content_truncated");
    expect(vectorIds?.description).toContain("not_found");
    expect(vectorIds?.description).toMatch(/not a durable identifier/);

    await remote.reset();
  });

  // gh#234: the two axes are only usable if the caller is told they exist.
  // The description is the one place that reaches every client, so the axis
  // split and its triage rule are asserted on the served text.
  it("publishes the keyword / relationship axis split with its triage rule", async () => {
    const remote = createRemoteClient({
      workerUrl: ENDPOINT,
      clientVersion: "0.0.0-test",
      fetch: fetchInto(workerHandler()),
    });

    const client = await remote.getClient();
    const [search] = (await client.listTools()).tools;
    const description = search.description as string;

    expect(description).toContain("graph_results");
    expect(description).toMatch(/never fused/i);
    expect(description).toMatch(/graph_hop ascending/);
    expect(description).toMatch(/BOTH axes/);

    const graphExpand = (
      search.inputSchema as { properties?: Record<string, { description?: string }> }
    ).properties?.["graph_expand"];
    expect(graphExpand?.description).toContain("graph_results");
    expect(graphExpand?.description).toMatch(/never mixed into results/);

    await remote.reset();
  });

  it("rejects the pre-flip bridge instead of serving it a compatibility lane", async () => {
    const handler = workerHandler();
    const into = fetchInto(handler);

    // Byte-shape of what the pre-#224 bridge sent as its first request.
    const res = await into(`${ENDPOINT}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "github-rag-mcp-bridge", version: "0.9.0" },
        },
        id: "init",
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("mcp-session-id")).toBeNull();

    const body = (await res.json()) as {
      error: { code: number; data?: { supported?: string[] } };
    };
    expect(body.error.code).toBe(-32022);
    // The endpoint names the one revision it serves — a single lane, stated.
    expect(body.error.data?.supported).toEqual(["2026-07-28"]);
  });
});

/**
 * Relationship-axis response contract (issue #234).
 *
 * The graph axis used to enter `results` as a `score: 0` row, which a consumer
 * could not tell apart from a candidate the rankers scored at zero. The axis is
 * separate now, and the item shape is what enforces it: no score field exists to
 * be misread. `buildGraphItem` is the single site those items are built at, so
 * asserting it needs no Worker bindings.
 */
describe("relationship axis item shape", () => {
  const neighbor: GraphNeighbor = {
    vectorId: "wiki:Liplus-Project/liplus:subtractive-structural-beauty",
    hop: 2,
    fromVectorId: "wiki:Liplus-Project/liplus:decision-structure",
  };
  const row = {
    repo: "Liplus-Project/liplus",
    type: "wiki_doc",
    doc_path: "subtractive-structural-beauty",
    number: 0,
    state: "",
    milestone: "",
    updated_at: "2026-08-01T00:00:00Z",
    content: "body text",
  };

  it("carries no ranker score of any kind", () => {
    const item = buildGraphItem(neighbor, row, "decision-structure", false);
    for (const key of [
      "score",
      "dense_score",
      "sparse_score",
      "dense_rank",
      "sparse_rank",
      "rerank_score",
    ]) {
      expect(item).not.toHaveProperty(key);
    }
  });

  it("keeps origin and hop distance as the axis's own ordering context", () => {
    const item = buildGraphItem(neighbor, row, "decision-structure", false);
    expect(item.graph_hop).toBe(2);
    expect(item.graph_from).toBe("decision-structure");
  });

  it("resolves the wiki surface: url, path field, title", () => {
    const item = buildGraphItem(neighbor, row, "decision-structure", false);
    expect(item.type).toBe("wiki_doc");
    expect(item.url).toBe(
      "https://github.com/Liplus-Project/liplus/wiki/subtractive-structural-beauty",
    );
    expect(item.wiki_path).toBe("subtractive-structural-beauty");
    expect(item.doc_path).toBeUndefined();
    expect(item.title).toBe("subtractive-structural-beauty");
    expect(item.repo).toBe("Liplus-Project/liplus");
    expect(item.updated_at).toBe("2026-08-01T00:00:00Z");
  });

  it("inlines content only when the caller asked for it", () => {
    expect(buildGraphItem(neighbor, row, "x", false).content).toBeUndefined();
    expect(buildGraphItem(neighbor, row, "x", true).content).toBe("body text");
  });

  it("falls back to the vector id as title when the row carries no path", () => {
    const item = buildGraphItem(
      neighbor,
      { repo: "owner/repo", type: "wiki_doc" },
      "seed",
      false,
    );
    expect(item.title).toBe(neighbor.vectorId);
    expect(item.url).toBe("");
  });
});
