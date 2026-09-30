import { describe, it, expect } from 'vitest';
import { createMcpHandler } from 'agents/mcp/server';
import { createRemoteClient } from '../mcp-server/server/remote-client.js';
import { createRagMcpServer } from './mcp.js';
import type { Env } from './types.js';
import { z } from 'zod';
import { TOOLS } from '../mcp-server/server/tools.js';
import { memorySchemas, memoryResultSchema, memoryDescriptions } from './memory-contract.js';
// Bridge artifact is tested as shipped, including nested bounds and output schemas.
import { searchInputSchema, searchOutputSchema } from './search-contract.js';
import searchMirror from '../mcp-server/server/search-schema.json';
import mirror from '../mcp-server/server/memory-tools.json';
describe('all memory tools Worker / bridge contract', () => {
  it('mirrors exact nested input/output schemas and descriptions', () => {
    for (const [name, schema] of Object.entries(memorySchemas)) {
      const tool = mirror.tools.find((t: any) => t.name === name)!;
      expect(tool.inputSchema).toEqual(z.toJSONSchema(schema, { io: 'input' }));
      expect(tool.outputSchema).toEqual(z.toJSONSchema(memoryResultSchema));
      expect(tool.description).toBe(memoryDescriptions[name as keyof typeof memoryDescriptions]);
    }
    expect(mirror.tools).toHaveLength(3);
    expect(searchMirror.inputSchema).toEqual(z.toJSONSchema(searchInputSchema, { io: 'input' }));
    expect(searchMirror.outputSchema).toEqual(z.toJSONSchema(searchOutputSchema));
  });
  it('serves all schemas, instructions and truthful annotations over the real protocol', async () => {
    const endpoint = 'https://synthetic.example/mcp';
    const handler = createMcpHandler(() => createRagMcpServer({} as Env), { route: '/mcp', legacy: 'reject' });
    const remote = createRemoteClient({ workerUrl: endpoint.replace('/mcp',''), clientVersion: 'test', fetch: (async (input: any, init: any) => {
      const r = input instanceof Request ? input : new Request(input, init); const h = new Headers(r.headers); h.set('host', new URL(r.url).host);
      return handler(new Request(r, { headers: h }), {} as Env, { props: { githubUserId: 9001 } } as any);
    }) as typeof fetch });
    const client = await remote.getClient(); const list = (await client.listTools()).tools;
    for (const expected of mirror.tools) {
      const tool = list.find((t: any) => t.name === expected.name)!;
      const inputSchema = expected.inputSchema;
      const outputSchema = expected.outputSchema;
      expect(tool.inputSchema).toEqual(inputSchema); expect(tool.outputSchema).toEqual(outputSchema); expect(tool.annotations).toEqual(expected.annotations);
    }
    expect(list.map((t: any) => t.name).sort()).toEqual(TOOLS.map(t => t.name).sort());
    for (const bridge of TOOLS) { const worker = list.find((t: any) => t.name === bridge.name)!; expect(worker.inputSchema).toEqual(bridge.inputSchema); expect(worker.outputSchema).toEqual(bridge.outputSchema); expect(worker.annotations).toEqual(bridge.annotations); }
    const search = list.find((t: any) => t.name === 'search')!;
    expect(search.inputSchema).toEqual(searchMirror.inputSchema);
    expect(search.outputSchema).toEqual(searchMirror.outputSchema);
    expect(search.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    await remote.reset();
  });
});
