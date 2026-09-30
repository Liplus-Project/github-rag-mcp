import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { MemoryStore, decay, edgeKey, type SavedSource, type SavedEdge } from './memory.js';
const path: SavedEdge[] = [{ repo: 'synthetic/repo', src: 'a', dst: 'b', kind: 'mention' }, { repo: 'synthetic/repo', src: 'b', dst: 'c', kind: 'mention' }];
const source = (id = 's:synthetic'): SavedSource => ({ source_id: id, provenance: { repo: 'synthetic/repo', type: 'wiki_doc', identity: 'c', version: '2026-01-01T00:00:00Z' }, axes: ['graph'], path });
async function fixture(fn: (m: MemoryStore, advance: (ms: number) => void, sql: SqlStorage) => void) {
  const stub = env.ISSUE_STORE.get(env.ISSUE_STORE.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, (_instance, state) => { let now = Date.parse('2026-01-01T00:00:00Z'); const m = new MemoryStore(state.storage.sql, f => state.storage.transactionSync(f), () => now); fn(m, ms => { now += ms; }, state.storage.sql); });
}
function save(m: MemoryStore, p = 'github:9001', sources = [source()], mode = 'search') { return m.save(p, { request: { query: 'synthetic query', mode }, settings: { mode, fusion: 'rrf' }, sources }); }
function use(m: MemoryStore, trace: string, ids = ['s:synthetic']) {
  return m.mutate('github:9001', 'record_source_use', { trace_id: trace, idempotency_key: crypto.randomUUID(), uses: ids.flatMap(source_id => ['selected', 'validated', 'used'].map(stage => ({ source_id, stage }))) });
}
function confirm(m: MemoryStore, trace: string, key = crypto.randomUUID()) { return m.mutate('github:9001', 'record_outcome', { trace_id: trace, idempotency_key: key, outcome: 'confirmed', source_ids: ['s:synthetic'], reason: 'Synthetic source verified' }); }
describe('private SQLite memory lifecycle', () => {
  it('persists UTC zero-hit/scan/fetch traces, bounded pages, isolation and safe metadata', async () => fixture(m => {
    const zero = save(m, 'github:9001', [], 'search'); expect(zero.timestamp).toBe('2026-01-01T00:00:00.000Z');
    const scan = save(m, 'github:9001', [source()], 'scan'); save(m, 'github:9001', [source()], 'fetch'); save(m, 'github:9002');
    const list: any = m.history('github:9001', { limit: 1 }); expect(list.traces).toHaveLength(1); expect(list.next_cursor).toBeTruthy();
    expect((m.history('github:9001', { limit: 1, cursor: list.next_cursor }) as any).traces[0].trace_id).toBe(scan.trace_id);
    expect(() => m.history('github:9002', { trace_id: zero.trace_id })).toThrow('Unknown trace');
    expect(m.history('github:9001', { trace_id: zero.trace_id }).sources).toEqual([]);
    expect(() => m.history('github:9002', { cursor: scan.trace_id })).toThrow('Unknown cursor');
    expect(() => m.history('github:9001', { limit: 51 })).toThrow();
  }));
  it('stage order, atomic batch rollback, exact retries, conflicts and replay never add activation', async () => fixture(m => {
    const t = save(m); const args = { trace_id: t.trace_id, idempotency_key: 'use-1', uses: [{ source_id: 's:synthetic', stage: 'selected' }] };
    const receipt = m.mutate('github:9001', 'record_source_use', args); expect(m.mutate('github:9001', 'record_source_use', args)).toEqual(receipt);
    expect(() => m.mutate('github:9001', 'record_source_use', { ...args, uses: [{ source_id: 's:synthetic', stage: 'validated' }] })).toThrow('Idempotency conflict');
    expect(() => m.mutate('github:9001', 'record_source_use', { ...args, idempotency_key: 'bad-batch', uses: [{ source_id: 's:synthetic', stage: 'validated' }, { source_id: 'missing', stage: 'selected' }] })).toThrow();
    let h: any = m.history('github:9001', { trace_id: t.trace_id }); expect(h.sources[0].stage).toBe('selected'); expect(h.sources[0].activation.usage).toBeCloseTo(0.2);
    expect(() => confirm(m, t.trace_id)).toThrow('requires used');
    use(m, t.trace_id); const before = (m.history('github:9001', { trace_id: t.trace_id }) as any).sources[0].activation.usage;
    use(m, t.trace_id); expect((m.history('github:9001', { trace_id: t.trace_id }) as any).sources[0].activation.usage).toBe(before);
    expect(m.strengths('github:9001', [path])).toEqual([0]);
    expect(() => m.mutate('github:9002', 'record_source_use', args)).toThrow('Unknown trace');
  }));
  it('half-life, caps, backwards clock and independent activation channels', async () => fixture((m, advance) => {
    const t = save(m); use(m, t.trace_id); advance(3600000);
    let a = (m.history('github:9001', { trace_id: t.trace_id }) as any).sources[0].activation;
    expect(a.retrieved).toBeCloseTo(0.05); expect(a.usage).toBeCloseTo(0.85);
    advance(-3600001); a = (m.history('github:9001', { trace_id: t.trace_id }) as any).sources[0].activation; expect(a.retrieved).toBeCloseTo(0.1);
    for (let i = 0; i < 110; i++) { const next = save(m); use(m, next.trace_id); }
    a = (m.history('github:9001', { trace_id: t.trace_id }) as any).sources[0].activation; expect(a.retrieved).toBe(10); expect(a.usage).toBe(10); expect(Number.isFinite(a.total)).toBe(true);
    expect(decay(10, 100, 99)).toBe(10);
  }));
  it('real two-edge saved path, independent confirmation, duplicates, precise interleaved correction and audit', async () => fixture((m, advance, sql) => {
    const first = save(m); use(m, first.trace_id); const c1 = confirm(m, first.trace_id, 'confirm-1');
    expect(c1.changes).toHaveLength(2); expect(c1.saved_sources[0].path).toEqual(path); expect(m.strengths('github:9001', [path])).toEqual([0.5]);
    expect(confirm(m, first.trace_id, 'confirm-1')).toEqual(c1); confirm(m, first.trace_id, 'duplicate-confirm'); expect(m.strengths('github:9001', [path])).toEqual([0.5]);
    advance(3600000); const second = save(m); use(m, second.trace_id); confirm(m, second.trace_id); expect(m.strengths('github:9001', [path])).toEqual([0.75]);
    const reverse = { trace_id: first.trace_id, idempotency_key: 'reverse-1', outcome: 'corrected', confirmation_id: c1.receipt_id, reason: 'Synthetic evidence corrected' };
    const receipt = m.mutate('github:9001', 'record_outcome', reverse); expect(m.strengths('github:9001', [path])).toEqual([0.5]);
    expect(m.mutate('github:9001', 'record_outcome', reverse)).toEqual(receipt); expect(receipt.changes).toHaveLength(2);
    expect(sql.exec('SELECT edge FROM memory_edges').toArray().map(x => x.edge).sort()).toEqual(path.map(edgeKey).sort());
    const h: any = m.history('github:9001', { trace_id: first.trace_id, limit: 2 }); expect(h.next_cursor).toBeTruthy();
    const audit = (m.history('github:9001', { trace_id: first.trace_id, limit: 50 }) as any).audit; expect(audit.find((r: any) => r.receipt_id === c1.receipt_id).active_credits.every((x: any) => x.active === 0)).toBe(true);
    expect(() => m.mutate('github:9001', 'record_outcome', { ...reverse, trace_id: second.trace_id, idempotency_key: 'wrong-trace' })).toThrow('Unknown confirmation');
    expect(() => m.mutate('github:9001', 'record_outcome', { ...reverse, confirmation_id: undefined, idempotency_key: 'ambiguous' })).toThrow('requires confirmation_id');
  }));
  it('never creates lexical/zero-hop edges; capped credit reverses only its applied delta', async () => fixture(m => {
    const lexical = { ...source(), path: [] }; const t = save(m, 'github:9001', [lexical]); use(m, t.trace_id); expect(confirm(m, t.trace_id).changes).toEqual([]);
    let last: any; let lastTrace = '';
    for (let i = 0; i < 21; i++) { const next = save(m); use(m, next.trace_id); last = confirm(m, next.trace_id); lastTrace = next.trace_id; }
    expect(m.strengths('github:9001', [path])).toEqual([10]); expect(last.changes.every((c: any) => c.delta === 0)).toBe(true);
    m.mutate('github:9001', 'record_outcome', { trace_id: lastTrace, idempotency_key: 'capped-reversal', outcome: 'rolled_back', confirmation_id: last.receipt_id, reason: 'Synthetic rollback' }); expect(m.strengths('github:9001', [path])).toEqual([10]);
  }));
  it('concurrent requests serialize and share same-principal receipts across clients', async () => {
    const stub = env.ISSUE_STORE.get(env.ISSUE_STORE.idFromName(crypto.randomUUID()));
    const call = async (action: string, args: unknown, principal = 'github:9001') => { const res = await stub.fetch(new Request('http://store/memory', { method: 'POST', body: JSON.stringify({ principal, action, args }) })); return { status: res.status, body: await res.json() as any }; };
    const { body: t } = await call('save', { request: { mode: 'search' }, settings: {}, sources: [source()] });
    const args = { trace_id: t.trace_id, idempotency_key: 'simultaneous', uses: ['selected','validated','used'].map(stage => ({ source_id: 's:synthetic', stage })) };
    const results = await Promise.all(Array.from({ length: 8 }, () => call('record_source_use', args))); expect(new Set(results.map(r => r.body.receipt_id)).size).toBe(1);
    const h = await call('memory_history', { trace_id: t.trace_id }); expect(h.body.sources[0].activation.usage).toBeCloseTo(1.7); expect(h.body.audit).toHaveLength(1);
    expect((await call('memory_history', { trace_id: t.trace_id }, 'github:9002')).status).toBe(400);
  });
  it('save failures roll back trace and activation together', async () => fixture((m, _advance, sql) => {
    sql.exec("CREATE TRIGGER synthetic_save_failure BEFORE INSERT ON memory_activation BEGIN SELECT RAISE(ABORT, 'synthetic save failure'); END;");
    expect(() => save(m)).toThrow('synthetic save failure');
    expect(sql.exec('SELECT COUNT(*) AS n FROM memory_traces').one().n).toBe(0);
    expect(sql.exec('SELECT COUNT(*) AS n FROM memory_activation').one().n).toBe(0);
  }));

});
