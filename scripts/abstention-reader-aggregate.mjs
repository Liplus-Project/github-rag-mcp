import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ROOT as ORIGINAL, sha256 } from './abstention-evaluation.mjs';
import { ROOT, verifyResults } from './abstention-reader-results.mjs';
import { AXES, verify as verifyJudgments } from './abstention-judgments.mjs';

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const assert = (x, message) => { if (!x) throw new Error(message); };
export function rate(values) {
  const applicable = values.filter(x => typeof x === 'boolean'), numerator = applicable.filter(Boolean).length;
  return { numerator, denominator: applicable.length, rate: applicable.length ? numerator / applicable.length : null };
}
export function aggregate(root = ROOT) {
  const results = verifyResults(root), judgments = verifyJudgments(root);
  const mapping = read(join(root, 'judge-parent-mapping.json')).mapping, audit = read(join(root, 'input-grounding-audit.json'));
  const gold = read(join(ORIGINAL, 'reader-gold.json')).cases;
  assert(audit.rows.length === 108 && new Set(audit.rows.map(x => x.row_id)).size === 108, 'Grounding audit not bijective');
  const originals = new Map(Object.values(judgments.files).flatMap(f => read(join(root, f.file)).judgments).map(x => [x.row_id, x]));
  const rows = mapping.map(m => {
    const g = gold.find(x => x.id === m.original_case_id), judgment = originals.get(m.row_id), grounding = audit.rows.find(x => x.row_id === m.row_id);
    const response = read(join(root, m.original_file)).answers[m.answer_index];
    const packet = read(join(ORIGINAL, 'reader-inputs', `${m.arm}.json`)).cases.find(x => x.id === m.original_case_id);
    assert(g && judgment && grounding && typeof grounding.unsupported_actual_input_claim === 'boolean', 'Missing row annotation');
    assert(grounding.arm === m.arm && grounding.repetition === m.repetition && grounding.original_case_id === m.original_case_id && grounding.actual_input_source_count === packet.documents.length, 'Grounding row mismatch');
    assert(response.id === m.original_case_id, 'Raw response changed');
    return { row_id: m.row_id, arm: m.arm, repetition: m.repetition, question_id: m.original_case_id,
      family: g.intent_id.slice(0, 3), category: g.intent_id.slice(4), response_quote_count: response.quotes.length,
      common_gold_judgment: judgment, actual_input_grounding: grounding };
  });
  assert(new Set(rows.map(x => x.row_id)).size === 108 && rows.length === 108, 'Aggregation not bijective');
  for (const flag of audit.scope_flags) assert(originals.get(flag.row_id)?.support_evidence_loss === true, 'Scope flag must preserve primary loss');
  const groups = new Map();
  for (const r of rows) {
    const keys = ['all', `arm:${r.arm}`, `repetition:${r.repetition}`, `category:${r.category}`, `family:${r.family}`,
      `arm:${r.arm}/repetition:${r.repetition}`, `arm:${r.arm}/category:${r.category}`, `arm:${r.arm}/family:${r.family}`,
      `arm:${r.arm}/repetition:${r.repetition}/category:${r.category}`];
    for (const key of keys) { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); }
  }
  const summarize = rs => ({ responses: rs.length, unique_questions: new Set(rs.map(x => x.question_id)).size,
    source_families: new Set(rs.map(x => x.family)).size,
    responses_with_quotes: rs.filter(x => x.response_quote_count > 0).length,
    common_gold: Object.fromEntries(AXES.map(axis => [axis, rate(rs.map(x => x.common_gold_judgment[axis]))])),
    required_fact_coverage: { denominator: rs.length, counts: Object.fromEntries(['full', 'partial', 'none', 'not_applicable'].map(k => [k, rs.filter(x => x.common_gold_judgment.required_fact_coverage === k).length])) },
    actual_input_grounding: { unsupported_actual_input_claim: rate(rs.map(x => x.actual_input_grounding.unsupported_actual_input_claim)) } });
  return { version: 1,
    scope: 'Initial12 Japanese questions /3 source families,3arms x3reader repeats=108responses. Conditional curated forced-packet ablation only; no live retrieval, full pool, score threshold or adoption efficacy.',
    unit: 'Response denominators include repeats.12 questions and3families, not108 independent intents. No statistical superiority/equivalence claim.',
    hashes: Object.fromEntries(['results-manifest.json', 'judgments-manifest.json', 'judge-parent-mapping.json', 'input-grounding-audit.json'].map(f => [f, sha256(readFileSync(join(root, f)))])),
    original_freeze_sha256: results.original_freeze_sha256, requested_model: results.requested_model, effort: results.effort,
    resolved_backend_model: results.resolved_backend_model, provider_token_counts: results.provider_token_counts, elapsed_time: results.elapsed_time,
    axes: 'Common-gold judgments are preserved exactly. Actual-input grounding is a separate author audit; common truth is not proof of available input evidence. Null means inapplicable and is excluded from denominator; denominator0 rate is null.',
    groups: Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => [k, summarize(rs)])),
    scope_flags: audit.scope_flags,
    holdout_accounting: { original_expressions: 72, consumed_families: ['F02', 'F06', 'F08'], executed_ja_questions: 12,
      unexecuted_expressions: 60, unexecuted_related_en_short_expressions: 24,
      group_unexposed_families: ['F03', 'F04', 'F09'], group_unexposed_intents: 12, group_unexposed_expressions: 36,
      warning: 'Do not call all60 unexecuted expressions independent untouched holdout. No retuning or relabeling after exposure.' },
    rows };
}
export function verify(root = ROOT) {
  const expected = aggregate(root), saved = read(join(root, 'aggregation.json'));
  assert(isDeepStrictEqual(expected, saved), 'Aggregation differs from preserved judgments/audit'); return saved;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'prepare') writeFileSync(join(ROOT, 'aggregation.json'), JSON.stringify(aggregate(), null, 2) + '\n');
    else if (process.argv[2] !== 'verify') throw new Error('Usage: node scripts/abstention-reader-aggregate.mjs [prepare|verify]');
    const out = verify(); console.log(JSON.stringify({ responses: out.rows.length, by_arm: Object.fromEntries(['q7', 'm2', 'v8'].map(a => [a, out.groups[`arm:${a}`]])) }, null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
