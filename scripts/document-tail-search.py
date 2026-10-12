import json, sqlite3, time, statistics, platform, sys, hashlib
from pathlib import Path
ROOT = Path(sys.argv[1]).resolve()
p = json.loads((ROOT / 'prepared.json').read_text(encoding='utf8'))
results = {}
sizes = {}
times = {}
for variant, rows in p['rows'].items():
    dbpath = ROOT / (variant + '.sqlite')
    if dbpath.exists():
        raise RuntimeError('Refuse to overwrite existing database: ' + str(dbpath))
    t = time.perf_counter()
    db = sqlite3.connect(dbpath)
    db.executescript("CREATE TABLE search_docs(entity TEXT,repo TEXT,path TEXT,chunk INTEGER,offset INTEGER,content TEXT,content_fts TEXT); CREATE VIEW search_docs_nat_content_v3 AS SELECT rowid,content_fts AS content FROM search_docs; CREATE VIRTUAL TABLE search_docs_nat_fts_v3 USING fts5(content, tokenize='porter unicode61 remove_diacritics 2',content='search_docs_nat_content_v3',content_rowid='rowid');")
    for row in rows:
        cur = db.execute('INSERT INTO search_docs VALUES (?,?,?,?,?,?,?)', tuple((row[k] for k in ['entity', 'repo', 'path', 'chunk', 'offset', 'raw', 'segmented'])))
        db.execute('INSERT INTO search_docs_nat_fts_v3(rowid,content) VALUES (?,?)', (cur.lastrowid, row['segmented']))
    db.commit()
    build_ms = (time.perf_counter() - t) * 1000
    db.execute("INSERT INTO search_docs_nat_fts_v3(search_docs_nat_fts_v3,rank) VALUES ('integrity-check',1)")
    db.commit()
    sizes[variant] = {'db_bytes': dbpath.stat().st_size, 'rows': len(rows), 'indexed_raw_utf8_bytes': sum((len(r['raw'].encode('utf8')) for r in rows)), 'indexed_segmented_utf8_bytes': sum((len(r['segmented'].encode('utf8')) for r in rows)), 'build_elapsed_ms': build_ms}

    def search(q):
        hits = []
        for tier, key in [(0, 'match_all'), (1, 'match_any')]:
            if tier and q['match_all'] == q['match_any']:
                continue
            sql = "SELECT d.rowid,d.entity,d.repo,d.path,d.chunk,d.offset,bm25(search_docs_nat_fts_v3),snippet(search_docs_nat_fts_v3,0,'[',']',' … ',40),highlight(search_docs_nat_fts_v3,0,'[',']') FROM search_docs_nat_fts_v3 JOIN search_docs d ON d.rowid=search_docs_nat_fts_v3.rowid WHERE search_docs_nat_fts_v3 MATCH ?"
            args = [q[key]]
            if q['repo']:
                sql += ' AND d.repo=?'
                args.append(q['repo'])
            sql += ' ORDER BY bm25(search_docs_nat_fts_v3),d.rowid'
            for rid, entity, repo, path, chunk, offset, score, snippet, highlight in db.execute(sql, args):
                windows = []
                pos = 0
                while len(windows) < 8:
                    start = highlight.find('[', pos)
                    if start < 0:
                        break
                    end = highlight.find(']', start)
                    windows.append(highlight[max(0, start - 60):end + 61])
                    pos = end + 1
                hits.append({'rowid': rid, 'entity': entity, 'repo': repo, 'path': path, 'chunk': chunk, 'offset_utf16': offset, 'tier': tier, 'bm25': score, 'snippet': snippet, 'match_windows': windows})
        hits.sort(key=lambda h: (h['tier'], h['bm25'], h['rowid']))
        seen = set()
        unique = []
        for h in hits:
            if h['entity'] in seen:
                continue
            seen.add(h['entity'])
            unique.append(h)
        return (unique, hits)
    variant_results = []
    for q in p['queries']:
        unique, allhits = search(q)
        sample = []
        for _ in range(31):
            t = time.perf_counter()
            search(q)
            sample.append((time.perf_counter() - t) * 1000)
        target = None if not q['target'] else q['repo'] + ':' + q['target']
        rank = next((i + 1 for i, h in enumerate(unique) if h['entity'] == target), None)
        variant_results.append({'id': q['id'], 'kind': q['kind'], 'repo': q['repo'], 'query': q['text'], 'match_all': q['match_all'], 'match_any': q['match_any'], 'target': target, 'target_rank': rank, 'hit_at_1': rank == 1 if target else None, 'hit_at_3': rank is not None and rank <= 3 if target else None, 'candidate_entities': len(unique), 'candidate_rows_before_entity_dedup': len(allhits), 'top3': unique[:3], 'all_candidates': unique, 'median_query_elapsed_ms': statistics.median(sample), 'query_samples_ms': sample})
    results[variant] = variant_results
    db.close()
summary = {}
for variant, qs in results.items():
    summary[variant] = {}
    for repo in sorted(set((q['repo'] for q in qs if q['target']))):
        summary[variant][repo] = {}
        for kind in ['tail', 'prefix-control', 'all-positive']:
            cohort = [q for q in qs if q['repo'] == repo and q['target'] and (kind == 'all-positive' or q['kind'] == kind)]
            summary[variant][repo][kind] = {'n': len(cohort), 'hit1': sum((q['hit_at_1'] for q in cohort)), 'hit3': sum((q['hit_at_3'] for q in cohort))}
controls = []
for base in results['prefix']:
    if base['kind'] != 'prefix-control':
        continue
    baseids = [h['entity'] for h in base['all_candidates']]
    for variant in ['full', 'chunks']:
        new = next((q for q in results[variant] if q['id'] == base['id']))
        newids = [h['entity'] for h in new['all_candidates']]
        controls.append({'id': base['id'], 'variant': variant, 'target_rank_before': base['target_rank'], 'target_rank_after': new['target_rank'], 'new_candidates': [x for x in newids if x not in baseids], 'lost_candidates': [x for x in baseids if x not in newids], 'top3_before': [h['entity'] for h in base['top3']], 'top3_after': [h['entity'] for h in new['top3']], 'nongold_top3_before': [h['entity'] for h in base['top3'] if h['entity'] != base['target']], 'nongold_top3_after': [h['entity'] for h in new['top3'] if h['entity'] != new['target']]})
out = {'scope': 'Candidate discovery only; sparse natural FTS5, no embeddings/reranking, no frozen evaluation, development corpus only', 'environment': {'python': sys.version, 'sqlite': sqlite3.sqlite_version, 'platform': platform.platform(), 'processor': platform.processor(), 'node_versions': p['node_versions'], 'sqlite_compile_options': [x[0] for x in sqlite3.connect(':memory:').execute('PRAGMA compile_options')]}, 'source_sha': p['sha'], 'source_hashes': p['sources'], 'input_sha256': p['input_sha256'], 'fixture_sha256': p['fixture_sha256'], 'input_bytes': p['input_bytes'], 'body_utf16_total': p['body_utf16_total'], 'body_utf8_bytes_total': p['body_utf8_bytes_total'], 'segmentation_prepare_elapsed_ms': p['segmentation_prepare_elapsed_ms'], 'storage': sizes, 'inventory': p['inventory'], 'literal_audits': p['literalAudits'], 'summary': summary, 'prefix_control_changes': controls, 'results': results}
(ROOT / 'results.json').write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(json.dumps({'storage': sizes, 'summary': summary, 'controls': controls}, ensure_ascii=False))
