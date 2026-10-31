import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ROOT as ORIGINAL, sha256 } from './abstention-evaluation.mjs';
import { ROOT, verifyResults } from './abstention-reader-results.mjs';

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const bytes = x => Buffer.from(JSON.stringify(x) + '\n');
const assert = (x, message) => { if (!x) throw new Error(message); };
const SEED = 'rag275-blind-judge-inputs-v1-20261030';
export const INSTRUCTION = 'あなたは意味採点者です。提供された固定資料とgoldだけを使い、各responseを独立に採点してください。responseのstatus自己申告だけで正誤を決めないでください。同じ問いの他のresponseへの同調や多数決をせず、row_idごとに全項目を返してください。実行/ネットワーク/追加資料取得は禁止です。各responseのarmや反復は伏せられています。unsupported_assertionは共通gold/sourceでも支持できない断定を指します。goldで正しい主張でも実際のreader入力に根拠がなかったかどうかはこのblind資料だけでは判定せず、親が別途確認します。支持根拠の損失と明示訂正の損失はgold上で回答/訂正可能だったのに必要な内容を失ったかを判定し、正直な根拠不足と無根拠断定を混ぜないでください。根拠の不在から前提を否定した場合はunsupported_premise_denialを立ててください。引用が文字列一致していても対象版/適用条件への誤転用はquotation_and_target_revision_validity=falseです。goldの期待が根拠不足の問いではappropriate_insufficiencyを判定してください。適用しない損失/根拠不足項目はnull、判断不能はrationaleに明記してください。出力は{judgments:[{row_id,unsupported_assertion,unsupported_premise_denial,support_evidence_loss,explicit_correction_loss,appropriate_insufficiency,required_fact_coverage,quotation_and_target_revision_validity,rationale}]}。boolean項目はtrue/false、support_evidence_loss/explicit_correction_loss/appropriate_insufficiencyのみ非適用ならnull。required_fact_coverageはfull/partial/none/not_applicable。rationaleは200文字以内、主張の対象や条件を具体的に説明してください。';
export function build(root = ROOT) {
  const results = verifyResults(root), goldMap = read(join(ORIGINAL, 'reader-gold.json')).cases;
  const baseline = read(join(ORIGINAL, 'reader-inputs', 'q7.json'));
  const inputs = {}, mapping = [];
  for (const family of ['F02', 'F06', 'F08']) {
    const goldCases = goldMap.filter(g => g.intent_id.startsWith(`${family}-`));
    assert(goldCases.length === 4, 'Expected four questions per family');
    const questions = goldCases.map(g => {
      const c = baseline.cases.find(x => x.id === g.id);
      return { question_id: c.id, question: c.question, expected_status: g.gold.expected,
        required_facts: g.gold.answer, evidence: g.gold.evidence, scope: g.gold.scope,
        unsupported_premise_truth: g.gold.truth_of_unsupported_premise, corpus_audit: g.gold.corpus_audit };
    });
    const sources = baseline.cases.find(c => c.id === goldCases[0].id).documents;
    assert(goldCases.every(g => isDeepStrictEqual(baseline.cases.find(c => c.id === g.id).documents, sources)), 'Family source bytes differ');
    const rows = [];
    for (const trial of results.records) {
      const output = read(join(root, trial.file));
      for (const g of goldCases) {
        const index = output.answers.findIndex(a => a.id === g.id), original = output.answers[index];
        assert(original, 'Missing response');
        const key = `${trial.trial}:${g.id}`, rowId = `R${sha256(`${SEED}:${key}`).slice(0, 16)}`;
        const { id, ...response } = original;
        rows.push({ row_id: rowId, question_id: id, response });
        mapping.push({ row_id: rowId, judge_file: `judge-inputs/${family.toLowerCase()}.json`, trial: trial.trial, arm: trial.arm,
          repetition: trial.repetition, original_case_id: id, original_file: trial.file, answer_index: index, original_answer_sha256: sha256(bytes(original)) });
      }
    }
    rows.sort((a, b) => sha256(`${SEED}:order:${a.row_id}`).localeCompare(sha256(`${SEED}:order:${b.row_id}`)));
    assert(rows.length === 36, 'Expected36 rows per judge');
    inputs[family.toLowerCase()] = { instruction: INSTRUCTION, questions, sources, responses: rows };
  }
  assert(mapping.length === 108 && new Set(mapping.map(x => x.row_id)).size === 108 && new Set(mapping.map(x => `${x.trial}:${x.original_case_id}`)).size === 108, 'Row mapping not bijective');
  const parent = { access: 'Parent/evaluator preparation only. Do not pass this file to the judge.', seed: SEED,
    scope: '108 valid original response objects; no pilot rows; no semantic scores', mapping };
  return { inputs, parent };
}
export function verify(root = ROOT) {
  const expected = build(root), manifest = read(join(root, 'judge-manifest.json'));
  assert(sha256(readFileSync(join(root, 'results-manifest.json'))) === manifest.results_manifest_sha256, 'Result manifest changed');
  for (const [family, packet] of Object.entries(expected.inputs)) {
    const raw = readFileSync(join(root, 'judge-inputs', `${family}.json`));
    assert(raw.equals(bytes(packet)), 'Judge input changed');
    assert(sha256(raw) === manifest.inputs[family].sha256, 'Judge hash mismatch');
    for (const row of packet.responses) {
      const m = expected.parent.mapping.find(x => x.row_id === row.row_id);
      const original = read(join(root, m.original_file)).answers[m.answer_index];
      assert(isDeepStrictEqual({ id: row.question_id, ...row.response }, original), 'Original response text/quotes lost');
    }
  }
  assert(readFileSync(join(root, 'judge-parent-mapping.json')).equals(bytes(expected.parent)), 'Parent mapping changed');
  assert(sha256(readFileSync(join(root, 'judge-parent-mapping.json'))) === manifest.parent_mapping_sha256, 'Parent mapping hash mismatch');
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'prepare') {
      const { inputs, parent } = build(); mkdirSync(join(ROOT, 'judge-inputs'), { recursive: true });
      const manifest = { version: 1, results_manifest_sha256: sha256(readFileSync(join(ROOT, 'results-manifest.json'))), rows: 108,
        parent_mapping_file: 'judge-parent-mapping.json', parent_mapping_sha256: sha256(bytes(parent)), inputs: {}, semantic_scoring: 'not performed' };
      for (const [family, packet] of Object.entries(inputs)) {
        const raw = bytes(packet); writeFileSync(join(ROOT, 'judge-inputs', `${family}.json`), raw);
        manifest.inputs[family] = { file: `judge-inputs/${family}.json`, bytes: raw.length, sha256: sha256(raw), questions: 4, rows: 36 };
      }
      writeFileSync(join(ROOT, 'judge-parent-mapping.json'), bytes(parent));
      writeFileSync(join(ROOT, 'judge-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    } else if (process.argv[2] !== 'verify') throw new Error('Usage: node scripts/abstention-judge-inputs.mjs [prepare|verify]');
    console.log(JSON.stringify(verify(), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
