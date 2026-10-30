import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ROOT as ORIGINAL, checkFreeze, sha256 } from './abstention-evaluation.mjs';

export const ROOT = fileURLToPath(new URL('../experiments/abstention-reader-transport-v1/', import.meta.url));
export const FROZEN_HASH = 'e4962e8e62ef2aa7584982ccda63ed9b34c173beea2fbadeeac740e3cd5bf321';
const INPUT_HASHES = {
  q7: '6d08686fca4a9b462e77e472c1a48c94ec04eb9203c17bca97c59f75d83efe7c',
  m2: 'cc513f58b81732fc8665695f49e063c51c62008c8b12b2f24d3d75e9f4bd2c85',
  v8: 'd4809869d582e89acb0c9a7fecc86a1f90072998055543b694ce9cdebd859383',
};
export const TRANSPORT_INSTRUCTION = 'documents is a dictionary keyed by document ID. For each case, document_ids lists its documents in the original order: read each referenced complete dictionary value as that case\'s documents. Shared documents apply independently to every referencing case. An empty list means no documents. This is lossless input transport only; keep the original instruction, questions and diagnostic notes unchanged.';
const assert = (x, message) => { if (!x) throw new Error(message); };
const bytes = x => Buffer.from(JSON.stringify(x) + '\n');

export function compact(original) {
  const documents = {}, cases = original.cases.map(c => {
    const { documents: docs, ...rest } = c;
    return { ...rest, document_ids: docs.map(d => {
      const id = d.source_id;
      assert(typeof id === 'string' && id && !['__proto__', 'constructor', 'prototype'].includes(id), 'Unsafe document ID');
      assert(!Object.hasOwn(documents, id) || isDeepStrictEqual(documents[id], d), 'Conflicting document identity');
      documents[id] = d; return id;
    }) };
  });
  return { instruction: original.instruction, transport_instruction: TRANSPORT_INSTRUCTION, documents, cases };
}
export function expand(packet) {
  assert(packet.transport_instruction === TRANSPORT_INSTRUCTION, 'Changed transport instruction');
  const used = new Set();
  const cases = packet.cases.map(c => {
    const { document_ids: ids, ...rest } = c;
    assert(Array.isArray(ids), 'Missing document references');
    return { ...rest, documents: ids.map(id => {
      assert(Object.hasOwn(packet.documents, id), 'Missing referenced document'); used.add(id); return packet.documents[id];
    }) };
  });
  assert(Object.keys(packet.documents).every(id => used.has(id)), 'Unreferenced document');
  return { instruction: packet.instruction, cases };
}
export function build(originalRoot = ORIGINAL) {
  assert(checkFreeze(originalRoot) === FROZEN_HASH, 'Original freeze changed');
  const manifest = { version: 1, original_commit: '49a82484aa4f8fc5f72ca18db57ffd7a9b246827', original_freeze_sha256: FROZEN_HASH,
    amendment: 'amendment.json', amendment_sha256: sha256(readFileSync(join(ROOT, 'amendment.json'))),
    equivalence: 'Expand dictionary references; JSON deep equality with original, including every string byte value and array order', packets: {} };
  const packets = {};
  for (const [arm, expected] of Object.entries(INPUT_HASHES)) {
    const input = readFileSync(join(originalRoot, 'reader-inputs', `${arm}.json`));
    assert(sha256(input) === expected, 'Original reader bytes changed');
    const original = JSON.parse(input), packet = compact(original), output = bytes(packet);
    assert(isDeepStrictEqual(expand(packet), original), 'Lossy compact packet');
    packets[arm] = output;
    manifest.packets[arm] = { original_file: `../abstention-evaluation-v1/reader-inputs/${arm}.json`, original_sha256: expected,
      derived_file: `${arm}.json`, derived_sha256: sha256(output), original_bytes: input.length, derived_bytes: output.length,
      cases: packet.cases.length, unique_documents: Object.keys(packet.documents).length, reconstructed_deep_equal: true };
  }
  return { manifest, packets };
}
export function verify(root = ROOT, originalRoot = ORIGINAL) {
  const expected = build(originalRoot), saved = JSON.parse(readFileSync(join(root, 'transport-manifest.json'), 'utf8'));
  assert(isDeepStrictEqual(saved, expected.manifest), 'Manifest changed');
  for (const [arm, value] of Object.entries(expected.packets)) assert(readFileSync(join(root, `${arm}.json`)).equals(value), 'Derived bytes changed');
  return saved;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] ?? 'verify';
    if (command === 'prepare') {
      const { manifest, packets } = build(); mkdirSync(ROOT, { recursive: true });
      for (const [arm, value] of Object.entries(packets)) writeFileSync(join(ROOT, `${arm}.json`), value);
      writeFileSync(join(ROOT, 'transport-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    } else if (command !== 'verify') throw new Error('Usage: node scripts/abstention-reader-transport.mjs [prepare|verify]');
    console.log(JSON.stringify(verify(), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
