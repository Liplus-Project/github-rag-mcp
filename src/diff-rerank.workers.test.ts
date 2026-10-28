import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { upsertFtsRow } from './fts.js';
import { getDocsByVectorIds } from './graph.js';
import { prepareDiffEmbeddingInput } from './pipeline/hash.js';
import { createMcpHandler } from 'agents/mcp/server';
import { createRagMcpServer } from './mcp.js';
import { createRemoteClient } from '../mcp-server/server/remote-client.js';
import type { Env } from './types.js';

beforeAll(() => applyD1Migrations(env.DB_FTS, env.TEST_MIGRATIONS));
async function client(ai: (...args:any[])=>Promise<unknown> = vi.fn(async()=>({response:[{id:0,score:0.9},{id:1,score:0.5}]})),vectors:unknown[]=[]) {
  const bindings={...env,DOC_SPARSE_CONTEXT_ENABLED:'false',AI:{run:ai},VECTORIZE:{query:vi.fn(async()=>({matches:vectors}))}} as unknown as Env;
  const handler=createMcpHandler(()=>createRagMcpServer(bindings),{route:'/mcp',legacy:'reject'});
  const remote=createRemoteClient({workerUrl:'https://synthetic.example',clientVersion:'test',fetch:(async(input:any,init:any)=>{
    const r=input instanceof Request?input:new Request(input,init); const headers=new Headers(r.headers);headers.set('host',new URL(r.url).host);
    return handler(new Request(r,{headers}),bindings,{props:{githubUserId:9281,accessToken:'synthetic-test-only'}} as any);
  }) as typeof fetch});
  return {call:async(args:unknown)=>{const r=await remote.callTool('search',args) as any;
    return {error:r.isError??false,data:r.isError?r.content[0].text:JSON.parse(r.content[0].text)};},reset:()=>remote.reset()};
}


describe('diff rerank retrieval parity', () => {
  it('sends the same verified path/patch from sparse and dense backfill without rewriting stored bytes', async () => {
    const repo = 'diff-rerank/parity';
    const message = 'Shared headline\n\n' + 'budgetneedle shared commit prose '.repeat(100);
    const paths = ['src/first.ts', 'docs/second.md'];
    const ids = ['diff-rerank-first', 'diff-rerank-second'];
    const contents = paths.map((path, i) => prepareDiffEmbeddingInput(message, path,
      `@@ -1 +1 @@\n-old\n+budgetneedle file${i}\n` + '+actual patch bytes\n'.repeat(200)));
    for (const [i, id] of ids.entries()) await upsertFtsRow(env.DB_FTS, {
      repo, vectorId: id, type: 'diff', state: '', labels: '', milestone: '', assignees: '',
      updatedAt: '2026-10-01', content: contents[i], filePath: paths[i], commitSha: 'a'.repeat(40),
    });
    const seen: Record<string, string>[] = [];
    for (const fusion of ['sparse_only', 'dense_only']) {
      const ai = vi.fn(async (model: string, _input: unknown) => model.includes('reranker')
        ? { response: [{ id: 1, score: 0.5 }, { id: 0, score: 0.5 }] } : { data: [[0.1]] });
      const vectors = ids.map((id, i) => ({ id, score: 0.9 - i / 10, metadata: {
        repo, type: 'diff', file_path: paths[i], commit_sha: 'a'.repeat(40), updated_at: '2026-10-01',
      } }));
      const c = await client(ai, vectors);
      try {
        const r = await c.call({ query: 'budgetneedle', repo, type: 'diff', fusion, use_memory: false, graph_expand: false });
        expect(r.error).toBe(false);
        expect(r.data.rerank_applied).toBe(true);
        expect(r.data.results.map((v: any) => v.vector_id).sort()).toEqual([...ids].sort());
        const calls = ai.mock.calls.filter(([model]) => model.includes('reranker'));
        expect(calls).toHaveLength(1);
        const contexts = (calls[0][1] as { contexts: { text: string }[] }).contexts;
        const byPath: Record<string, string> = {};
        for (const { text } of contexts) {
          const i = paths.findIndex(p => text.startsWith(p + '\n\n'));
          expect(i).toBeGreaterThanOrEqual(0);
          expect(text).toContain(`+budgetneedle file${i}`);
          expect(text).toContain('Shared headline');
          expect(text.length + 'budgetneedle'.length).toBeLessThanOrEqual(1700);
          byPath[paths[i]] = text;
        }
        seen.push(byPath);
        ai.mockClear();
        const disabled = await c.call({ query: 'budgetneedle', repo, type: 'diff', fusion, rerank: false, use_memory: false, graph_expand: false });
        expect(disabled.data.rerank_applied).toBe(false);
        expect(ai.mock.calls.filter(([model]) => model.includes('reranker'))).toHaveLength(0);
      } finally { await c.reset(); }
    }
    expect(seen[0]).toEqual(seen[1]);
    const stored = await getDocsByVectorIds(env.DB_FTS, ids);
    expect(ids.map(id => stored.get(id)!.content)).toEqual(contents);
  });
});

