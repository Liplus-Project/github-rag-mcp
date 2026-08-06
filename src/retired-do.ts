/**
 * Retired MCP-serving Durable Object classes.
 *
 * Both are retained solely to satisfy Cloudflare's "class must exist in script
 * for classes declared in past migrations" constraint (`RagMcpAgent` from the
 * v1 migration, `RagMcpAgentV2` from v2). Neither receives live traffic since
 * the stateless flip (issue #224): `/mcp` is served per request by
 * `createMcpHandler`, so no session ID resolves to a DO instance any more.
 * They exist only so `wrangler deploy` does not fail with "script does not
 * export class 'RagMcpAgent'". Deleting them needs a `deleted_classes`
 * migration, which is a separate, destructive change.
 *
 * They live apart from `mcp.ts` so that file imports nothing from
 * `cloudflare:workers` and stays loadable outside workerd — which is what lets
 * the stateless serving contract be tested in the plain node pool
 * (`mcp-stateless-contract.test.ts`).
 *
 * The Durable Objects that hold real data (`IssueStore`) are untouched by the
 * flip; only the MCP-serving classes left the path.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.js";

export class RagMcpAgent extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response("RagMcpAgent has been retired; /mcp is served statelessly", {
      status: 410,
    });
  }
}

export class RagMcpAgentV2 extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response("RagMcpAgentV2 has been retired; /mcp is served statelessly", {
      status: 410,
    });
  }
}
