import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { upsertFtsRow, prepareFtsRow, queryFts, deleteFtsRow, type FtsUpsertRow } from './fts.js';
import { prepareSparseSource, sparseSourceStatement, gitBlobSha, MAX_RAW_BYTES, type PrefixSnapshot } from './doc-sparse.js';
import { backfillDocSparse, docSparseStats, handleDocSparseAdmin } from './backfill-doc-sparse.js';
import { prepareEmbeddingInput, sha256Hex } from './pipeline/hash.js';
import { processAndUpsertDoc, processAndUpsertWikiDoc } from './pipeline/embed-doc.js';
import type { Env, DocRecord } from './types.js';
import { handlePushEvent } from './webhook.js';
import { pollDocs, pollWiki } from './poller.js';
import { docVectorId, wikiDocVectorId } from './pipeline/vector-id.js';

beforeAll(async () => { await applyD1Migrations(env.DB_FTS, env.TEST_MIGRATIONS); });
afterEach(() => vi.unstubAllGlobals());
const prefix = async (id: string) => (await env.DB_FTS.prepare('SELECT * FROM search_docs WHERE vector_id=?').bind(id).first<PrefixSnapshot>())!;
const owner = (id: string) => env.DB_FTS.prepare('SELECT * FROM doc_sparse_sources WHERE vector_id=?').bind(id).first<{ coverage: string; source_version: string; prefix_revision: number; raw: string; segmented: string; row_bytes: number }>();
const store = () => env.ISSUE_STORE.get(env.ISSUE_STORE.idFromName('global'));
const runtime = (enabled = true) => ({ ...env, DOC_SPARSE_CONTEXT_ENABLED: enabled ? 'true' : undefined,
  AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) }, VECTORIZE: { upsert: vi.fn(async () => undefined) },
}) as unknown as Env;
async function seed(repo: string, id: string, body: string, legacy = false, path = 'a.md') {
  const record: DocRecord = { repo, path, blobSha: await gitBlobSha(body), updatedAt: '2026-10-13T00:00:00Z' };
  const row: FtsUpsertRow = { repo, vectorId: id, type: 'doc', state: 'active', labels: '', milestone: '', assignees: '',
    updatedAt: record.updatedAt, docPath: record.path, content: prepareEmbeddingInput(record.path, body),
    ...(legacy ? {} : { sourceVersion: record.blobSha }) };
  await upsertFtsRow(env.DB_FTS, row);
  await store().fetch(new Request('http://store/upsert-doc', { method: 'POST', body: JSON.stringify(record) }));
  return { row, record };
}
function mockBlob(body: string, sha: string, before?: () => Promise<void>) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    await before?.();
    return Response.json({ sha, encoding: 'base64', content: btoa(body) });
  }));
}

describe('independent full sparse D1 index', () => {
  it('keeps default-off doc/wiki ingest and retrieval usable before migration 0009', async () => {
    await applyD1Migrations(env.DB_FTS_DOC_LEGACY, env.TEST_MIGRATIONS.filter(m => !m.name.startsWith('0009')));
    const live = { ...runtime(false), DB_FTS: env.DB_FTS_DOC_LEGACY };
    expect((await processAndUpsertDoc(live, store(), 'sparse/legacy-schema', 'a.md', 'legacysentinel', 'old-standin')).embedded).toBe(true);
    expect((await processAndUpsertWikiDoc(live, store(), 'sparse/legacy-schema', 'Home', 'md', 'legacywiki')).embedded).toBe(true);
    expect((await queryFts(live.DB_FTS, 'legacysentinel', 10, { repo: 'sparse/legacy-schema' })).length).toBe(1);
    expect((await queryFts(live.DB_FTS, 'legacywiki', 10, { repo: 'sparse/legacy-schema' })).length).toBe(1);
    expect(await live.DB_FTS.prepare("SELECT name FROM sqlite_master WHERE name='doc_sparse_sources'").first()).toBeNull();
    const columns = (await live.DB_FTS.prepare('PRAGMA table_info(search_docs)').all<{ name: string }>()).results;
    expect(columns.some(c => c.name === 'source_version')).toBe(false);
    expect(live.VECTORIZE.upsert).toHaveBeenCalledTimes(2);
  });

  for (const route of ['push', 'doc-cron', 'wiki-cron']) it(`runs default-off ${route} on the pre-0009 schema`, async () => {
    await applyD1Migrations(env.DB_FTS_DOC_LEGACY, env.TEST_MIGRATIONS.filter(m => !m.name.startsWith('0009')));
    const live = { ...runtime(false), DB_FTS: env.DB_FTS_DOC_LEGACY };
    live.VECTORIZE.deleteByIds = vi.fn(async () => ({ count: 1, mutationId: 'test' }));
    const repo = `sparse/legacy-${route}`;
    const body = 'legacyroute';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/git/trees/')) return Response.json({ tree: [{ path: 'route.md', type: 'blob', sha: 'tree-standin' }], sha: 'tree', truncated: false });
      if (url.includes('/contents/')) return Response.json({ content: btoa(body), encoding: 'base64' });
      if (url.includes('.wiki.git/info/refs')) return new Response('refs');
      if (url.endsWith('/wiki/_pages')) return new Response(`<a href="/${repo}/wiki/Home">Home</a>`);
      if (url.endsWith('/Home.md')) return new Response(body);
      throw new Error(`Unexpected new source fetch ${url}`);
    }));
    if (route === 'push') {
      const payload = { repository: { full_name: repo, default_branch: 'main' }, ref: 'refs/heads/main',
        head_commit: { id: 'commit-standin' }, commits: [{ added: ['route.md'], modified: [], removed: [] }] };
      const response = await handlePushEvent(payload, live, store());
      expect((await response.json() as { docs: { embedded: number } }).docs.embedded).toBe(1);
      expect((await handlePushEvent({ ...payload, commits: [{ added: [], modified: [], removed: ['route.md'] }] }, live, store())).status).toBe(202);
      expect(await live.DB_FTS.prepare('SELECT vector_id FROM search_docs WHERE repo=?').bind(repo).first()).toBeNull();
    } else if (route === 'doc-cron') {
      await pollDocs(repo, live, store());
      expect((await queryFts(live.DB_FTS, body, 10, { repo })).length).toBe(1);
    } else {
      expect((await pollWiki(repo, live, store())).embedded).toBe(1);
      expect((await queryFts(live.DB_FTS, body, 10, { repo })).length).toBe(1);
    }
    expect(await live.DB_FTS.prepare("SELECT name FROM sqlite_master WHERE name='doc_sparse_sources'").first()).toBeNull();
  });

  for (const route of ['push', 'doc-poll', 'wiki-poll']) it(`removes the full owner/index through ${route}`, async () => {
    const repo = `sparse/delete-${route}`;
    const live = runtime();
    live.VECTORIZE.deleteByIds = vi.fn(async () => ({ count: 1, mutationId: 'test' }));
    const wiki = route === 'wiki-poll';
    const id = wiki ? await wikiDocVectorId(repo, 'Gone') : await docVectorId(repo, 'gone.md');
    if (wiki) {
      await processAndUpsertWikiDoc(live, store(), repo, 'Gone', 'md', 'teardownneedle');
      await processAndUpsertWikiDoc(live, store(), repo, 'Home', 'md', 'home');
    } else {
      await processAndUpsertDoc(live, store(), repo, 'gone.md', 'teardownneedle', await gitBlobSha('teardownneedle'));
    }
    expect(await owner(id)).not.toBeNull();
    if (route === 'push') {
      const response = await handlePushEvent({ repository: { full_name: repo, default_branch: 'main' }, ref: 'refs/heads/main',
        commits: [{ added: [], modified: [], removed: ['gone.md'] }] }, live, store());
      expect(response.status).toBe(202);
    } else if (route === 'doc-poll') {
      const keep = await seed(repo, 'sparse-kept', 'keep', false, 'keep.md');
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sha: 'tree', tree: [{ path: 'keep.md', type: 'blob', sha: keep.record.blobSha }], truncated: false })));
      await pollDocs(repo, live, store());
    } else {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('.wiki.git/info/refs')) return new Response('refs');
        if (url.endsWith('/wiki/_pages')) return new Response(`<a href="/${repo}/wiki/Home">Home</a>`);
        if (url.endsWith('/Home.md')) return new Response('home');
        return new Response('missing', { status: 404 });
      }));
      const summary = await pollWiki(repo, live, store());
      expect(summary.removed).toBe(1);
    }
    expect(await owner(id)).toBeNull();
    expect(await env.DB_FTS.prepare('SELECT vector_id FROM search_docs WHERE vector_id=?').bind(id).first()).toBeNull();
    expect((await env.DB_FTS.prepare("SELECT COUNT(*) AS n FROM doc_sparse_fts_v1 WHERE doc_sparse_fts_v1 MATCH 'teardownneedle'").first<{ n: number }>())!.n).toBe(0);
    await env.DB_FTS.prepare("INSERT INTO doc_sparse_fts_v1(doc_sparse_fts_v1,rank) VALUES('integrity-check',1)").run();
  });

  it('indexes the tail independently, remains one row, leaves prefix candidates unchanged', async () => {
    const body = 'prefix '.repeat(1500) + 'tailneedle';
    const { record } = await seed('sparse/tail', 'sparse-tail', body);
    const snapshot = await prefix('sparse-tail');
    const source = await prepareSparseSource('sparse-tail', 'doc', 'a.md', body, record.blobSha, snapshot.indexed_at);
    await sparseSourceStatement(env.DB_FTS, source, snapshot).all();
    await sparseSourceStatement(env.DB_FTS, source, snapshot).all();
    expect((await queryFts(env.DB_FTS, 'tailneedle', 10, { repo: 'sparse/tail' })).length).toBe(0);
    expect((await env.DB_FTS.prepare("SELECT COUNT(*) AS n FROM doc_sparse_fts_v1 WHERE doc_sparse_fts_v1 MATCH 'tailneedle'").first<{ n: number }>())!.n).toBe(1);
    expect((await owner('sparse-tail'))?.raw).toContain('tailneedle');
    expect((await docSparseStats(env.DB_FTS, { repo: 'sparse/tail', type: 'doc' })).rows[0]).toMatchObject({ coverage: 'full', count: 1 });
  });

  it('rejects stale snapshots after prefix update/delete and invalidates the old full row', async () => {
    const { row, record } = await seed('sparse/cas', 'sparse-cas', 'oldterm');
    const old = await prefix('sparse-cas');
    const source = await prepareSparseSource(row.vectorId, 'doc', 'a.md', 'oldterm', record.blobSha, old.indexed_at);
    await sparseSourceStatement(env.DB_FTS, source, old).all();
    await upsertFtsRow(env.DB_FTS, { ...row, content: 'a.md\n\nnewterm', sourceVersion: await gitBlobSha('newterm') });
    expect(await owner(row.vectorId)).toBeNull();
    expect((await sparseSourceStatement(env.DB_FTS, source, old).all()).results).toEqual([]);
    await deleteFtsRow(env.DB_FTS, row.vectorId);
    expect((await sparseSourceStatement(env.DB_FTS, source, old).all()).results).toEqual([]);
  });

  it('rolls prefix changes back when the same D1 batch fails', async () => {
    const { row } = await seed('sparse/atomic', 'sparse-atomic', 'before');
    await expect(env.DB_FTS.batch([prepareFtsRow(env.DB_FTS, { ...row, content: 'after' }),
      env.DB_FTS.prepare('INSERT INTO table_that_does_not_exist VALUES(1)')])).rejects.toThrow();
    expect((await prefix(row.vectorId)).content).toBe('a.md\n\nbefore');
  });

  it('keeps out-of-range owners out of FTS and removes owners on repo-wide delete', async () => {
    const body = 'x'.repeat(MAX_RAW_BYTES);
    const { row, record } = await seed('sparse/large', 'sparse-large', body);
    const snap = await prefix(row.vectorId);
    await sparseSourceStatement(env.DB_FTS, await prepareSparseSource(row.vectorId, 'doc', 'a.md', body, record.blobSha, snap.indexed_at), snap).all();
    expect((await owner(row.vectorId))?.coverage).toBe('out_of_range');
    await env.DB_FTS.prepare('DELETE FROM search_docs WHERE repo=?').bind('sparse/large').run();
    expect(await owner(row.vectorId)).toBeNull();
    await env.DB_FTS.prepare("INSERT INTO doc_sparse_fts_v1(doc_sparse_fts_v1,rank) VALUES('integrity-check',1)").run();
  });

  it('writes full doc/wiki and advances store only after D1 success; default off adds no owner', async () => {
    const live = runtime();
    const docBody = 'document';
    expect((await processAndUpsertDoc(live, store(), 'sparse/ingest', 'a.md', docBody, await gitBlobSha(docBody))).embedded).toBe(true);
    expect((await processAndUpsertWikiDoc(live, store(), 'sparse/ingest', 'Home', 'md', 'wiki text')).embedded).toBe(true);
    const ids = (await env.DB_FTS.prepare('SELECT vector_id FROM search_docs WHERE repo=?').bind('sparse/ingest').all<{ vector_id: string }>()).results;
    for (const id of ids) expect((await owner(id.vector_id))?.coverage).toBe('full');
    const bad = { ...live, DB_FTS: { prepare: env.DB_FTS.prepare.bind(env.DB_FTS), batch: async () => { throw new Error('full write failed'); } } } as unknown as Env;
    const writes: Request[] = [];
    const fakeStore = { fetch: async (r: Request) => { writes.push(r); return new Response('ok'); } } as unknown as DurableObjectStub;
    expect((await processAndUpsertDoc(bad, fakeStore, 'sparse/failed', 'a.md', docBody, await gitBlobSha(docBody))).failed).toBe(true);
    expect((await processAndUpsertWikiDoc(bad, fakeStore, 'sparse/failed', 'Home', 'md', docBody)).failed).toBe(true);
    expect(writes).toHaveLength(0);
    const disabled = runtime(false);
    await processAndUpsertDoc(disabled, store(), 'sparse/off', 'a.md', docBody, 'standin');
    expect((await env.DB_FTS.prepare('SELECT COUNT(*) AS n FROM doc_sparse_sources s JOIN search_docs d USING(vector_id) WHERE d.repo=?').bind('sparse/off').first<{ n: number }>())!.n).toBe(0);
    expect(disabled.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('bounded operator backfill', () => {
  for (const type of ['doc', 'wiki_doc'] as const) it(`reconciles prepared A then default-off B before enable for ${type}`, async () => {
    const repo = `sparse/reconcile-${type}`;
    const a = 'prefix '.repeat(1400) + 'tail-a';
    const b = 'prefix '.repeat(1400) + 'tail-b';
    const live = runtime(); const disabled = { ...live, DOC_SPARSE_CONTEXT_ENABLED: undefined };
    const path = type === 'doc' ? 'a.md' : 'Home';
    const id = type === 'doc' ? await docVectorId(repo, path) : await wikiDocVectorId(repo, path);
    const version = type === 'doc' ? await gitBlobSha(b) : await sha256Hex(b);
    if (type === 'doc') {
      await processAndUpsertDoc(live, store(), repo, path, a, await gitBlobSha(a));
      await processAndUpsertDoc(disabled, store(), repo, path, b, version);
      mockBlob(b, version);
    } else {
      await processAndUpsertWikiDoc(live, store(), repo, path, 'md', a);
      await processAndUpsertWikiDoc(disabled, store(), repo, path, 'md', b);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(b)));
    }
    expect((await prefix(id)).source_version).not.toBe(version);
    expect(await owner(id)).toBeNull();
    vi.mocked(live.AI.run).mockClear(); vi.mocked(live.VECTORIZE.upsert).mockClear();
    const opts = { repo, type };
    const before = await prefix(id);
    expect((await backfillDocSparse(disabled, opts)).results[0]).toMatchObject({ status: 'success', prefix_version_repair: true });
    expect((await prefix(id)).source_version).not.toBe(version);
    expect((await backfillDocSparse(disabled, { ...opts, apply: true })).results[0]).toMatchObject({ status: 'success', prefix_version_repair: true });
    expect((await prefix(id)).source_version).toBe(version);
    expect((await prefix(id)).source_revision).toBe(before.source_revision! + 1);
    expect((await owner(id))?.source_version).toBe(version);
    expect((await owner(id))?.prefix_revision).toBe(before.source_revision! + 1);
    expect((await backfillDocSparse(disabled, { ...opts, apply: true })).results[0].status).toBe('unchanged');
    expect((await docSparseStats(env.DB_FTS, opts)).rows[0]).toMatchObject({ coverage: 'full', count: 1, legacy_version_unverified: 0 });
    expect(live.AI.run).not.toHaveBeenCalled(); expect(live.VECTORIZE.upsert).not.toHaveBeenCalled();
  });

  for (const type of ['doc', 'wiki_doc'] as const) for (const race of ['same-fields-C', 'same-fields-C-plan', 'delete', 'batch-failure']) {
    it(`refuses/rolls back ${race} during version repair for ${type}`, async () => {
      const repo = `sparse/repair-${type}-${race}`;
      const path = type === 'doc' ? 'a.md' : 'Home';
      const id = type === 'doc' ? await docVectorId(repo, path) : await wikiDocVectorId(repo, path);
      const a = 'prefix '.repeat(1400) + 'tail-A'; const b = 'prefix '.repeat(1400) + 'tail-B';
      const version = type === 'doc' ? await gitBlobSha(b) : await sha256Hex(b);
      const live = runtime(); const disabled = { ...live, DOC_SPARSE_CONTEXT_ENABLED: undefined };
      if (type === 'doc') {
        await processAndUpsertDoc(live, store(), repo, path, a, await gitBlobSha(a));
        await processAndUpsertDoc(disabled, store(), repo, path, b, version);
      } else {
        await processAndUpsertWikiDoc(live, store(), repo, path, 'md', a);
        await processAndUpsertWikiDoc(disabled, store(), repo, path, 'md', b);
      }
      const before = await prefix(id);
      const duringFetch = async () => {
        if (race === 'delete') await deleteFtsRow(env.DB_FTS, id);
        if (race.startsWith('same-fields-C')) {
          // Observe C's prefix write before its DO commit, even when its changed
          // tail leaves all old text/timestamp/version fields identical.
          await env.DB_FTS.prepare('UPDATE search_docs SET content=content, updated_at=updated_at, indexed_at=indexed_at WHERE vector_id=?').bind(id).run();
        }
      };
      if (type === 'doc') mockBlob(b, version, duringFetch);
      else vi.stubGlobal('fetch', vi.fn(async () => { await duringFetch(); return new Response(b); }));
      let batchResults: D1Result[] = [];
      const db = { prepare: env.DB_FTS.prepare.bind(env.DB_FTS), batch: async (statements: D1PreparedStatement[]) => {
        if (race === 'batch-failure') return env.DB_FTS.batch([...statements, env.DB_FTS.prepare('INSERT INTO missing_repair_table VALUES(1)')]);
        batchResults = await env.DB_FTS.batch(statements); return batchResults;
      } } as unknown as D1Database;
      const result = await backfillDocSparse({ ...disabled, DB_FTS: db }, { repo, type, apply: !race.endsWith('-plan') });
      expect(result.results[0].status).toBe(race === 'batch-failure' ? 'retryable_error' : 'conflict');
      expect(await owner(id)).toBeNull();
      if (race === 'delete') expect(await env.DB_FTS.prepare('SELECT vector_id FROM search_docs WHERE vector_id=?').bind(id).first()).toBeNull();
      else {
        const after = await prefix(id);
        expect(after.source_version).toBe(before.source_version);
        expect(after.content).toBe(before.content); expect(after.indexed_at).toBe(before.indexed_at); expect(after.updated_at).toBe(before.updated_at);
        expect(after.source_revision).toBe(before.source_revision! + (race.startsWith('same-fields-C') ? 1 : 0));
      }
      if (race !== 'batch-failure' && !race.endsWith('-plan')) {
        expect(batchResults[0].results).toEqual([]); expect(batchResults[1].results).toEqual([]);
      }
      await env.DB_FTS.prepare("INSERT INTO doc_sparse_fts_v1(doc_sparse_fts_v1,rank) VALUES('integrity-check',1)").run();
      if (race === 'batch-failure') {
        expect(result.next_cursor).toBe(0);
        expect((await backfillDocSparse(disabled, { repo, type, apply: true })).results[0].status).toBe('success');
      }
    });
  }


  it('resumes a source deferred by the remaining byte budget rather than skipping it', async () => {
    const first = await seed('sparse/byte-resume', 'sparse-byte-first', 'abcdef', false, 'first.md');
    const second = await seed('sparse/byte-resume', 'sparse-byte-second', 'uvwxyz', false, 'second.md');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const one = url.endsWith(first.record.blobSha);
      return Response.json({ sha: one ? first.record.blobSha : second.record.blobSha,
        encoding: 'base64', content: btoa(one ? 'abcdef' : 'uvwxyz') });
    }));
    const opts = { repo: first.record.repo, type: 'doc' as const, apply: true, maxBytes: 10 };
    const limited = await backfillDocSparse(runtime(false), opts);
    expect(limited.results.map(r => r.status)).toEqual(['success', 'retryable_error']);
    expect(limited.results[1].reason).toBe('byte_budget_deferred');
    expect(await owner(second.row.vectorId)).toBeNull();
    const resumed = await backfillDocSparse(runtime(false), { ...opts, cursor: limited.next_cursor! });
    expect(resumed.results[0].status).toBe('success'); expect(resumed.next_cursor).toBeNull();
    expect(await owner(second.row.vectorId)).not.toBeNull();
  });

  it('requires operator authentication and rejects invalid/broad scopes', async () => {
    const live = { ...runtime(), GITHUB_TOKEN: 'test-github-fetch', DOC_SPARSE_ADMIN_TOKEN: 'test-sparse-operator' } as Env;
    const endpoint = 'http://test/admin/backfill-doc-sparse?repo=sparse/auth&type=doc';
    expect((await handleDocSparseAdmin(new Request(endpoint, { method: 'POST' }), live)).status).toBe(401);
    const invalidHeaders: Record<string, string>[] = [
      { GITHUB_TOKEN: 'test-github-fetch' },
      { Authorization: 'Bearer test-github-fetch' },
      { Authorization: 'Bearer wrong' },
      { Authorization: 'test-sparse-operator' },
      { Authorization: 'bearer test-sparse-operator' },
    ];
    for (const headers of invalidHeaders) {
      expect((await handleDocSparseAdmin(new Request(endpoint, { method: 'POST', headers }), live)).status).toBe(401);
    }
    for (const token of [undefined, '', ' ']) {
      expect((await handleDocSparseAdmin(new Request(endpoint, { method: 'POST', headers: { Authorization: 'Bearer test-sparse-operator' } }),
        { ...live, DOC_SPARSE_ADMIN_TOKEN: token })).status).toBe(401);
    }
    for (const suffix of ['&limit=11', '&max_bytes=1048577', '&cursor=-1', '&apply=yes']) {
      expect((await handleDocSparseAdmin(new Request(endpoint + suffix, { method: 'POST', headers: { Authorization: 'Bearer test-sparse-operator' } }), live)).status).toBe(400);
    }
    const planned = await handleDocSparseAdmin(new Request(endpoint, { method: 'POST', headers: { Authorization: 'Bearer test-sparse-operator' } }), live);
    expect(planned.status).toBe(200); expect(await planned.json()).toMatchObject({ mode: 'plan', scanned: 0 });
    const stats = await handleDocSparseAdmin(new Request('http://test/admin/doc-sparse-stats?repo=sparse/auth&type=doc', {
      method: 'POST', headers: { Authorization: 'Bearer test-sparse-operator' },
    }), live);
    expect(stats.status).toBe(200);
    expect((await handleDocSparseAdmin(new Request('http://test/admin/doc-sparse-stats?repo=sparse/auth&type=doc', {
      method: 'POST', headers: { GITHUB_TOKEN: 'test-github-fetch' },
    }), live)).status).toBe(401);
    const seeded = await seed('sparse/auth-fetch', 'sparse-auth-fetch', 'auth source');
    mockBlob('auth source', seeded.record.blobSha);
    const applied = await handleDocSparseAdmin(new Request('http://test/admin/backfill-doc-sparse?repo=sparse/auth-fetch&type=doc&apply=true', {
      method: 'POST', headers: { Authorization: 'Bearer test-sparse-operator' },
    }), live);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ counts: { success: 1 } });
    const fetchOptions = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((fetchOptions.headers as Record<string, string>).Authorization).toBe('Bearer test-github-fetch');
  });

  it('plans without writes, applies a legacy prefix without embedding, and skips a rerun', async () => {
    const { record } = await seed('sparse/backfill', 'sparse-backfill', 'backfill body', true);
    const live = runtime(false); mockBlob('backfill body', record.blobSha);
    const opts = { repo: record.repo, type: 'doc' as const };
    expect((await backfillDocSparse(live, opts)).results[0].status).toBe('success');
    expect(await owner('sparse-backfill')).toBeNull();
    expect((await backfillDocSparse(live, { ...opts, apply: true })).results[0].status).toBe('success');
    expect((await backfillDocSparse(live, { ...opts, apply: true })).results[0].status).toBe('unchanged');
    expect(live.AI.run).not.toHaveBeenCalled(); expect(live.VECTORIZE.upsert).not.toHaveBeenCalled();
  });

  it('reports a concurrent update as conflict without overwriting it', async () => {
    const { row, record } = await seed('sparse/backfill-race', 'sparse-backfill-race', 'old');
    mockBlob('old', record.blobSha, async () => {
      await upsertFtsRow(env.DB_FTS, { ...row, content: 'a.md\n\nnew', sourceVersion: await gitBlobSha('new') });
    });
    const result = await backfillDocSparse(runtime(false), { repo: record.repo, type: 'doc', apply: true });
    expect(result.results[0]).toMatchObject({ status: 'conflict', reason: 'prefix_changed' });
    expect(await owner(row.vectorId)).toBeNull();
  });

  it('retains the cursor at retryable errors and resumes from the same source', async () => {
    const { record } = await seed('sparse/retry', 'sparse-retry', 'retry');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const opts = { repo: record.repo, type: 'doc' as const, apply: true, limit: 1 };
    const failed = await backfillDocSparse(runtime(false), opts);
    expect(failed.next_cursor).toBe(0); expect(failed.results[0].status).toBe('retryable_error');
    mockBlob('retry', record.blobSha);
    const repaired = await backfillDocSparse(runtime(false), { ...opts, cursor: failed.next_cursor! });
    expect(repaired.results[0].status).toBe('success');
    expect((await backfillDocSparse(runtime(false), { ...opts, cursor: repaired.next_cursor! })).next_cursor).toBeNull();
  });

  it('does not invent wiki history or hashes when the bounded reader cannot acquire it', async () => {
    const live = runtime();
    await processAndUpsertWikiDoc(runtime(false), store(), 'sparse/wiki-conflict', 'Home', 'md', 'past');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('current')));
    const result = await backfillDocSparse(live, { repo: 'sparse/wiki-conflict', type: 'wiki_doc', apply: true });
    expect(result.results[0].status).toBe('conflict');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(100))));
    const large = await backfillDocSparse(live, { repo: 'sparse/wiki-conflict', type: 'wiki_doc', maxBytes: 10, apply: true });
    expect(large.results[0]).toMatchObject({ status: 'conflict', reason: 'source_byte_limit_unverified' });
    expect(large.results[0].raw_bytes).toBeUndefined();
    expect(large.source_bytes).toBe(0); expect(large.budget_exhausted).toBe(true);
    expect((await docSparseStats(env.DB_FTS, { repo: 'sparse/wiki-conflict', type: 'wiki_doc' })).rows[0]).toMatchObject({ coverage: 'unprepared' });
  });
});
