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
import { createRagMcpServer } from "./mcp.js";
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
        "query",
        "repo",
        "rerank",
        "since",
        "sort",
        "state",
        "top_k",
        "type",
        "until",
      ].sort(),
    );

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
