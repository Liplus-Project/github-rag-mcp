import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './abstention-evaluation.mjs';
import { ROOT, verifyResults } from './abstention-reader-results.mjs';
import { verify as verifyJudgeInputs } from './abstention-judge-inputs.mjs';

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const assert = (x, message) => { if (!x) throw new Error(message); };
export const AXES = ['unsupported_assertion', 'unsupported_premise_denial', 'support_evidence_loss', 'explicit_correction_loss', 'appropriate_insufficiency', 'quotation_and_target_revision_validity'];
const KEYS = ['row_id', ...AXES, 'required_fact_coverage', 'rationale'].sort().join(',');
export function validateJudgments(output, input) {
  assert(Object.keys(output).join(',') === 'judgments' && Array.isArray(output.judgments), 'Invalid judgment envelope');
  const ids = new Set(input.responses.map(x => x.row_id)), seen = new Set();
  assert(output.judgments.length === ids.size, 'Incomplete judgment rows');
  for (const row of output.judgments) {
    assert(Object.keys(row).sort().join(',') === KEYS && ids.has(row.row_id) && !seen.has(row.row_id), 'Invalid/duplicate judgment identity');
    seen.add(row.row_id);
    const response = input.responses.find(x => x.row_id === row.row_id), question = input.questions.find(x => x.question_id === response.question_id);
    for (const axis of AXES) {
      const applies = axis === 'support_evidence_loss' ? question.expected_status === 'answered' : axis === 'explicit_correction_loss' ? question.expected_status === 'premise_corrected' : axis === 'appropriate_insufficiency' ? question.expected_status === 'insufficient' : true;
      assert(applies ? typeof row[axis] === 'boolean' : row[axis] === null, 'Judgment applicability/type mismatch');
    }
    assert(['full', 'partial', 'none', 'not_applicable'].includes(row.required_fact_coverage), 'Invalid coverage');
    assert(typeof row.rationale === 'string' && [...row.rationale].length <= 200, 'Invalid rationale');
  }
  return seen.size;
}
export function importJudgments(source, root = ROOT) {
  verifyResults(root); const inputManifest = verifyJudgeInputs(root), files = {};
  for (const family of ['f02', 'f06', 'f08']) {
    const name = `judgments-${family}.json`, raw = readFileSync(join(source, name));
    assert(Buffer.from(raw.toString('utf8')).equals(raw), 'Invalid judgment UTF8');
    const rows = validateJudgments(JSON.parse(raw), read(join(root, 'judge-inputs', `${family}.json`)));
    files[family] = { file: `judgments/${name}`, sha256: sha256(raw), bytes: raw.length, rows, judge_input_sha256: inputManifest.inputs[family].sha256 };
  }
  mkdirSync(join(root, 'judgments'), { recursive: true });
  for (const [family, f] of Object.entries(files)) writeFileSync(join(root, f.file), readFileSync(join(source, `judgments-${family}.json`)));
  const manifest = { version: 1, source: 'Original recovered judgment files, unchanged raw bytes; no override or inferred scores',
    rows: 108, judge_runtime_metadata: 'not present in raw judgment artifacts; no inferred backend/token/elapsed values',
    judge_manifest_sha256: sha256(readFileSync(join(root, 'judge-manifest.json'))), files };
  writeFileSync(join(root, 'judgments-manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); return manifest;
}
export function verify(root = ROOT) {
  verifyResults(root); verifyJudgeInputs(root);
  const m = read(join(root, 'judgments-manifest.json')), all = new Set();
  assert(m.judge_manifest_sha256 === sha256(readFileSync(join(root, 'judge-manifest.json'))), 'Judge manifest changed');
  for (const [family, f] of Object.entries(m.files)) {
    const raw = readFileSync(join(root, f.file)); assert(sha256(raw) === f.sha256 && raw.length === f.bytes, 'Raw judgments changed');
    const out = JSON.parse(raw); validateJudgments(out, read(join(root, 'judge-inputs', `${family}.json`)));
    for (const r of out.judgments) { assert(!all.has(r.row_id), 'Judgment row crosses files'); all.add(r.row_id); }
  }
  assert(all.size === 108, 'Expected108 distinct judgments'); return m;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'import' && process.argv[3]) importJudgments(resolve(process.argv[3]));
    else if (process.argv[2] !== 'verify') throw new Error('Usage: node scripts/abstention-judgments.mjs import <source-dir> | verify');
    console.log(JSON.stringify(verify(), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
