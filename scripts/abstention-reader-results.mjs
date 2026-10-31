import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ROOT as ORIGINAL, checkFreeze, sha256, verifyAnswers } from './abstention-evaluation.mjs';
import { ROOT as TRANSPORT, verify as verifyTransport } from './abstention-reader-transport.mjs';

export const ROOT = fileURLToPath(new URL('../experiments/abstention-reader-results-v1/', import.meta.url));
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const save = (p, x) => writeFileSync(p, JSON.stringify(x, null, 2) + '\n');
const assert = (x, message) => { if (!x) throw new Error(message); };
export const TRIALS = ['21', '22', '23', '31', '32', '33', '41', '42', '43'];
export function importResults(source, root = ROOT) {
  const transport = verifyTransport(), runLock = read(join(source, 'run-lock.json'));
  assert(runLock.requested_model === 'gpt-6.1-sol' && runLock.effort === 'medium' && runLock.fork_turns === 'none', 'Unexpected launch controls');
  assert(runLock.freeze_sha256 === checkFreeze(), 'Run-lock freeze mismatch');
  const records = [];
  // Only explicit valid trial names are opened. Pilot outputs are never read.
  for (const trial of TRIALS) {
    const arm = { 1: 'q7', 2: 'm2', 3: 'v8' }[trial[1]], repetition = Number(trial[0]) - 1;
    const input = read(join(ORIGINAL, 'reader-inputs', `${arm}.json`));
    const raw = readFileSync(join(source, `trial${trial}.json`)), output = JSON.parse(raw);
    verifyAnswers(output, input);
    records.push({ trial, arm, repetition, file: `raw/trial${trial}.json`, sha256: sha256(raw), bytes: raw.length,
      answers: output.answers.length, original_input_sha256: transport.packets[arm].original_sha256,
      transport_input_sha256: transport.packets[arm].derived_sha256, quotation_contract: 'passed', semantic_scoring: 'not performed' });
  }
  assert(records.length === 9 && records.reduce((n, x) => n + x.answers, 0) === 108, 'Expected9 trials/108 rows');
  mkdirSync(join(root, 'raw'), { recursive: true });
  for (const r of records) writeFileSync(join(root, r.file), readFileSync(join(source, `trial${r.trial}.json`)));
  const copies = [
    ['run-lock-original.json', join(source, 'run-lock.json')],
    ['transport-amendment.json', join(TRANSPORT, 'amendment.json')],
    ['transport-manifest.json', join(TRANSPORT, 'transport-manifest.json')],
  ];
  const copied = {};
  for (const [name, path] of copies) { const raw = readFileSync(path); writeFileSync(join(root, name), raw); copied[name] = sha256(raw); }
  const manifest = { version: 1, scope: 'Valid reader raw outputs only; no semantic scoring or adoption verdict',
    frozen_commit: runLock.frozen_commit, original_freeze_sha256: checkFreeze(),
    requested_model: runLock.requested_model, effort: runLock.effort, fork_turns: runLock.fork_turns,
    resolved_backend_model: 'unobservable', provider_token_counts: 'unavailable', elapsed_time: 'unavailable; run-lock creation time is not a per-call duration',
    excluded_pilots: { trials: ['01', '02', '03', '11', '12', '13'], disposition: 'Both technical pilot batches excluded before parent outcome inspection; no pilot response imported/read/scored', existing_unscored_outputs: ['02', '12'] },
    files: copied, trial_count: 9, answer_count: 108, records };
  save(join(root, 'results-manifest.json'), manifest); return manifest;
}
export function verifyResults(root = ROOT) {
  const m = read(join(root, 'results-manifest.json')); verifyTransport();
  assert(m.original_freeze_sha256 === checkFreeze(), 'Result freeze changed');
  assert(isDeepStrictEqual(m.records.map(x => x.trial), TRIALS), 'Unexpected trial inventory');
  for (const [file, hash] of Object.entries(m.files)) assert(sha256(readFileSync(join(root, file))) === hash, 'Copied provenance bytes changed');
  for (const r of m.records) {
    const raw = readFileSync(join(root, r.file)); assert(raw.length === r.bytes && sha256(raw) === r.sha256, 'Raw output changed');
    verifyAnswers(JSON.parse(raw), read(join(ORIGINAL, 'reader-inputs', `${r.arm}.json`)));
  }
  return m;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'import' && process.argv[3]) importResults(resolve(process.argv[3]));
    else if (process.argv[2] !== 'verify') throw new Error('Usage: node scripts/abstention-reader-results.mjs import <source-dir> | verify');
    const m = verifyResults(); console.log(JSON.stringify({ trials: m.trial_count, answers: m.answer_count, semantic_scoring: 'not performed', manifest_sha256: sha256(readFileSync(join(ROOT, 'results-manifest.json'))) }));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
