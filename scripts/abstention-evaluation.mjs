import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../experiments/abstention-evaluation-v1/', import.meta.url));
export const sha256 = b => createHash('sha256').update(b).digest('hex');
const read = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const assert = (value, message) => { if (!value) throw new Error(message); };
const categories = ['support', 'premise_correction', 'unsupported_premise', 'out_of_corpus'];
function unique(xs, description) { assert(new Set(xs).size === xs.length, `Duplicate ${description}`); }
export function load(root = ROOT) {
  return Object.fromEntries(['provenance', 'intents', 'gold', 'split', 'exclusions', 'preregistration'].map(n => [n, read(root, `${n}.json`)]));
}

// Byte integrity and split/annotation contracts; semantic gold still needs an independent audit.
export function validate(data = load(), root = ROOT) {
  const { provenance: p, intents: { intents }, gold: { entries }, split: { groups }, exclusions: e, preregistration: protocol } = data;
  unique(p.sources.map(x => x.id), 'source'); unique(intents.map(x => x.id), 'intent');
  unique(entries.map(x => x.intent_id), 'gold'); unique(groups.map(x => x.id), 'group');
  assert(intents.length === 36 && entries.length === 36, 'Expected36 intents and36 gold entries');
  const sources = new Map(p.sources.map(x => [x.id, x]));
  const assignedIntent = new Map(), assignedSource = new Map(), assignedFamily = new Map();
  const familyOwners = new Map(), sourceVersions = new Map();
  for (const group of groups) {
    assert(['development', 'holdout'].includes(group.split), 'Unknown split');
    for (const f of group.families) {
      assert(!assignedFamily.has(f), 'Family crosses groups'); assignedFamily.set(f, group);
    }
    for (const id of group.intent_ids) { assert(!assignedIntent.has(id), 'Intent crosses groups'); assignedIntent.set(id, group); }
    for (const id of group.source_ids) { assert(!assignedSource.has(id), 'Source crosses groups'); assignedSource.set(id, group); }
  }
  const bodies = new Map();
  for (const s of p.sources) {
    assert(/^[0-9a-f]{40}$/.test(s.commit), 'Immutable commit required');
    assert(s.file.startsWith('sources/') && !s.file.includes('..'), 'Unsafe snapshot path');
    assert(s.url === `https://github.com/${s.repo}/blob/${s.commit}/${s.path}`, 'Provenance URL mismatch');
    const raw = readFileSync(join(root, s.file));
    assert(sha256(raw) === s.sha256 && raw.length === s.bytes, 'Source hash/size mismatch');
    assert(Buffer.from(raw.toString('utf8')).equals(raw), 'Source is not valid UTF8');
    bodies.set(s.id, raw);
    const group = assignedSource.get(s.id);
    assert(group && group.families.includes(s.family) && group.split === s.split, 'Source/group mismatch');
    const key = `${s.repo}:${s.path}`;
    assert(!familyOwners.has(key) || familyOwners.get(key) === s.family, 'Same-path versions split across families');
    familyOwners.set(key, s.family);
    assert(!sourceVersions.has(s.sha256) || sourceVersions.get(s.sha256) === s.family, 'Copied source crosses families');
    sourceVersions.set(s.sha256, s.family);
    assert(!e.conservative_exclusions.some(x => x.repo === s.repo && s.path.startsWith(x.path_prefix)), 'Excluded source family');
    assert(!e.excluded_doc_families.includes(key), 'Old development document');
  }
  assert(assignedIntent.size === intents.length && assignedSource.size === p.sources.length, 'Uncovered group member');
  const counts = {}, languages = {}, repos = {};
  const questionIds = [];
  for (const i of intents) {
    const group = assignedIntent.get(i.id), source = sources.get(i.target_source);
    assert(group && source && group.source_ids.includes(i.target_source), 'Intent target crosses split');
    assert(i.family === source.family && i.repo === source.repo && group.families.includes(i.family), 'Intent family mismatch');
    assert(categories.includes(i.category), 'Unknown category');
    assert(i.questions.length === 3 && i.questions.map(q => q.language).sort().join(',') === 'en,ja,short', 'Three equivalent expressions required');
    assert(i.equivalence_review.includes('author reviewed'), 'Equivalence review absent');
    counts[group.split] ??= {}; counts[group.split][i.category] = (counts[group.split][i.category] ?? 0) + 1;
    repos[group.split] ??= new Set(); repos[group.split].add(i.repo);
    for (const q of i.questions) {
      assert(q.id && q.text.trim(), 'Empty question'); questionIds.push(q.id);
      languages[q.language] = (languages[q.language] ?? 0) + 1;
    }
    const gold = entries.find(g => g.intent_id === i.id);
    assert(gold && gold.scope && gold.answer, 'Missing gold');
    const required = i.category === 'support' ? 'answered' : i.category === 'premise_correction' ? 'premise_corrected' : 'insufficient';
    assert(gold.expected === required, 'Gold status/category mismatch');
    assert(gold.evidence.length > 0 || required === 'insufficient', 'Support/correction require explicit quotes');
    assert(required !== 'insufficient' || (gold.evidence.length === 0 && gold.corpus_audit), 'Insufficiency needs finite corpus audit, no false contradiction');
    if (i.category === 'unsupported_premise') assert(gold.truth_of_unsupported_premise === 'not established', 'Absent evidence does not disprove premise');
    for (const ev of gold.evidence) {
      assert(ev.source_id === i.target_source, 'Gold evidence must address target revision');
      const raw = bodies.get(ev.source_id);
      assert(raw && Number.isInteger(ev.start_utf8) && Number.isInteger(ev.end_utf8) && ev.start_utf8 >= 0 && ev.end_utf8 > ev.start_utf8, 'Invalid evidence range');
      assert(raw.subarray(ev.start_utf8, ev.end_utf8).equals(Buffer.from(ev.quote)), 'Quote/range mismatch');
    }
  }
  unique(questionIds, 'question');
  assert(questionIds.length === 108, 'Expected108 questions');
  for (const c of categories) assert(counts.development?.[c] === 3 && counts.holdout?.[c] === 6, 'Unbalanced split/category');
  for (const s of ['development', 'holdout']) assert(repos[s]?.size === 2, 'Both repos required in each split');
  assert(protocol.initial_tranche.query_count === 12 && protocol.initial_tranche.repetitions_per_arm === 3 && protocol.initial_tranche.answer_count === 108, 'Unexpected reader budget');
  for (const f of protocol.initial_tranche.families) assert(assignedFamily.get(f)?.split === 'holdout', 'Reader tranche leaks development');
  assert(protocol.whole_pool.A === 'unmeasured' && protocol.whole_pool.B === 'unmeasured' && protocol.whole_pool.D === 'unmeasured', 'No pool/score oracle');
  return { intents: intents.length, questions: questionIds.length, sources: p.sources.length, groups: groups.length, counts, languages, repo_counts: Object.fromEntries(Object.entries(repos).map(([k, v]) => [k, v.size])), cross_split_family_overlap: 0 };
}

export function packets(data = load(), root = ROOT) {
  validate(data, root);
  const { provenance: { sources }, intents: { intents }, gold: { entries }, preregistration: p } = data;
  const selected = intents.filter(i => p.initial_tranche.families.includes(i.family))
    .sort((a, b) => sha256(`${p.case_order_seed}:${a.id}`).localeCompare(sha256(`${p.case_order_seed}:${b.id}`)));
  const mapping = [], cases = selected.map((intent, n) => {
    const question = intent.questions.find(q => q.language === p.initial_tranche.language);
    const id = `Q${String(n + 1).padStart(3, '0')}`;
    mapping.push({ id, question_id: question.id, intent_id: intent.id, gold: entries.find(x => x.intent_id === intent.id) });
    const documents = sources.filter(s => s.family === intent.family).map(s => {
      const text = readFileSync(join(root, s.file), 'utf8');
      let spans = [[0, Math.min(text.length, 9000)]];
      if (s.family === 'F06') {
        const start = text.indexOf('pub fn delete('), end = text.indexOf('\n#[cfg(test)]', start);
        assert(start >= 0 && end > start, 'Missing delete implementation'); spans = [[0, 2400], [start, end]];
      }
      return { source_id: s.id, repo: s.repo, path: s.path, commit: s.commit, role: s.role, url: s.url, source_sha256: s.sha256, version_semantics: s.version_semantics,
        excerpts: spans.map(([start, end]) => ({ start_utf8: Buffer.byteLength(text.slice(0, start)), end_utf8: Buffer.byteLength(text.slice(0, end)), text: text.slice(start, end) })) };
    });
    for (const ev of entries.find(x => x.intent_id === intent.id).evidence) assert(documents.some(d => d.source_id === ev.source_id && d.excerpts.some(x => x.text.includes(ev.quote))), 'Reader packet loses preregistered gold evidence');
    return { id, question: question.text, documents };
  });
  assert(cases.length === 12, 'Expected12 initial reader cases');
  return { reader: Object.fromEntries(Object.keys(p.arms).map(arm => [arm, { instruction: p.reader.instruction, cases: cases.map(c => arm === 'm2' ? { ...c, documents: [] } : arm === 'v8' ? { ...c, diagnostic_note: p.warning } : c) }])), mapping: { instruction: 'Evaluator only. Never pass this file, gold, protocol arm mapping or other answers to readers.', cases: mapping } };
}

function walk(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(x => x.isDirectory() ? walk(root, join(prefix, x.name)) : [join(prefix, x.name).replaceAll('\\', '/')]).sort();
}
export function freeze(root = ROOT) {
  return { version: 1, algorithm: 'sha256 over exact bytes; frozen files are -text in gitattributes', files: Object.fromEntries(walk(root).filter(x => x !== 'freeze.json').map(x => [x, sha256(readFileSync(join(root, x)))])) };
}
export function checkFreeze(root = ROOT) {
  const expected = read(root, 'freeze.json'), actual = freeze(root);
  assert(JSON.stringify(actual) === JSON.stringify(expected), 'Frozen bytes/file inventory changed'); return sha256(readFileSync(join(root, 'freeze.json')));
}
export function verifyAnswers(output, input) {
  assert(Object.keys(output).sort().join(',') === 'answers', 'Unknown output fields');
  assert(Array.isArray(output.answers) && output.answers.length === input.cases.length, 'Incomplete answer set');
  unique(output.answers.map(x => x.id), 'answer');
  for (const a of output.answers) {
    const c = input.cases.find(x => x.id === a.id);
    assert(Object.keys(a).sort().join(',') === 'answer,id,quotes,status', 'Unknown answer fields');
    assert(c && ['answered', 'premise_corrected', 'insufficient', 'partial'].includes(a.status) && typeof a.answer === 'string' && a.answer.trim() && [...a.answer].length <= 600 && Array.isArray(a.quotes) && a.quotes.length <= 2, 'Invalid answer contract');
    for (const q of a.quotes) {
      assert(Object.keys(q).sort().join(',') === 'source_id,text', 'Unknown quote fields');
      assert(q.text && c.documents.some(d => d.source_id === q.source_id && d.excerpts.some(e => e.text.includes(q.text))), 'Unsupported quote');
    }
  }
  return { quotations_checked: true, semantic_scoring: 'Manual blinded adjudication required; no automatic efficacy score' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] ?? 'validate';
    if (command === 'prepare') {
      const result = packets(); mkdirSync(join(ROOT, 'reader-inputs'), { recursive: true });
      for (const [arm, packet] of Object.entries(result.reader)) writeFileSync(join(ROOT, 'reader-inputs', `${arm}.json`), JSON.stringify(packet, null, 2) + '\n');
      writeFileSync(join(ROOT, 'reader-gold.json'), JSON.stringify(result.mapping, null, 2) + '\n');
      writeFileSync(join(ROOT, 'freeze.json'), JSON.stringify(freeze(), null, 2) + '\n');
    } else if (command !== 'validate') throw new Error('Usage: node scripts/abstention-evaluation.mjs [validate|prepare]');
    console.log(JSON.stringify({ ...validate(), freeze_sha256: checkFreeze() }, null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
