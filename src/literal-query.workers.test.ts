import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { upsertFtsRow } from './fts.js';
import { createMcpHandler } from 'agents/mcp/server';
import { createRagMcpServer } from './mcp.js';
import { createRemoteClient } from '../mcp-server/server/remote-client.js';
import type { Env } from './types.js';

// issue #251: a literal-token query under the default call gets a hint toward
// fusion: "sparse_only"; the result set itself is the same as an explicit rrf call.
beforeAll(() => applyD1Migrations(env.DB_FTS, env.TEST_MIGRATIONS));

const repo = 'literal-hint/synthetic';
const sha = '2bf5ed5' + '0'.repeat(33);

async function client() {
  const ai = vi.fn(async (model: string) => model.includes('reranker')
    ? { response: [{ id: 0, score: 0.9 }, { id: 1, score: 0.1 }] } : { data: [[0.1]] });
  // A dense-side neighbour that does not contain the token, as in the 2026-08-21 observation.
  const vectors = [{ id: 'literal-hint-release', score: 0.8, metadata: { repo, type: 'release', tag_name: 'v9.9.9', updated_at: '2026-08-01' } }];
  const bindings = { ...env, DOC_SPARSE_CONTEXT_ENABLED: 'false', AI: { run: ai }, VECTORIZE: { query: vi.fn(async () => ({ matches: vectors })) } } as unknown as Env;
  const handler = createMcpHandler(() => createRagMcpServer(bindings), { route: '/mcp', legacy: 'reject' });
  const remote = createRemoteClient({ workerUrl: 'https://synthetic.example', clientVersion: 'test', fetch: (async (input: any, init: any) => {
    const r = input instanceof Request ? input : new Request(input, init); const headers = new Headers(r.headers); headers.set('host', new URL(r.url).host);
    return handler(new Request(r, { headers }), bindings, { props: { githubUserId: 9251, accessToken: 'synthetic-test-only' } } as any);
  }) as typeof fetch });
  return {
    call: async (args: unknown) => { const r = await remote.callTool('search', args) as any; return { error: r.isError ?? false, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) }; },
    reset: () => remote.reset(),
  };
}

// Per-call memory bookkeeping (trace handle, activation decay) differs between any two calls; everything else must match.
const VOLATILE = new Set(['hint', 'trace_id', 'timestamp', 'activation']);
const strip = (v: any): any => Array.isArray(v) ? v.map(strip)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, strip(x)])) : v;

describe('literal-query hint (#251)', () => {
  beforeAll(async () => {
    await upsertFtsRow(env.DB_FTS, {
      repo, vectorId: 'literal-hint-diff', type: 'diff', state: '', labels: '', milestone: '', assignees: '',
      updatedAt: '2026-08-21', content: 'Fix rerank budget (#1562)\n\n@@ -1 +1 @@\n-old\n+new', filePath: 'src/rerank.ts', commitSha: sha,
    });
  });

  it('adds the hint to a default call and leaves the response otherwise equal to explicit rrf', async () => {
    const c = await client();
    try {
      for (const query of ['#1562', '1562', '2bf5ed5']) {
        const omitted = await c.call({ query, repo, use_memory: false });
        const explicit = await c.call({ query, repo, fusion: 'rrf', use_memory: false });
        expect(omitted.error).toBe(false);
        expect(omitted.data.mode).toBe('search');
        expect(omitted.data.fusion).toBe('rrf');
        expect(omitted.data.hint).toEqual({ reason: 'literal_query', suggest: { fusion: 'sparse_only' }, message: expect.stringContaining('sparse_only') });
        expect(explicit.data.hint).toBeUndefined();
        expect(strip(omitted.data)).toEqual(strip(explicit.data));
      }
    } finally { await c.reset(); }
  });

  it('gives no hint to an explicit fusion, a natural-language query, scan mode or fetch mode', async () => {
    const c = await client();
    try {
      const sparse = await c.call({ query: '#1562', repo, fusion: 'sparse_only', use_memory: false });
      expect(sparse.data.results.map((r: any) => r.vector_id)).toContain('literal-hint-diff');
      expect('hint' in sparse.data).toBe(false);
      expect('hint' in (await c.call({ query: 'fix rerank budget', repo, use_memory: false })).data).toBe(false);
      const scan = await c.call({ repo, since: '2026-01-01T00:00:00Z' });
      expect(scan.data.mode).toBe('scan');
      expect('hint' in scan.data).toBe(false);
      const fetched = await c.call({ query: '#1562', vector_ids: ['literal-hint-diff'] });
      expect(fetched.data.mode).toBe('fetch');
      expect('hint' in fetched.data).toBe(false);
    } finally { await c.reset(); }
  });
});
