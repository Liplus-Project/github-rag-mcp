import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './abstention-reader-results.mjs';
import { validateJudgments } from './abstention-judgments.mjs';
import { rate, verify } from './abstention-reader-aggregate.mjs';

test('all original judgments remain bijective; status does not replace the judge axes', () => {
  const a = verify(); assert.equal(a.rows.length, 108); assert.equal(a.groups.all.unique_questions, 12);
  assert.equal(a.groups.all.source_families, 3);
  for (const arm of ['q7', 'm2', 'v8']) {
    const g = a.groups[`arm:${arm}`]; assert.equal(g.responses, 36);
    assert.deepEqual(g.common_gold.unsupported_assertion, { numerator: 0, denominator: 36, rate: 0 });
    assert.equal(g.common_gold.support_evidence_loss.denominator, 9);
    assert.equal(g.common_gold.appropriate_insufficiency.denominator, 18);
    assert.equal(g.common_gold.explicit_correction_loss.numerator, arm === 'm2' ? 9 : 0);
    assert.equal(g.common_gold.support_evidence_loss.numerator, arm === 'm2' ? 9 : 2);
    for (const repetition of [1, 2, 3]) assert.equal(a.groups[`arm:${arm}/repetition:${repetition}`].responses, 12);
  }
  assert.deepEqual(rate([null, null]), { numerator: 0, denominator: 0, rate: null });
});
test('raw judgment contract rejects duplicates, missing rows and inappropriate denominator values', () => {
  const input = JSON.parse(readFileSync(join(ROOT, 'judge-inputs/f02.json'))), original = JSON.parse(readFileSync(join(ROOT, 'judgments/judgments-f02.json')));
  const duplicate = structuredClone(original); duplicate.judgments[1] = duplicate.judgments[0];
  assert.throws(() => validateJudgments(duplicate, input), /identity/);
  const missing = structuredClone(original); missing.judgments.pop();
  assert.throws(() => validateJudgments(missing, input), /Incomplete/);
  const invalid = structuredClone(original); invalid.judgments[0].support_evidence_loss = true;
  assert.throws(() => validateJudgments(invalid, input), /applicability/);
});
test('strict-gold scope flags stay primary, grounding stays separate, holdout counts preserve exposure', () => {
  const a = verify(); assert.equal(a.scope_flags.length, 4);
  for (const flag of a.scope_flags) assert.equal(a.rows.find(x => x.row_id === flag.row_id).common_gold_judgment.support_evidence_loss, true);
  assert.equal(a.groups.all.actual_input_grounding.unsupported_actual_input_claim.denominator, 108);
  assert.equal(a.holdout_accounting.unexecuted_expressions, 60);
  assert.equal(a.holdout_accounting.group_unexposed_expressions, 36);
  assert.equal(a.holdout_accounting.unexecuted_related_en_short_expressions, 24);
  for (const r of a.rows.filter(x => x.arm === 'm2')) {
    assert.equal(r.actual_input_grounding.actual_input_source_count, 0);
    assert.equal(r.actual_input_grounding.finding, 'no_external_fact_asserted');
  }
});
