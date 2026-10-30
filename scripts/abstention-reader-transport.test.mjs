import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT as ORIGINAL, verifyAnswers } from './abstention-evaluation.mjs';
import { build, compact, expand, verify, FROZEN_HASH } from './abstention-reader-transport.mjs';

test('transport exactly reconstructs the frozen original, all arms and every field', () => {
  const result = verify(); assert.equal(result.original_freeze_sha256, FROZEN_HASH);
  for (const [arm, packet] of Object.entries(build().packets)) {
    const original = JSON.parse(readFileSync(join(ORIGINAL, 'reader-inputs', `${arm}.json`), 'utf8'));
    assert.deepEqual(expand(JSON.parse(packet)), original);
    assert.ok(packet.length < 26000, 'Conservative compact byte-size guard');
  }
  assert.equal(result.packets.q7.unique_documents, 3); assert.equal(result.packets.m2.unique_documents, 0);
});
test('identity collisions and missing or extra references fail instead of losing evidence', () => {
  const original = { instruction: 'same', cases: [
    { id: 'A', documents: [{ source_id: 'S', text: 'first' }] },
    { id: 'B', documents: [{ source_id: 'S', text: 'second' }] },
  ] };
  assert.throws(() => compact(original), /Conflicting document/);
  const good = compact({ instruction: 'same', cases: [{ id: 'A', documents: [{ source_id: 'S', text: 'x' }] }] });
  const missing = structuredClone(good); delete missing.documents.S;
  assert.throws(() => expand(missing), /Missing referenced/);
  const extra = structuredClone(good); extra.documents.T = { source_id: 'T', text: 'unused' };
  assert.throws(() => expand(extra), /Unreferenced/);
});
test('original answer checker accepts expanded transport without an altered scoring oracle', () => {
  for (const packet of Object.values(build().packets)) {
    const input = expand(JSON.parse(packet));
    const output = { answers: input.cases.map(c => ({ id: c.id, status: 'insufficient', answer: 'Transport contract only.', quotes: [] })) };
    assert.equal(verifyAnswers(output, input).quotations_checked, true);
  }
});
