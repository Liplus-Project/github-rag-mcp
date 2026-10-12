import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


class DocumentTailContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='tail-contract-')
        cls.root = Path(cls.temp.name)
        cls.out = cls.root / 'fresh'
        subprocess.run([sys.executable, str(SCRIPTS / 'document-tail-replay.py'), '--out', str(cls.out)], check=True, stdout=subprocess.DEVNULL)
        cls.result = json.loads((cls.out / 'results.json').read_text(encoding='utf8'))

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_fixed_fixture_ranks_and_static_evidence(self):
        r = self.result
        self.assertEqual(len(r['inventory']), 11)
        self.assertEqual(len(r['results']['full']), 7)
        for arm, named1, named3, literal1, rowliteral in [('prefix', 0, 1, 1, 0), ('full', 3, 3, 3, 3), ('chunks', 2, 3, 3, 3)]:
            s = r['tail_summary'][arm]
            self.assertEqual((s['named_target_hit1'], s['named_target_hit3'], s['literal_source_entity_hit1'], s['top1_index_row_literal']), (named1, named3, literal1, rowliteral))
        self.assertTrue(all(a['same'] for a in r['production_nat_cap_equivalence_audit']))
        section = r['heading_section_analysis']
        self.assertEqual(section['root3']['nonempty_sections_including_preamble'], 74)
        self.assertEqual(section['root3']['at_most_1700']['count'], 59)
        tails = [t for t in section['targets'] if t['label'] == 'tail']
        self.assertEqual(sum(t['headingsection_with_path_title_prefix_literal_visible'] for t in tails), 2)
        self.assertFalse(any(t['whole_full_prefix_literal_visible'] or t['winning8000chunk_prefix_literal_visible'] for t in tails))
        for arm in r['results'].values():
            negatives = [q for q in arm if q['kind'] == 'absent-from-this-fixture-only']
            self.assertEqual(len(negatives), 1)
            self.assertTrue(all(q['candidate_entities'] == 0 for q in negatives))
        self.assertTrue(all(a['absent_from_all_bodies'] for a in r['literal_audits'] if 'absent_from_all_bodies' in a))

    def test_existing_output_is_not_overwritten(self):
        marker = self.out / 'marker'
        marker.write_text('keep')
        digest = (self.out / 'results.json').read_bytes()
        result = subprocess.run([sys.executable, str(SCRIPTS / 'document-tail-replay.py'), '--out', str(self.out)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(marker.read_text(), 'keep')
        self.assertEqual((self.out / 'results.json').read_bytes(), digest)

    def test_dangling_output_symlink_does_not_create_target(self):
        link = self.root / 'dangling-output'
        target = self.root / 'must-not-be-created'
        try:
            link.symlink_to(target, target_is_directory=True)
        except (OSError, NotImplementedError) as error:
            self.skipTest('Symlink creation unavailable: ' + str(error))
        result = subprocess.run([sys.executable, str(SCRIPTS / 'document-tail-replay.py'), '--out', str(link)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(link.is_symlink())
        self.assertFalse(target.exists())

    def test_targets_do_not_affect_ranking(self):
        prepared = json.loads((self.out / 'prepared.json').read_text(encoding='utf8'))
        changed = self.root / 'changed-labels'
        changed.mkdir()
        for q in prepared['queries']:
            if q['target']: q['target'] = 'unrelated-public-path.md'
        (changed / 'prepared.json').write_text(json.dumps(prepared, ensure_ascii=False), encoding='utf8')
        subprocess.run([sys.executable, str(SCRIPTS / 'document-tail-search.py'), str(changed)], check=True, stdout=subprocess.DEVNULL)
        after = json.loads((changed / 'results.json').read_text(encoding='utf8'))
        for arm, queries in self.result['results'].items():
            for before, new in zip(queries, after['results'][arm]):
                self.assertEqual(before['all_candidates'], new['all_candidates'])
                self.assertEqual(before['top3'], new['top3'])
                self.assertIsNone(new['target_rank'])


if __name__ == '__main__':
    unittest.main()
