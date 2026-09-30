import { describe, it, expect, beforeAll, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { createMcpHandler } from 'agents/mcp/server';
import { createRagMcpServer } from './mcp.js';
import { createRemoteClient } from '../mcp-server/server/remote-client.js';
import { upsertFtsRow, queryFts } from './fts.js';
import { upsertEdges, queryNeighbors, deleteEdgesForVector } from './graph.js';
import { backfillSourceIdentities } from './backfill-source-identities.js';
import { buildFetchItem } from './fetch.js';
import { identifySource } from './memory-api.js';
import { computeBodyHash } from './pipeline/hash.js';
import { issueCommentVectorId, prReviewVectorId, prReviewCommentVectorId } from './pipeline/vector-id.js';
import { ingestIssueComment, ingestPRReview, ingestPRReviewComment } from './pipeline/embed-comment.js';
import type { Env } from './types.js';
beforeAll(() => applyD1Migrations(env.DB_FTS, env.TEST_MIGRATIONS));
const timestamp = '2026-01-01T00:00:00Z';
const seed = async (repo: string, id: string, slug: string, content: string, type: 'wiki_doc' | 'doc' = 'wiki_doc') => upsertFtsRow(env.DB_FTS, { vectorId: id, repo, type, state: 'active', labels: '', milestone: '', assignees: '', updatedAt: timestamp, docPath: slug, content });
async function client(principal = 9101, failMemory = false, failScan = false) {
  const bindings = { DB_FTS: env.DB_FTS, ISSUE_STORE: failMemory ? { idFromName: () => 'global', get: () => ({ fetch: async () => new Response('unavailable', { status: 503 }) }) } : failScan ? { idFromName: (name: string) => env.ISSUE_STORE.idFromName(name), get: (id: DurableObjectId) => { const real = env.ISSUE_STORE.get(id); return { fetch: (r: Request) => new URL(r.url).pathname === '/recent-reviews' ? Promise.resolve(new Response('synthetic unavailable', {status:503})) : real.fetch(r) }; } } : env.ISSUE_STORE } as unknown as Env;
  const handler = createMcpHandler(() => createRagMcpServer(bindings), { route: '/mcp', legacy: 'reject' });
  const remote = createRemoteClient({ workerUrl: 'https://synthetic.example', clientVersion: 'test', fetch: (async (input: any, init: any) => {
    const r = input instanceof Request ? input : new Request(input, init); const headers = new Headers(r.headers); headers.set('host', new URL(r.url).host);
    return handler(new Request(r, { headers }), bindings, { props: { githubUserId: principal, accessToken: 'synthetic-test-only' } } as any);
  }) as typeof fetch });
  const call = async (name: string, args: unknown) => { const result = await remote.callTool(name, args) as any; return { error: result.isError ?? false, payload: result.isError ? { error: result.content[0].text.startsWith('{') ? JSON.parse(result.content[0].text).error : result.content[0].text } : JSON.parse(result.content[0].text), structured: result.structuredContent }; };
  return { call, reset: () => remote.reset() };
}
const uses = (source_id: string) => ['selected', 'validated', 'used'].map(stage => ({ source_id, stage }));
describe('synthetic in-process MCP lifecycle with real DO/D1', () => {
  it('search -> explicit used -> confirmed two-hop path -> corrected; source versions survive vector migration', async () => {
    const repo = 'synthetic/e2e-path';
    await seed(repo, 'e2e-a', 'a', 'syntheticneedle'); await seed(repo, 'e2e-b', 'b', 'middle page'); await seed(repo, 'e2e-c', 'c', 'terminal page');
    await upsertEdges(env.DB_FTS, 'e2e-a', repo, 'a', [{ dstVectorId: 'e2e-b', dstSlug: 'b', edgeKind: 'mention' }]);
    await upsertEdges(env.DB_FTS, 'e2e-b', repo, 'b', [{ dstVectorId: 'e2e-c', dstSlug: 'c', edgeKind: 'mention' }]);
    const a = await client(); const b = await client(); const other = await client(9102);
    const found = (await a.call('search', { query: 'syntheticneedle', repo, fusion: 'sparse_only', rerank: false, graph_expand: true, graph_hops: 2 })).payload;
    expect(found.feedback_available).toBe(true); expect(found.timestamp).toMatch(/Z$/); expect(found.graph_results.map((r: any) => r.graph_hop)).toEqual([1,2]);
    const terminal = found.graph_results.find((r: any) => r.wiki_path === 'c'); expect(terminal.graph_path.map((e: any) => [e.src,e.dst])).toEqual([['a','b'],['b','c']]);
    expect((await a.call('record_outcome', { trace_id: found.trace_id, idempotency_key: 'premature', outcome: 'confirmed', source_ids: [terminal.source_id], reason: 'synthetic' })).payload.error).toBe('used_source_required');
    const usageArgs = { trace_id: found.trace_id, idempotency_key: 'e2e-used', uses: uses(terminal.source_id) };
    const usage = await a.call('record_source_use', usageArgs); expect(usage.error).toBe(false); expect((await b.call('record_source_use', usageArgs)).payload).toEqual(usage.payload);
    const confirmed = (await a.call('record_outcome', { trace_id: found.trace_id, idempotency_key: 'e2e-confirmed', outcome: 'confirmed', source_ids: [terminal.source_id], reason: 'Synthetic exact source checked' })).payload.data;
    expect(confirmed.changes).toHaveLength(2);
    const learned = (await b.call('search', { query: 'syntheticneedle', repo, fusion: 'sparse_only', rerank: false, graph_expand: true, graph_hops: 2, use_memory: true })).payload;
    expect(learned.results.map((r: any) => [r.source_id,r.score,r.dense_rank,r.sparse_rank])).toEqual(found.results.map((r: any) => [r.source_id,r.score,r.dense_rank,r.sparse_rank]));
    expect(learned.graph_results.find((r: any) => r.wiki_path === 'c').learned_strength).toBeGreaterThan(0.49);
    const corrected = (await b.call('record_outcome', { trace_id: found.trace_id, idempotency_key: 'e2e-corrected', outcome: 'corrected', confirmation_id: confirmed.receipt_id, reason: 'Synthetic decision corrected' })).payload.data;
    expect(corrected.changes).toHaveLength(2);
    const history = (await b.call('memory_history', { trace_id: found.trace_id })).payload.data;
    expect(history.sources.find((s: any) => s.source_id === terminal.source_id).stage).toBe('used');
    expect(history.audit.find((r: any) => r.receipt_id === confirmed.receipt_id).active_credits.every((c: any) => c.active === 0)).toBe(true);
    expect((await other.call('memory_history', { trace_id: found.trace_id })).payload.error).toBe('unknown_trace');
    expect((await other.call('record_outcome', { trace_id: found.trace_id, idempotency_key: 'cross-user', outcome: 'rolled_back', confirmation_id: confirmed.receipt_id, reason: 'synthetic' })).payload.error).toBe('unknown_trace');
    const fetch = (await a.call('search', { vector_ids: ['e2e-c'] })).payload; expect(fetch.mode).toBe('fetch'); expect(fetch.results[0].source_id).toBe(terminal.source_id);
    const empty = (await a.call('search', { query: 'absentuniquetoken', repo, fusion: 'sparse_only', rerank: false })).payload; expect(empty.count).toBe(0); expect(empty.trace_id).toBeTruthy();
    const scan = (await a.call('search', { repo, since: '2025-01-01', until: '2027-01-01' })).payload; expect(scan.mode).toBe('scan'); expect(scan.trace_id).toBeTruthy();
    await seed(repo, 'e2e-c-migrated', 'c', 'terminal page'); await deleteEdgesForVector(env.DB_FTS, 'e2e-c');
    await upsertEdges(env.DB_FTS, 'e2e-b', repo, 'b', [{ dstVectorId: 'e2e-c-migrated', dstSlug: 'c', edgeKind: 'mention' }]);
    const migrated = (await a.call('search', { vector_ids: ['e2e-c-migrated'] })).payload; expect(migrated.results[0].source_id).toBe(terminal.source_id);
    expect((await b.call('memory_history', { trace_id: found.trace_id })).payload.data.sources.find((s: any) => s.source_id === terminal.source_id).path).toEqual(terminal.graph_path);
    await a.reset(); await b.reset(); await other.reset();
  });
  it('memory failure emits no fabricated trace and input errors do not save a successful trace', async () => {
    const c = await client(9103, true);
    const result = (await c.call('search', { vector_ids: ['missing-synthetic'] })).payload;
    expect(result.memory_unavailable).toBe(true); expect(result.feedback_available).toBe(false); expect(result.trace_id).toBeUndefined();
    await c.reset();
    const normal = await client(9104);
    const before = (await normal.call('memory_history', {})).payload.data.traces.length;
    expect((await normal.call('search', { query: 'synthetic', path_prefix: '../bad/', type: 'doc' })).error).toBe(true);
    expect((await normal.call('memory_history', {})).payload.data.traces.length).toBe(before);
    await normal.reset();
  });
  it('learned same-hop candidate outside old output cap enters bounded pool; initial/default axes match', async () => {
    const repo = 'synthetic/e2e-pool'; await seed(repo, 'pool-seed', 'seed', 'poolneedle');
    const edges = [];
    for (let i = 0; i < 40; i++) { const id = 'pool-' + String(i).padStart(3,'0'); await seed(repo, id, id, 'relatedpage ' + (i === 39 ? 'lastneedle' : 'othertext')); edges.push({ dstVectorId: id, dstSlug: id, edgeKind: 'mention' }); }
    await upsertEdges(env.DB_FTS, 'pool-seed', repo, 'seed', edges);
    const c = await client(9105); const searchArgs = { query: 'poolneedle', repo, fusion: 'sparse_only', rerank: false, graph_expand: true, top_k: 1 };
    const standard = (await c.call('search', searchArgs)).payload;
    const initial = (await c.call('search', { ...searchArgs, use_memory: true })).payload;
    expect(initial.graph_results.map((s: any) => s.source_id)).toEqual(standard.graph_results.map((s: any) => s.source_id));
    // Find the same mention in reverse traversal, then credit the real seed->last edge.
    const reverse = (await c.call('search', { ...searchArgs, query: 'lastneedle' })).payload;
    const seedResult = reverse.graph_results.find((r: any) => r.wiki_path === 'seed');
    await c.call('record_source_use', { trace_id: reverse.trace_id, idempotency_key: 'pool-used', uses: uses(seedResult.source_id) });
    await c.call('record_outcome', { trace_id: reverse.trace_id, idempotency_key: 'pool-confirm', outcome: 'confirmed', source_ids: [seedResult.source_id], reason: 'Synthetic mention verified' });
    const learned = (await c.call('search', { ...searchArgs, use_memory: true })).payload;
    expect(learned.graph_results[0].wiki_path).toBe('pool-039'); expect(learned.graph_results).toHaveLength(2);
    expect(learned.graph_results.every((r: any) => r.score === undefined)).toBe(true);
    expect(learned.results.map((r: any) => [r.vector_id,r.score])).toEqual(standard.results.map((r: any) => [r.vector_id,r.score]));
    const unchanged = (await c.call('search', searchArgs)).payload; expect(unchanged.graph_results.map((r: any) => r.wiki_path)).toEqual(standard.graph_results.map((r: any) => r.wiki_path));
    // Reindex same topology never resets or cross-contaminates private learned state.
    await upsertEdges(env.DB_FTS, 'pool-seed', repo, 'seed', edges);
    expect((await c.call('search', { ...searchArgs, use_memory: true })).payload.graph_results[0].wiki_path).toBe('pool-039');
    const stranger = await client(9106); expect((await stranger.call('search', { ...searchArgs, use_memory: true })).payload.graph_results.map((s: any) => s.source_id)).toEqual(standard.graph_results.map((s: any) => s.source_id));
    await c.reset(); await stranger.reset();
  });
  it('event IDs repair unchanged legacy rows without embeddings, and versions/events never alias', async () => {
    const repo = 'synthetic/e2e-identity'; const comment = { id: 90001, body: 'Synthetic canonical comment body long enough for indexing.', user: { login: 'synthetic' }, created_at: timestamp, updated_at: timestamp, path: 'a.ts', line: 1, commit_id: 'syntheticsha' };
    const review = { ...comment, id: 90002, state: 'APPROVED', submitted_at: timestamp };
    const variants = [
      { id: await issueCommentVectorId(repo, comment.id), type: 'issue_comment' as const, ingest: () => ingestIssueComment(bindings, stub, repo, 1, comment), event: comment.id },
      { id: await prReviewVectorId(repo, review.id), type: 'pr_review' as const, ingest: () => ingestPRReview(bindings, stub, repo, 1, review), event: review.id },
      { id: await prReviewCommentVectorId(repo, comment.id), type: 'pr_review_comment' as const, ingest: () => ingestPRReviewComment(bindings, stub, repo, 1, comment), event: comment.id },
    ];
    const hash = await computeBodyHash('synthetic', comment.body);
    const stub = { fetch: async (r: Request) => Response.json({ bodyHash: r.url.includes('/review?') ? await computeBodyHash('synthetic\n\nAPPROVED', comment.body) : r.url.includes('/review-comment?') ? await computeBodyHash('synthetic\na.ts:1', comment.body) : hash }) } as unknown as DurableObjectStub;
    const bindings = { DB_FTS: env.DB_FTS } as Env;
    for (const v of variants) {
      await upsertFtsRow(env.DB_FTS, { vectorId: v.id, repo, type: v.type, state: 'active', labels: '', milestone: '', assignees: '', updatedAt: timestamp, number: 1, content: comment.body });
      const result = await v.ingest(); expect(result.skippedUnchanged).toBe(true);
      const hit = (await queryFts(env.DB_FTS, 'canonical', 50, { repo, type: v.type }))[0]; expect(v.type === 'pr_review' ? hit.reviewId : hit.commentId).toBe(v.event);
    }
    const first = await identifySource({ repo, type: 'issue_comment', number: 1, comment_id: 1, updated_at: timestamp, vector_id: 'old' }, 'keyword');
    expect((await identifySource({ repo, type: 'issue_comment', number: 1, comment_id: 1, updated_at: timestamp, vector_id: 'new' }, 'keyword')).source_id).toBe(first.source_id);
    expect((await identifySource({ repo, type: 'issue_comment', number: 1, comment_id: 2, updated_at: timestamp }, 'keyword')).source_id).not.toBe(first.source_id);
    expect((await identifySource({ repo, type: 'issue_comment', number: 1, comment_id: 1, updated_at: '2026-01-02T00:00:00Z' }, 'keyword')).source_id).not.toBe(first.source_id);
  });
  it('one failed scan surface returns retrieval but never saves a partial success trace', async () => {
    const repo = 'synthetic/partial-scan';
    const stub = env.ISSUE_STORE.get(env.ISSUE_STORE.idFromName('global'));
    await stub.fetch(new Request('http://store/upsert', { method:'POST', body:JSON.stringify({ repo, number:1, type:'issue', state:'open', title:'synthetic', labels:[], milestone:'', assignees:[], bodyHash:'synthetic', createdAt:timestamp, updatedAt:timestamp }) }));
    const c = await client(9107, false, true);
    const result = (await c.call('search', { repo, since:'2025-01-01', until:'2027-01-01' })).payload;
    expect(result.results).toHaveLength(1); expect(result.memory_unavailable).toBe(true); expect(result.feedback_available).toBe(false); expect(result.trace_id).toBeUndefined();
    expect((await c.call('memory_history', {})).payload.data.traces).toEqual([]);
    await c.reset();
  });
  it('folded doc/diff rows retain complete provenance and return separate version handles', async () => {
    const repo = 'synthetic/folded-provenance';
    await seed(repo, 'fold-doc', 'docs/a.md', 'foldneedle foldneedle documentation', 'doc');
    await upsertFtsRow(env.DB_FTS, { vectorId:'fold-diff', repo, type:'diff', state:'committed', labels:'', milestone:'', assignees:'', updatedAt:timestamp, filePath:'docs/a.md', commitSha:'syntheticcommit', content:'foldneedle' });
    const c = await client(9108); const result = (await c.call('search', { query:'foldneedle', repo, fusion:'sparse_only', rerank:false })).payload;
    expect(result.feedback_available).toBe(true); expect(result.results).toHaveLength(1);
    const primary = result.results[0]; const secondary = primary.same_entity.others[0];
    expect(primary.source_id).toBeTruthy(); expect(secondary.source_id).toBeTruthy(); expect(secondary.source_id).not.toBe(primary.source_id);
    const fetched = (await c.call('search', { vector_ids:[primary.vector_id, secondary.vector_id] })).payload;
    expect(fetched.results.map((r: any) => r.source_id)).toEqual([primary.source_id, secondary.source_id]);
    await c.reset();
  });
  it('source handles use canonical kind identity/version across all modes; optional fields never alter them', async () => {
    for (const type of ['issue', 'pull_request', 'release', 'doc', 'wiki_doc', 'diff', 'issue_comment', 'pr_review', 'pr_review_comment']) {
      const row = { repo:'synthetic/all-modes', type, number:11, updated_at:timestamp, doc_path:'docs/a.md', wiki_path:'docs/a.md', file_path:'a.ts', commit_sha:'syntheticsha', tag_name:'synthetic-v1', comment_id:123, review_id:124, content:'synthetic' };
      const original = await identifySource(row, 'keyword');
      const fetchRow = buildFetchItem('arbitrary-vector', row);
      expect((await identifySource(fetchRow, 'keyword')).source_id).toBe(original.source_id);
      const { content, commit_sha, ...scanRow } = row;
      expect((await identifySource(type === 'diff' ? row : scanRow, 'keyword')).source_id).toBe(original.source_id);
    }
  });
  it('bounded historical ID backfill repairs unchanged stored events atomically and idempotently', async () => {
    const repo = 'synthetic/historical-identity'; const stub = env.ISSUE_STORE.get(env.ISSUE_STORE.idFromName(crypto.randomUUID()));
    for (let id=1; id<=3; id++) {
      await stub.fetch(new Request('http://store/upsert-comment', { method:'POST', body:JSON.stringify({repo, commentId:id, number:1, author:'synthetic', bodyHash:'unchanged', createdAt:timestamp, updatedAt:timestamp}) }));
      await upsertFtsRow(env.DB_FTS, { vectorId:await issueCommentVectorId(repo,id), repo, type:'issue_comment', state:'active', labels:'', milestone:'', assignees:'', updatedAt:timestamp, number:1, content:'synthetic unchanged historical comment' });
    }
    const page1 = await backfillSourceIdentities(env.DB_FTS, stub, { repo, limit:2 }); expect(page1).toEqual({ scanned:2, updated:2, next_cursor:'issue_comment:2', done:false });
    const page2 = await backfillSourceIdentities(env.DB_FTS, stub, { repo, limit:2, cursor:page1.next_cursor! }); expect(page2).toEqual({ scanned:1, updated:1, next_cursor:null, done:true });
    expect((await backfillSourceIdentities(env.DB_FTS, stub, { repo, limit:2 })).updated).toBe(0);
    expect((await queryFts(env.DB_FTS, 'historical', 10, {repo})).map(r=>r.commentId).sort()).toEqual([1,2,3]);
  });

  it('live inline doc/wiki body revisions get separate source IDs while index timestamp and keyword ranks stay fixed', async () => {
    const repo = 'synthetic/live-version';
    await seed(repo, 'live-doc', 'docs/live.md', 'liveneedle indexed original', 'doc');
    await seed(repo, 'live-wiki', 'live-page', 'liveneedle indexed original');
    let liveText = 'synthetic live body version one';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://api.github.com/repos/synthetic/live-version/contents/')) return Response.json({ encoding:'base64', content:btoa(liveText) });
      if (url.startsWith('https://raw.githubusercontent.com/wiki/synthetic/live-version/')) return new Response(liveText);
      throw new Error('Unexpected synthetic fixture request');
    });
    const c = await client(9109);
    try {
      const args = { query:'liveneedle', repo, fusion:'sparse_only', rerank:false };
      const indexed = (await c.call('search', args)).payload;
      const first = (await c.call('search', { ...args, include_content:true })).payload;
      const retry = (await c.call('search', { ...args, include_content:true })).payload;
      expect(first.results).toHaveLength(2); expect(first.feedback_available).toBe(true);
      expect(first.results.map((r: any) => [r.vector_id,r.score,r.sparse_rank])).toEqual(indexed.results.map((r: any) => [r.vector_id,r.score,r.sparse_rank]));
      expect(retry.results.map((r: any) => r.source_id)).toEqual(first.results.map((r: any) => r.source_id));
      liveText = 'synthetic live body version two';
      const second = (await c.call('search', { ...args, include_content:true })).payload;
      for (const initial of first.results) {
        const changed = second.results.find((r: any) => r.vector_id === initial.vector_id);
        const snapshot = indexed.results.find((r: any) => r.vector_id === initial.vector_id);
        expect(changed.updated_at).toBe(initial.updated_at); expect(initial.updated_at).toBe(timestamp);
        expect(changed.source_id).not.toBe(initial.source_id); expect(initial.source_id).not.toBe(snapshot.source_id);
        expect(initial.content_source).toBe('github_live'); expect(initial.content_version).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(initial.provenance.version).toBe(initial.content_version); expect(initial.provenance.index_updated_at).toBe(timestamp);
        expect(snapshot.provenance.content_source).toBe('index'); expect(changed.provenance.content_source).toBe('github_live');
      }
      const fetched = (await c.call('search', { vector_ids:['live-doc','live-wiki'] })).payload;
      expect(fetched.results.map((r: any) => r.source_id)).toEqual(['live-doc','live-wiki'].map(id => indexed.results.find((r: any) => r.vector_id === id).source_id));
      const h = (await c.call('memory_history', { trace_id:first.trace_id })).payload.data;
      expect(h.sources.every((s: any) => s.provenance.content_source === 'github_live')).toBe(true);
      expect(JSON.stringify(h)).not.toContain('synthetic live body version one');
      await c.call('record_source_use', { trace_id:first.trace_id, idempotency_key:'live-used', uses:uses(first.results[0].source_id) });
      expect((await c.call('memory_history', { trace_id:second.trace_id })).payload.data.sources.every((s: any) => s.stage === 'retrieved')).toBe(true);
    } finally { vi.unstubAllGlobals(); await c.reset(); }
  });

});
