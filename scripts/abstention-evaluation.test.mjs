import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, load, validate, packets, checkFreeze, verifyAnswers } from './abstention-evaluation.mjs';

test('frozen corpus, balanced group split, provenance and exact quote offsets', () => {
  const report = validate();
  assert.equal(report.questions, 108); assert.equal(report.groups, 9);
  assert.equal(report.cross_split_family_overlap, 0); assert.match(checkFreeze(), /^[a-f0-9]{64}$/);
});
test('same-family split, reference crossing, old source and false contradiction are rejected', () => {
  const a = load(); a.split.groups[1].families.push('F01');
  assert.throws(() => validate(a), /Family crosses groups/);
  const b = load(); b.intents.intents[0].target_source = 'F02-target';
  assert.throws(() => validate(b), /crosses split/);
  const c = load(); c.exclusions.conservative_exclusions.push({ repo: 'Liplus-Project/pullcept', path_prefix: 'src/' });
  assert.throws(() => validate(c), /Excluded source/);
  const d = load(); d.gold.entries.find(x => x.intent_id.endsWith('unsupported_premise')).truth_of_unsupported_premise = 'false';
  assert.throws(() => validate(d), /does not disprove/);
});
test('invalid explicit evidence and candidate family copies cannot pass', () => {
  const a = load(); a.gold.entries[0].evidence[0].start_utf8++;
  assert.throws(() => validate(a), /Quote\/range/);
  const b = load(); b.gold.entries[1].evidence = [];
  assert.throws(() => validate(b), /explicit quotes/);
});
test('blinded packets reproduce byte-exact inputs, retain metadata and separate category mapping', () => {
  const result = packets(), categoryOrder = result.mapping.cases.map(x => x.gold.expected);
  assert.notEqual(categoryOrder.slice(0, 4).join(','), 'answered,premise_corrected,insufficient,insufficient');
  for (const [arm, packet] of Object.entries(result.reader)) {
    const saved = JSON.parse(readFileSync(join(ROOT, 'reader-inputs', `${arm}.json`), 'utf8'));
    assert.deepEqual(packet, saved);
    for (const c of packet.cases) {
      assert.match(c.id, /^Q\d{3}$/);
      assert.deepEqual(Object.keys(c).sort(), (arm === 'v8' ? ['diagnostic_note', 'documents', 'id', 'question'] : ['documents', 'id', 'question']).sort());
      assert.equal(c.documents.length, arm === 'm2' ? 0 : 1);
    }
  }
  for (let n = 0; n < 12; n++) assert.deepEqual(result.reader.q7.cases[n].documents, result.reader.v8.cases[n].documents);
});
test('freeze rejects altered bytes and unregistered extra files', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'rag275-freeze-test-'));
  try {
    cpSync(ROOT, temporary, { recursive: true }); checkFreeze(temporary);
    writeFileSync(join(temporary, 'extra.txt'), 'unregistered');
    assert.throws(() => checkFreeze(temporary), /Frozen bytes/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test('answer contract detects fabricated quotes, missing cases and empty-packet citations', () => {
  const { reader } = packets();
  const answers = { answers: reader.q7.cases.map(x => ({ id: x.id, status: 'insufficient', answer: '根拠不足。', quotes: [] })) };
  assert.equal(verifyAnswers(answers, reader.q7).quotations_checked, true);
  const ev = reader.q7.cases[0].documents[0];
  answers.answers[0].quotes = [{ source_id: ev.source_id, text: ev.excerpts[0].text.slice(0, 12) }];
  verifyAnswers(answers, reader.q7);
  assert.throws(() => verifyAnswers(answers, reader.m2), /Unsupported quote/);
  answers.answers[0].quotes[0].text = 'invented quotation not present in any source';
  assert.throws(() => verifyAnswers(answers, reader.q7), /Unsupported quote/);
  assert.throws(() => verifyAnswers({ answers: [] }, reader.q7), /Incomplete/);
});
