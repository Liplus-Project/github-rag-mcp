import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decide, replay, runFiles, validate } from './abstention-replay.mjs';

const base = new URL('../experiments/abstention-replay/', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('fixture.json', base)));
const annotation = JSON.parse(readFileSync(new URL('annotation.json', base)));
function q(scores = [0.004, 0.001]) {
  return { id: 'control', query: 'control', category: 'control', language: 'ja', retrieval: 'complete', sparse: { state: 'complete', scope: 'filtered_pool', count: 0 }, dense: { pool_complete: true, max: 0.2 }, rerank_pool_complete: true,
    candidates: scores.map((s, i) => ({ id: `c${i}`, entity: `e${i}`, url: `https://example.com/${i}`, rerank: { kind: 'model', value: s } })), graph_entities: ['independent-graph'] };
}
test('A distinguishes normal sparse presence, empty, failure and unknown dense pool', () => {
  const x = q(); assert.equal(decide(x, 'A', 0.5).state, 'reject');
  assert.equal(decide(x, 'A', 0.2).state, 'retain');
  x.dense.pool_complete = false; assert.equal(decide(x, 'A', 0.5).state, 'indeterminate');
  x.sparse.count = 1; assert.equal(decide(x, 'A', 0.5).state, 'retain');
  x.sparse.scope = 'pre_filter'; assert.equal(decide(x, 'A', 0.5).state, 'indeterminate');
  for (const state of ['failed', 'not_run', 'unknown']) { x.sparse = { state, scope: 'filtered_pool', count: null }; assert.equal(decide(x, 'A', 0.5).state, 'indeterminate'); }
});
test('B/D reject whole packet only below tau; D collapses duplicate entities and handles ties', () => {
  const x = q([0.1, 0.1]); assert.equal(decide(x, 'B', 0.1).state, 'retain');
  assert.equal(decide(x, 'B', 0.2).state, 'reject');
  assert.equal(decide(x, 'D', 0.001).state, 'reject');
  assert.equal(decide(x, 'D', 0).state, 'retain');
  x.candidates[1].entity = 'e0'; assert.equal(decide(x, 'D', 0.1).state, 'indeterminate');
  x.candidates.push({ ...x.candidates[1], id: 'c2', entity: 'e2', rerank: { kind: 'model', value: 0.01 } });
  assert.ok(Math.abs(decide(x, 'D', 0.1).signal - 0.09) < 1e-12);
});
test('missing, synthetic, partial and hidden-pool scores retain with indeterminate', () => {
  for (const policy of ['B', 'D']) {
    for (const kind of ['missing', 'synthetic']) { const x = q(); x.candidates[0].rerank = { kind, value: kind === 'missing' ? null : 1 }; assert.equal(decide(x, policy, 0.9).state, 'indeterminate'); }
    const x = q(); x.rerank_pool_complete = false; assert.equal(decide(x, policy, 0.9).state, 'indeterminate');
    x.rerank_pool_complete = true; x.retrieval = 'partial'; assert.equal(decide(x, policy, 0.9).state, 'indeterminate');
    x.retrieval = 'complete'; x.candidates[0].rerank.value = NaN; assert.equal(decide(x, policy, 0.9).state, 'indeterminate');
  }
});
test('loss metrics keep contradiction, unknown denominators, graphs and C distinct', () => {
  const x = q(), f = { version: 1, scope: 'synthetic control', source_commit: 'control', queries: [x] };
  const a = { version: 1, entries: x.candidates.map((c, i) => ({ query_id: x.id, candidate_id: c.id, label: i ? 'unknown' : 'contradiction', citation: i ? '' : 'control: explicitly not adopted', conditions: 'control only' })) };
  const r = replay(f, a), b = r.runs.find(r => r.policy === 'B' && r.tau === 0.01), c = r.runs.find(r => r.policy === 'C' && r.tau === 0.01);
  assert.deepEqual(b.decisions[0].candidate_ids, []); assert.deepEqual(b.decisions[0].graph_entities, ['independent-graph']);
  assert.deepEqual(b.metrics.all.false_rejection, { numerator: 1, denominator: 1, rate: 1 });
  assert.equal(b.metrics.all.candidates.contradiction.lost, 1); assert.equal(b.metrics.all.candidates.support.retention.rate, null);
  assert.equal(c.metrics.all.candidates.contradiction.retention.rate, 1); assert.equal(c.decisions[0].low_relevance.state, 'reject');
  assert.equal(r.downstream_answer_quality, 'unmeasured');
});
test('strict input rejects nonfinite, duplicate, synthetic gold without evidence, and private fields', () => {
  for (const mutate of [
    f => { f.queries[0].candidates[0].rerank.value = Infinity; },
    f => { f.queries.push(structuredClone(f.queries[0])); },
    f => { f.queries[0].candidates[0].source_id = 'private'; },
    f => { f.queries[0].sparse = { state: 'failed', scope: 'filtered_pool', count: 0 }; },
    f => { f.queries[0].candidates[0].rerank = { kind: 'missing', value: 0 }; },
  ]) { const f = structuredClone(fixture); mutate(f); assert.throws(() => validate(f, annotation)); }
  const a = structuredClone(annotation); a.entries[0].label = 'support'; assert.throws(() => validate(fixture, a));
  a.entries[0].label = 'unknown'; a.entries.pop(); assert.throws(() => validate(fixture, a));
});
test('six observed captures preserve conservative whole-pool and reproducible packet diagnostics', () => {
  const r = runFiles(new URL('fixture.json', base), new URL('annotation.json', base));
  assert.equal(fixture.queries.length, 6); assert.equal(r.runs.find(r => r.policy === 'A').metrics.all.firing.numerator, 0);
  assert.equal(r.runs.find(r => r.policy === 'A').metrics.all.indeterminate.numerator, 6);
  assert.equal(r.runs.find(r => r.policy === 'B').metrics.all.indeterminate.numerator, 6);
  const states = r.returned_packet_diagnostics.map(d => d.grid.find(g => g.tau === 0.01).B);
  assert.deepEqual(states, ['retain', 'retain', 'retain', 'reject', 'reject', 'reject']);
  assert.equal(r.runs[0].metrics.all.false_rejection.denominator, 0);
  for (const hash of Object.values(r.hashes)) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(r, runFiles(new URL('fixture.json', base), new URL('annotation.json', base)));
});
test('CLI refuses input overwrite and emits deterministic output outside inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abstention-replay-'));
  try {
    const f = join(dir, 'fixture.json'), a = join(dir, 'annotation.json'), out = join(dir, 'report.json');
    writeFileSync(f, JSON.stringify(fixture)); writeFileSync(a, JSON.stringify(annotation));
    const args = ['scripts/abstention-replay.mjs', f, a];
    assert.equal(spawnSync(process.execPath, [...args, f]).status, 1);
    const alias = join(dir, 'alias.json'); linkSync(f, alias);
    assert.equal(spawnSync(process.execPath, [...args, alias]).status, 1);
    assert.equal(spawnSync(process.execPath, [...args, out]).status, 0);
    const bytes = readFileSync(out); assert.equal(spawnSync(process.execPath, [...args, out]).status, 0);
    assert.deepEqual(bytes, readFileSync(out));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
