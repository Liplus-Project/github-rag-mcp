import test from 'node:test';
import assert from 'node:assert/strict';
import { build, verify } from './abstention-judge-inputs.mjs';
import { verifyResults } from './abstention-reader-results.mjs';

test('nine valid raw results retain immutable input and quotation contracts, excluding pilots', () => {
  const m = verifyResults();
  assert.equal(m.trial_count, 9); assert.equal(m.answer_count, 108);
  assert.deepEqual(m.records.map(x => x.trial), ['21', '22', '23', '31', '32', '33', '41', '42', '43']);
  assert.equal(m.provider_token_counts, 'unavailable'); assert.equal(m.resolved_backend_model, 'unobservable');
});
test('108 anonymous judge rows bijectively preserve original answers/quotes and all gold/source contexts', () => {
  const m = verify(), prepared = build();
  assert.equal(m.rows, 108); assert.equal(prepared.parent.mapping.length, 108);
  assert.equal(new Set(prepared.parent.mapping.map(x => `${x.trial}:${x.original_case_id}`)).size, 108);
  for (const p of Object.values(prepared.inputs)) {
    assert.equal(p.questions.length, 4); assert.equal(p.responses.length, 36); assert.equal(p.sources.length, 1);
    const walk = x => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (!x || typeof x !== 'object') return;
      for (const [k, v] of Object.entries(x)) {
        assert.ok(!['arm', 'trial', 'repetition', 'original_file', 'original_case_id', 'intent_id', 'model'].includes(k), `Origin identity leaked: ${k}`);
        walk(v);
      }
    };
    walk(p);
    for (const r of p.responses) assert.match(r.row_id, /^R[a-f0-9]{16}$/);
  }
});
