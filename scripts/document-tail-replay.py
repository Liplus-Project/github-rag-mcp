"""Opt-in offline comparison; creates only a new caller-named output directory."""
import argparse, json, sqlite3, subprocess, sys
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    # Keep the leaf unresolved: mkdir must reject existing dangling symlinks too.
    R = args.out.absolute()
    R.mkdir(parents=True, exist_ok=False)
    scripts = Path(__file__).resolve().parent
    fixture_dir = scripts.parent / 'experiments' / 'document-tail'
    subprocess.run(['node', '--experimental-strip-types', str(scripts / 'document-tail-prepare.mjs'), str(fixture_dir), str(R)], check=True)
    subprocess.run([sys.executable, str(scripts / 'document-tail-search.py'), str(R)], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['node', str(scripts / 'document-tail-sections.mjs'), str(R), str(fixture_dir)], check=True, stdout=subprocess.DEVNULL)
    r = json.loads((R / 'results.json').read_text(encoding='utf8'))
    p = json.loads((R / 'prepared.json').read_text(encoding='utf8'))
    sections = json.loads((R / 'sections.json').read_text(encoding='utf8'))
    audit = []
    for v in ['prefix', 'full']:
        db = sqlite3.connect(R / (v + '.sqlite'))
        for q in p['queries']:
            rows = []
            for tier, key in [(0, 'match_all'), (1, 'match_any')]:
                if tier and q['match_any'] == q['match_all']:
                    continue
                sql = 'SELECT d.rowid,d.entity,bm25(search_docs_nat_fts_v3) FROM search_docs_nat_fts_v3 JOIN search_docs d ON d.rowid=search_docs_nat_fts_v3.rowid WHERE search_docs_nat_fts_v3 MATCH ?'
                args = [q[key]]
                if q['repo']:
                    sql += ' AND d.repo=?'
                    args.append(q['repo'])
                sql += ' ORDER BY bm25(search_docs_nat_fts_v3),d.rowid LIMIT 3'
                rows.extend(((tier, score, rid, entity) for rid, entity, score in db.execute(sql, args)))
            rows.sort()
            rows = rows[:6 if q['match_any'] != q['match_all'] else 3]
            ids = []
            for _, _, _, entity in rows:
                if entity not in ids:
                    ids.append(entity)
                if len(ids) == 3:
                    break
            exhaustive = [h['entity'] for h in next((x for x in r['results'][v] if x['id'] == q['id']))['top3']]
            audit.append({'variant': v, 'query_id': q['id'], 'production_nat_topK3_cap_entities': ids, 'exhaustive_entity_top3': exhaustive, 'same': ids == exhaustive})
        db.close()
    assert all((a['same'] for a in audit))
    for full in p['rows']['full']:
        chunks = [x for x in p['rows']['chunks'] if x['entity'] == full['entity']]
        assert ''.join((x['raw'] for x in chunks)) == full['raw']
        assert all((len(x['raw'].encode('utf-16-le')) // 2 <= 8000 for x in chunks))
    assert all((x['version_hash_matches'] for x in r['inventory']))
    r['heading_section_analysis'] = sections
    r['production_nat_cap_equivalence_audit'] = audit
    r['verification'] = {'all_doc_version_sha256_matches': True, 'all_chunk_join_and_width_checks_pass': True, 'source_hashes_verified': True}
    for qs in r['results'].values():
        for q in qs:
            if q['id'] == 'ngr_prefix':
                q['interpretation_label'] = 'general-query control; individual matching terms in prefix'
    (R / 'results.json').write_text(json.dumps(r, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    fixture = json.loads((fixture_dir / 'fixture.json').read_text(encoding='utf8'))
    lexical = []
    for v, qs in r['results'].items():
        for q in qs:
            eligible = [d['repo'] + ':' + d['path'] for d in fixture['docs'] if (q['repo'] is None or d['repo'] == q['repo']) and q['query'] in d['text']]
            first = next((i + 1 for i, h in enumerate(q['all_candidates']) if h['entity'] in eligible), None)
            lexical.append({'variant': v, 'query_id': q['id'], 'kind': q['kind'], 'exact_literal_source_entities': eligible, 'first_eligible_entity_rank': first, 'any_exact_literal_source_entity_hit1': first == 1 if eligible else None, 'any_exact_literal_source_entity_hit3': first is not None and first <= 3 if eligible else None, 'top1_winning_index_row_contains_exact_literal': q['query'] in next((row['raw'] for row in p['rows'][v] if q['top3'] and row['entity'] == q['top3'][0]['entity'] and (row['chunk'] == q['top3'][0]['chunk'])), '')})
    r['exact_literal_source_eligibility'] = lexical
    (R / 'results.json').write_text(json.dumps(r, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    tails = {}
    for variant, qs in r['results'].items():
        named = [q for q in qs if q['kind'] == 'tail']
        eligible = [q for q in lexical if q['variant'] == variant and q['kind'] == 'tail']
        tails[variant] = {'n': len(named), 'named_target_hit1': sum((q['hit_at_1'] for q in named)), 'named_target_hit3': sum((q['hit_at_3'] for q in named)), 'literal_source_entity_hit1': sum((q['any_exact_literal_source_entity_hit1'] for q in eligible)), 'literal_source_entity_hit3': sum((q['any_exact_literal_source_entity_hit3'] for q in eligible)), 'top1_index_row_literal': sum((q['top1_winning_index_row_contains_exact_literal'] for q in eligible))}
    r['tail_summary'] = tails
    (R / 'results.json').write_text(json.dumps(r, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    lines = ['# Document tail retrieval comparison', '', '固定公開fixtureの sparse-only 再計算。named target と exact literal source は別指標であり、意味的正答率ではない。embedding / reranking / reader は実行しない。', '', '| Arm | Named @1/@3 | Literal source entity @1/@3 | Top1 row literal |', '|---|---|---|---|']
    for variant, t in tails.items():
        lines.append(f"| {variant} | {t['named_target_hit1']}/{t['n']}, {t['named_target_hit3']}/{t['n']} | {t['literal_source_entity_hit1']}/{t['n']}, {t['literal_source_entity_hit3']}/{t['n']} | {t['top1_index_row_literal']}/{t['n']} |")
    lines += ['', '全候補、snippet、静的rerank予算、見出し節長、cap監査、実行環境、bytes/rows、build/query時間は results.json / sections.json に保存。時間・サイズは当該ローカル環境の観測値。production capとchunkの全列挙/dedupは同一ではない。', '', 'ngr_prefix は general-query control（各tokenがprefix内に存在）であり phrase-in-prefix control ではない。', '', 'Webhook chunk の別docにも同じ literal があり、named target の順位差を品質失敗とは判定しない。']
    (R / 'REPORT.md').write_text('\n'.join(lines) + '\n', encoding='utf8')
    print(json.dumps({'output': str(R), 'tail_summary': tails}, ensure_ascii=False))
if __name__ == '__main__':
    main()
