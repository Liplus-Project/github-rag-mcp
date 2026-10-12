import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = new URL('../experiments/abstention-replay/', import.meta.url);
export const GRID = [0, 0.001, 0.005, 0.01, 0.05, 0.1, 0.2, 0.5, 0.9];
const labels = ['support', 'contradiction', 'partial', 'irrelevant', 'unknown'];
const fail = message => { throw new Error(message); };
const str = x => typeof x === 'string' && x.trim().length > 0;
function object(x, keys) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) fail('Expected object');
  if (Object.keys(x).some(k => !keys.includes(k)) || keys.some(k => !(k in x))) fail(`Unexpected or missing fields: ${keys.join(',')}`);
}
function finite(x) { return typeof x === 'number' && Number.isFinite(x); }
export function validate(fixture, annotation) {
  object(fixture, ['version', 'scope', 'source_commit', 'queries']);
  if (fixture.version !== 1 || !str(fixture.scope) || !str(fixture.source_commit) || !Array.isArray(fixture.queries)) fail('Invalid fixture');
  object(annotation, ['version', 'entries']);
  if (annotation.version !== 1 || !Array.isArray(annotation.entries)) fail('Invalid annotation');
  const ids = new Set(), pairs = new Set();
  for (const q of fixture.queries) {
    object(q, ['id', 'query', 'category', 'language', 'retrieval', 'sparse', 'dense', 'rerank_pool_complete', 'candidates', 'graph_entities']);
    if (![q.id, q.query, q.category, q.language].every(str) || ids.has(q.id)) fail('Invalid/duplicate query');
    ids.add(q.id);
    if (!['complete', 'partial', 'unknown'].includes(q.retrieval) || typeof q.rerank_pool_complete !== 'boolean' || !Array.isArray(q.candidates) || !Array.isArray(q.graph_entities) || !q.graph_entities.every(str)) fail('Invalid retrieval state');
    object(q.sparse, ['state', 'scope', 'count']);
    if (!['filtered_pool', 'pre_filter'].includes(q.sparse.scope)) fail('Invalid sparse scope');
    if (!['complete', 'failed', 'not_run', 'unknown'].includes(q.sparse.state) || (q.sparse.count !== null && (!Number.isInteger(q.sparse.count) || q.sparse.count < 0)) || (q.sparse.state === 'complete' && q.sparse.count === null) || (q.sparse.state !== 'complete' && q.sparse.count !== null)) fail('Invalid sparse measurement');
    object(q.dense, ['pool_complete', 'max']);
    if (typeof q.dense.pool_complete !== 'boolean' || (q.dense.max !== null && !finite(q.dense.max)) || (q.dense.pool_complete && q.dense.max === null)) fail('Invalid dense measurement');
    const candidates = new Set();
    for (const c of q.candidates) {
      object(c, ['id', 'entity', 'url', 'rerank']);
      if (![c.id, c.entity, c.url].every(str) || candidates.has(c.id)) fail('Invalid/duplicate candidate');
      candidates.add(c.id); pairs.add(`${q.id}\0${c.id}`);
      object(c.rerank, ['kind', 'value']);
      if (!['model', 'synthetic', 'missing'].includes(c.rerank.kind) || (c.rerank.value !== null && !finite(c.rerank.value)) || (c.rerank.kind === 'model' && c.rerank.value === null) || (c.rerank.kind === 'missing' && c.rerank.value !== null)) fail('Invalid rerank measurement');
    }
  }
  const seen = new Set();
  for (const a of annotation.entries) {
    object(a, ['query_id', 'candidate_id', 'label', 'citation', 'conditions']);
    const key = `${a.query_id}\0${a.candidate_id}`;
    if (!pairs.has(key) || seen.has(key) || !labels.includes(a.label) || typeof a.citation !== 'string' || typeof a.conditions !== 'string') fail('Invalid annotation identity/label');
    if (a.label !== 'unknown' && (!str(a.citation) || !str(a.conditions))) fail('Gold requires citation and applicability conditions');
    seen.add(key);
  }
  if (seen.size !== pairs.size) fail('Every candidate requires an annotation (unknown allowed)');
}

export function decide(q, policy, tau) {
  if (!finite(tau) || tau < 0) fail('Invalid threshold');
  if (policy === 'baseline' || policy === 'C') return { state: 'retain', signal: null, reason: policy === 'C' ? 'reader_effect_unmeasured' : 'baseline' };
  if (!['A', 'B', 'D'].includes(policy)) fail('Unknown policy');
  const unknown = reason => ({ state: 'indeterminate', signal: null, reason });
  if (q.retrieval !== 'complete') return unknown('retrieval_not_complete');
  let signal;
  if (policy === 'A') {
    if (q.sparse.state !== 'complete') return unknown('sparse_not_complete');
    if (q.sparse.count > 0) return q.sparse.scope === 'pre_filter' ? unknown('prefilter_sparse_present_filtered_pool_unknown') : { state: 'retain', signal: null, reason: 'sparse_present' };
    if (!q.dense.pool_complete || !finite(q.dense.max)) return unknown('dense_pool_unknown');
    signal = q.dense.max;
  } else {
    if (!q.rerank_pool_complete || q.candidates.length === 0 || q.candidates.some(c => c.rerank.kind !== 'model' || !finite(c.rerank.value))) return unknown('rerank_pool_unmeasured');
    const entities = new Map();
    for (const c of q.candidates) entities.set(c.entity, Math.max(entities.get(c.entity) ?? -Infinity, c.rerank.value));
    const scores = [...entities.values()].sort((a, b) => b - a);
    if (policy === 'D' && scores.length < 2) return unknown('fewer_than_two_entities');
    signal = policy === 'B' ? scores[0] : scores[0] - scores[1];
  }
  return { state: signal < tau ? 'reject' : 'retain', signal, reason: 'measured' };
}

const rate = (numerator, denominator) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });
export function replay(fixture, annotation) {
  validate(fixture, annotation);
  const gold = new Map(annotation.entries.map(a => [`${a.query_id}\0${a.candidate_id}`, a.label]));
  const runs = [];
  for (const policy of ['baseline', 'A', 'B', 'C', 'D']) for (const tau of policy === 'baseline' ? [0] : GRID) {
    const groups = new Map(), decisions = [];
    for (const q of fixture.queries) {
      const d = decide(q, policy, tau), keep = d.state !== 'reject';
      const packet = { query_id: q.id, ...d, candidate_ids: keep ? q.candidates.map(c => c.id) : [], graph_entities: q.graph_entities };
      if (policy === 'C') packet.low_relevance = decide(q, 'B', tau);
      decisions.push(packet);
      for (const key of ['all', `category:${q.category}`, `language:${q.language}`, `category-language:${q.category}/${q.language}`]) {
        if (!groups.has(key)) groups.set(key, { queries: 0, rejected: 0, indeterminate: 0, useful_queries: 0, useful_queries_rejected: 0, candidates: Object.fromEntries(labels.map(l => [l, { total: 0, retained: 0 }])) });
        const g = groups.get(key); g.queries++; g.rejected += !keep; g.indeterminate += d.state === 'indeterminate';
        let useful = false;
        for (const c of q.candidates) {
          const l = gold.get(`${q.id}\0${c.id}`); g.candidates[l].total++; g.candidates[l].retained += keep;
          useful ||= ['support', 'contradiction', 'partial'].includes(l);
        }
        g.useful_queries += useful; g.useful_queries_rejected += useful && !keep;
      }
    }
    const metrics = Object.fromEntries([...groups].map(([key, g]) => [key, {
      query_count: g.queries, firing: rate(g.rejected, g.queries), indeterminate: rate(g.indeterminate, g.queries),
      false_rejection: rate(g.useful_queries_rejected, g.useful_queries),
      candidates: Object.fromEntries(labels.map(l => [l, { retention: rate(g.candidates[l].retained, g.candidates[l].total), lost: g.candidates[l].total - g.candidates[l].retained }]))
    }]));
    runs.push({ policy, tau, decisions, metrics });
  }
  const returned_packet_diagnostics = fixture.queries.map(q => {
    const measurable = q.candidates.length > 0 && q.candidates.every(c => c.rerank.kind === 'model');
    const entities = new Map();
    if (measurable) for (const c of q.candidates) entities.set(c.entity, Math.max(entities.get(c.entity) ?? -Infinity, c.rerank.value));
    const scores = [...entities.values()].sort((a, b) => b - a);
    return { query_id: q.id, scope: 'returned_packet_only', full_pool_verified: q.rerank_pool_complete,
      top: measurable ? scores[0] : null, gap: scores.length >= 2 ? scores[0] - scores[1] : null,
      grid: GRID.map(tau => ({ tau, B: measurable ? (scores[0] < tau ? 'reject' : 'retain') : 'indeterminate',
        D: scores.length >= 2 ? (scores[0] - scores[1] < tau ? 'reject' : 'retain') : 'indeterminate' })) };
  });
  return { scope: fixture.scope, downstream_answer_quality: 'unmeasured', returned_packet_diagnostics, runs };
}

export function runFiles(fixturePath, annotationPath) {
  const files = { fixture: fixturePath, annotation: annotationPath, schema: new URL('schema.json', ROOT), protocol: new URL('protocol.json', ROOT), runner: new URL(import.meta.url) };
  const bytes = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, readFileSync(p)]));
  const hashes = Object.fromEntries(Object.entries(bytes).map(([k, b]) => [k, createHash('sha256').update(b).digest('hex')]));
  const protocol = JSON.parse(bytes.protocol);
  if (JSON.stringify(protocol.grid) !== JSON.stringify(GRID) || protocol.comparison !== 'signal < tau' || protocol.unknown_policy !== 'retain and report indeterminate') fail('Unsupported protocol');
  return { hashes, ...replay(JSON.parse(bytes.fixture), JSON.parse(bytes.annotation)) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) fail('Usage: node scripts/abstention-replay.mjs fixture.json annotation.json output.json');
    const protectedPaths = [args[0], args[1], fileURLToPath(new URL('schema.json', ROOT)), fileURLToPath(new URL('protocol.json', ROOT)), fileURLToPath(import.meta.url)];
    if (protectedPaths.some(p => resolve(p).toLowerCase() === resolve(args[2]).toLowerCase())) fail('Output must not overwrite an input');
    if (existsSync(args[2])) {
      const outputStat = statSync(args[2]);
      if (protectedPaths.some(p => { const s = statSync(p); return s.dev === outputStat.dev && s.ino === outputStat.ino; })) fail('Output must not alias an input');
    }
    writeFileSync(args[2], JSON.stringify(runFiles(args[0], args[1]), null, 2) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
