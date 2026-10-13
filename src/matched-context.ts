import { escapeFtsQuery, ftsScope, queryFts, type FtsFilter, type FtsHit } from './fts.js';
import { DOC_SPARSE_INDEX_VERSION, MAX_RAW_BYTES, MAX_SEGMENTED_BYTES, MAX_ROW_BYTES, utf8Bytes, gitBlobSha } from './doc-sparse.js';
import { segmentForFts, needsSegmentation, getSegmenter } from './segment.js';
import { sha256Hex } from './pipeline/hash.js';

export const RAW_REQUEST_BUDGET = 1024 * 1024;
export const RAW_BATCH_SIZE = 5;
export const MATCHED_MAX_CANDIDATES = 50;
export const EXCERPT_UNITS = 1400;
const ELLIPSIS = '\u0001';
type Row = Record<string, unknown>;
export interface Coverage {
  status: 'complete' | 'partial' | 'unprepared' | 'unavailable';
  total: number | null; full: number | null; prefix_only: number | null;
  unprepared: number | null; out_of_range: number | null; stale: number | null;
  reason?: string;
}
export interface MatchedContext {
  text: string; start: number; end: number; coordinate_system: 'path_newlines_body_utf16';
  source_version: string; body_hash: string; source_hash: string; raw_hash: string; excerpt_hash: string;
}
export interface ContextOutcome { matched_context?: MatchedContext; matched_context_fallback?: string }
export interface MatchedSearch { hits: FtsHit[]; sources: Map<string, Row>; coverage: Coverage }
const ownerCurrent = `s.source_type=d.type AND s.source_version=d.source_version
  AND s.prefix_indexed_at=d.indexed_at AND s.prefix_revision=d.source_revision`;
const fullOwner = `${ownerCurrent} AND s.coverage='full' AND s.index_version='${DOC_SPARSE_INDEX_VERSION}'`;
const validFullExists = `EXISTS (SELECT 1 FROM doc_sparse_sources s WHERE s.vector_id=d.vector_id AND ${fullOwner})`;
export const unavailableCoverage = (): Coverage => ({ status:'unavailable', total:null, full:null,
  prefix_only:null, unprepared:null, out_of_range:null, stale:null, reason:'full_index_unavailable' });

export async function matchedCoverage(db: D1Database, filter: FtsFilter): Promise<Coverage> {
  const scope = ftsScope(filter);
  const r = (await db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN ${fullOwner} THEN 1 ELSE 0 END),0) AS full,
    COALESCE(SUM(CASE WHEN s.vector_id IS NULL THEN 1 ELSE 0 END),0) AS unprepared,
    COALESCE(SUM(CASE WHEN ${ownerCurrent} AND s.index_version='${DOC_SPARSE_INDEX_VERSION}' AND s.coverage='out_of_range' THEN 1 ELSE 0 END),0) AS out_of_range
    FROM search_docs d LEFT JOIN doc_sparse_sources s ON s.vector_id=d.vector_id
    WHERE d.type IN ('doc','wiki_doc')${scope.sql}`).bind(...scope.params).first<Row>())!;
  const total=Number(r.total), full=Number(r.full), unprepared=Number(r.unprepared), out_of_range=Number(r.out_of_range);
  return { status: full === total ? 'complete' : full > 0 ? 'partial' : 'unprepared',
    total, full, prefix_only:total-full, unprepared, out_of_range, stale:total-full-unprepared-out_of_range };
}

function hit(r: Row): FtsHit {
  return { vectorId:String(r.vector_id), repo:String(r.repo), type:String(r.type), state:String(r.state),
    labels:String(r.labels), milestone:String(r.milestone), assignees:String(r.assignees), updatedAt:String(r.updated_at),
    number:Number(r.number), tagName:String(r.tag_name), docPath:String(r.doc_path), commitSha:String(r.commit_sha),
    filePath:String(r.file_path), fileStatus:String(r.file_status), commitDate:String(r.commit_date),
    commitAuthor:String(r.commit_author), commentId:Number(r.comment_id), reviewId:Number(r.review_id),
    content:String(r.content), score:Number(r.score) };
}

/** Separate corpora never compare BM25 magnitudes. One tier-rank vote per vector. */
export function mergeSparseTiers(arms: { tier:number; rows:Row[] }[], topK:number): Row[] {
  const votes = new Map<string, { tier:number; vote:number; row:Row }>();
  for (const arm of arms) arm.rows.forEach((row, i) => {
    const id=String(row.vector_id), vote=1/(60+i+1), old=votes.get(id);
    if (!old || arm.tier < old.tier || (arm.tier === old.tier && vote > old.vote)) votes.set(id,{tier:arm.tier,vote,row});
  });
  return [...votes.values()].sort((a,b)=>a.tier-b.tier || b.vote-a.vote ||
    (String(a.row.vector_id)<String(b.row.vector_id)?-1:1)).slice(0,topK).map(v=>v.row);
}

export async function queryMatchedFts(db:D1Database, query:string, topK:number, filter:FtsFilter, denseOnly=false):Promise<MatchedSearch> {
  try {
    const coverage=await matchedCoverage(db,filter), sources=new Map<string,Row>();
    if (denseOnly) return { hits:[], sources, coverage };
    const scope=ftsScope(filter), text=segmentForFts(query), strict=escapeFtsQuery(text), relaxed=escapeFtsQuery(text,'any');
    const matches=strict===relaxed?[strict]:[strict,relaxed];
    const arms:{tier:number;rows:Row[]}[]=[];
    // Candidate arms share a batch snapshot. Coverage is a separate, earlier SELECT observation.
    const statements=matches.flatMap(match=>[true,false].map(full=>{
      const table=full?'doc_sparse_fts_v1':'search_docs_nat_fts_v3';
      return db.prepare(`SELECT d.*, bm25(${table}) AS score${full ? `,
        snippet(${table},0,'','','${ELLIPSIS}',32) AS fragment,
        s.source_version AS owner_version,s.prefix_indexed_at,s.prefix_revision,s.index_version,
        s.raw_hash,s.body_hash,s.source_hash,s.raw_bytes,s.segmented_bytes,s.row_bytes` : ''}
        FROM ${table} f ${full ? 'JOIN doc_sparse_sources s ON s.rowid=f.rowid JOIN search_docs d ON d.vector_id=s.vector_id' : 'JOIN search_docs d ON d.rowid=f.rowid'}
        WHERE ${table} MATCH ? AND d.type IN ('doc','wiki_doc')${scope.sql}
        AND ${full?fullOwner:`NOT ${validFullExists}`}
        ORDER BY score ASC,d.vector_id ASC LIMIT ?`).bind(match,...scope.params,topK);
    }));
    // Legacy code-prefix evidence can exist on either owner population. It supplies
    // no full-source position and never creates a second vote for an existing vector.
    const codeArm=statements.length;
    statements.push(db.prepare(`SELECT d.*,bm25(search_docs_code_fts_v2) AS score
      FROM search_docs_code_fts_v2 f JOIN search_docs d ON d.rowid=f.rowid
      WHERE search_docs_code_fts_v2 MATCH ? AND d.type IN ('doc','wiki_doc')${scope.sql}
      ORDER BY score ASC,d.vector_id ASC LIMIT ?`).bind(escapeFtsQuery(query),...scope.params,topK));
    const results=await db.batch<Row>(statements);
    results.forEach((r,i)=>{ const rows=r.results ?? []; arms.push({tier:i===codeArm?0:Math.floor(i/2),rows});
      if(i===codeArm) return;
      if(i%2===0) for(const row of rows) if(!sources.has(String(row.vector_id))) sources.set(String(row.vector_id),row);
    });
    const merged=mergeSparseTiers(arms,topK);
    const codeIds=new Set((results[codeArm].results ?? []).map(row=>String(row.vector_id)));
    merged.forEach((row,i)=>{
      const id=String(row.vector_id);
      if(!sources.has(id) && codeIds.has(id)) sources.set(id,{position_kind:'code_only_prefix'});
      const source=sources.get(id);if(source) source.keyword_rank=i+1;
    });
    return { hits:merged.map(hit), sources, coverage };
  } catch {
    // Include all legacy prefix owners on failure, including prepared ones.
    return { hits:denseOnly?[]:await queryFts(db,query,topK,filter), sources:new Map(), coverage:unavailableCoverage() };
  }
}

function safeBoundary(raw:string,index:number):boolean {
  return !(index>0 && index<raw.length && /[\uD800-\uDBFF]/.test(raw[index-1]) && /[\uDC00-\uDFFF]/.test(raw[index]));
}

/** Reconstruct the exact indexing transform; no fuzzy remapping or duplicate selection. */
export function excerptBounds(raw:string,stored:string,snippet:string): {start:number;end:number} | string {
  if (segmentForFts(raw)!==stored) return 'segmentation_mismatch';
  const fragments=snippet.split(ELLIPSIS).filter(s=>s.length>0);
  if(fragments.length!==1) return 'ambiguous_fragment';
  const fragment=fragments[0], at=stored.indexOf(fragment);
  if(at<0 || stored.lastIndexOf(fragment)!==at) return 'ambiguous_fragment';
  const spans:{a:number;b:number;raw:number}[]=[];
  if(!needsSegmentation(raw)) spans.push({a:0,b:raw.length,raw:0});
  else {
    let pos=0;
    for(const part of getSegmenter().segment(raw)) {
      const text=part.segment.trim(); if(!text) continue;
      if(spans.length) pos++;
      spans.push({a:pos,b:pos+text.length,raw:part.index+part.segment.indexOf(text)}); pos+=text.length;
    }
  }
  const first=spans.find(s=>at>=s.a && at<s.b), endAt=at+fragment.length;
  const last=spans.find(s=>endAt>s.a && endAt<=s.b);
  if(!first || !last) return 'invalid_span';
  const lo=first.raw+at-first.a, hi=last.raw+endAt-last.a;
  if(hi<=lo || hi-lo>EXCERPT_UNITS || !safeBoundary(raw,lo) || !safeBoundary(raw,hi)) return 'invalid_span';
  let start=Math.max(0,lo-Math.floor((EXCERPT_UNITS-(hi-lo))/2));
  if(!safeBoundary(raw,start)) start++;
  let end=Math.min(raw.length,start+EXCERPT_UNITS);
  if(!safeBoundary(raw,end)) end--;
  if(end<hi) return 'invalid_span';
  return {start,end};
}

export async function verifyExcerpt(narrow:Row,row:Row):Promise<MatchedContext|string> {
  for(const key of ['vector_id','repo','type','doc_path','source_version','indexed_at','source_revision','owner_version','prefix_indexed_at','prefix_revision','index_version','raw_hash','body_hash','source_hash','raw_bytes','segmented_bytes','row_bytes']) {
    if(narrow[key]!==row[key]) return 'version_mismatch';
  }
  const raw=row.raw, segmented=row.segmented;
  if(typeof raw!=='string' || typeof segmented!=='string') return 'missing_source';
  if(utf8Bytes(raw)!==Number(row.raw_bytes) || utf8Bytes(segmented)!==Number(row.segmented_bytes)) return 'byte_mismatch';
  const prefix=`${row.doc_path}\n\n`;
  if(!raw.startsWith(prefix)) return 'path_mismatch';
  const body=raw.slice(prefix.length), bodyHash=await sha256Hex(body), rawHash=await sha256Hex(raw);
  const sourceHash=row.type==='doc'?await gitBlobSha(body):bodyHash;
  if(bodyHash!==row.body_hash || rawHash!==row.raw_hash || sourceHash!==row.source_hash || sourceHash!==row.source_version) return 'hash_mismatch';
  const bounds=excerptBounds(raw,segmented,String(narrow.fragment));
  if(typeof bounds==='string') return bounds;
  const text=raw.slice(bounds.start,bounds.end);
  return {text,...bounds,coordinate_system:'path_newlines_body_utf16',source_version:sourceHash,
    body_hash:bodyHash,source_hash:sourceHash,raw_hash:rawHash,excerpt_hash:await sha256Hex(text)};
}

/** Narrow snapshots come from sparse search. Only selected, nonempty base candidates read raw. */
export async function resolveMatchedContexts(db:D1Database,ids:string[],sources:Map<string,Row>,unavailable=false):Promise<Map<string,ContextOutcome>> {
  const outcomes=new Map<string,ContextOutcome>(), selected=ids.slice(0,MATCHED_MAX_CANDIDATES);
  const fallback=(id:string,reason:string)=>outcomes.set(id,{matched_context_fallback:reason});
  const noPosition = new Map<string,string>();
  if(!unavailable && selected.some(id=>!sources.has(id))) {
    try {
      const missing=selected.filter(id=>!sources.has(id));
      const rows=await db.prepare(`SELECT d.vector_id, CASE WHEN s.vector_id IS NULL THEN 'unprepared'
        WHEN NOT (${ownerCurrent}) OR s.index_version<>'${DOC_SPARSE_INDEX_VERSION}' THEN 'stale_source'
        WHEN s.coverage='out_of_range' THEN 'out_of_range' ELSE 'no_full_sparse_position' END AS reason
        FROM search_docs d LEFT JOIN doc_sparse_sources s ON s.vector_id=d.vector_id
        WHERE d.vector_id IN (${missing.map(()=>'?').join(',')})`).bind(...missing).all<Row>();
      for(const row of rows.results ?? []) noPosition.set(String(row.vector_id),String(row.reason));
    } catch { for(const id of selected) if(!sources.has(id)) noPosition.set(id,'source_read_failed'); }
  }
  let remaining=RAW_REQUEST_BUDGET;
  const admitted:string[]=[];
  const budgetOrder=[...selected].sort((a,b)=>Number(sources.get(a)?.keyword_rank ?? Infinity)-Number(sources.get(b)?.keyword_rank ?? Infinity) || (a<b?-1:a>b?1:0));
  for(const id of budgetOrder) {
    const s=sources.get(id);
    if(s?.position_kind==='code_only_prefix') {fallback(id,'code_only_prefix');continue;}
    if(!s) { fallback(id,unavailable?'full_index_unavailable':noPosition.get(id) ?? 'missing_source'); continue; }
    const raw=Number(s.raw_bytes), segmented=Number(s.segmented_bytes), owner=Number(s.row_bytes);
    if(!Number.isSafeInteger(raw)||!Number.isSafeInteger(segmented)||!Number.isSafeInteger(owner)||
      raw<0||segmented<0||owner<0||raw>MAX_RAW_BYTES||segmented>MAX_SEGMENTED_BYTES||owner>MAX_ROW_BYTES) {fallback(id,'source_budget');continue;}
    if(raw>remaining) {fallback(id,'request_budget');continue;}
    remaining-=raw; admitted.push(id);
  }
  for(let offset=0;offset<admitted.length;offset+=RAW_BATCH_SIZE) {
    const batch=admitted.slice(offset,offset+RAW_BATCH_SIZE);
    try {
      const statements=batch.map(id=>{
        const n=sources.get(id)!;
        return db.prepare(`SELECT d.vector_id,d.repo,d.type,d.doc_path,d.source_version,d.indexed_at,d.source_revision,
          s.source_version AS owner_version,s.prefix_indexed_at,s.prefix_revision,s.index_version,s.raw_hash,s.body_hash,s.source_hash,
          s.raw_bytes,s.segmented_bytes,s.row_bytes,s.raw,s.segmented FROM search_docs d JOIN doc_sparse_sources s ON s.vector_id=d.vector_id
          WHERE d.vector_id=? AND ${fullOwner} AND s.raw_bytes=? AND s.segmented_bytes=? AND s.row_bytes=?
          AND s.raw_hash=? AND s.source_version=? AND s.prefix_revision=?
          AND length(CAST(s.raw AS BLOB))<=? AND length(CAST(s.segmented AS BLOB))<=?`).bind(
            id,Number(n.raw_bytes),Number(n.segmented_bytes),Number(n.row_bytes),String(n.raw_hash),String(n.owner_version),Number(n.prefix_revision),Number(n.raw_bytes),Number(n.segmented_bytes));
      });
      const results=await db.batch<Row>(statements);
      for(let i=0;i<batch.length;i++) {
        const id=batch[i], row=results[i].results?.[0];
        if(!row) { fallback(id,'source_changed_or_missing'); continue; }
        try { const outcome=await verifyExcerpt(sources.get(id)!,row);
          if(typeof outcome==='string') fallback(id,outcome); else outcomes.set(id,{matched_context:outcome});
        } catch { fallback(id,'validation_failed'); }
        results[i].results=[]; // Release each raw row and position map before the next validation.
      }
    } catch { for(const id of batch) fallback(id,'source_read_failed'); }
  }
  return outcomes;
}
