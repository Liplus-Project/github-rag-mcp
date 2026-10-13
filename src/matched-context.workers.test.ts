import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { upsertFtsRow, queryFts, type FtsUpsertRow } from './fts.js';
import { gitBlobSha, prepareSparseSource, sparseSourceStatement, type PrefixSnapshot } from './doc-sparse.js';
import { prepareEmbeddingInput, sha256Hex } from './pipeline/hash.js';
import { queryMatchedFts, resolveMatchedContexts, excerptBounds, verifyExcerpt, mergeSparseTiers } from './matched-context.js';
import { segmentForFts } from './segment.js';
import { createMcpHandler } from 'agents/mcp/server';
import { createRagMcpServer } from './mcp.js';
import { createRemoteClient } from '../mcp-server/server/remote-client.js';
import type { Env } from './types.js';

beforeAll(() => applyD1Migrations(env.DB_FTS, env.TEST_MIGRATIONS));
async function seed(repo:string,id:string,body:string,full=true,path='docs/a.md',type:'doc'|'wiki_doc'='doc',extra:Partial<FtsUpsertRow>={}) {
  const version=type==='doc'?await gitBlobSha(body):await sha256Hex(body);
  await upsertFtsRow(env.DB_FTS,{repo,vectorId:id,type,state:'active',labels:'',milestone:'',assignees:'',updatedAt:'2026-10-01',docPath:path,
    content:prepareEmbeddingInput(path,body),sourceVersion:version,...extra});
  if(full) {
    const p=(await env.DB_FTS.prepare('SELECT * FROM search_docs WHERE vector_id=?').bind(id).first<PrefixSnapshot>())!;
    await sparseSourceStatement(env.DB_FTS,await prepareSparseSource(id,type,path,body,version,p.indexed_at),p).run();
  }
}
async function client(ai: (...args:any[])=>Promise<unknown> = vi.fn(async()=>({response:[{id:0,score:0.9},{id:1,score:0.5}]})),vectors:unknown[]=[]) {
  const bindings={...env,DOC_SPARSE_CONTEXT_ENABLED:'false',AI:{run:ai},VECTORIZE:{query:vi.fn(async()=>({matches:vectors}))}} as unknown as Env;
  const handler=createMcpHandler(()=>createRagMcpServer(bindings),{route:'/mcp',legacy:'reject'});
  const remote=createRemoteClient({workerUrl:'https://synthetic.example',clientVersion:'test',fetch:(async(input:any,init:any)=>{
    const r=input instanceof Request?input:new Request(input,init); const headers=new Headers(r.headers);headers.set('host',new URL(r.url).host);
    return handler(new Request(r,{headers}),bindings,{props:{githubUserId:9281,accessToken:'synthetic-test-only'}} as any);
  }) as typeof fetch});
  return {call:async(args:unknown)=>{const r=await remote.callTool('search',args) as any;
    return {error:r.isError??false,data:r.isError?r.content[0].text:JSON.parse(r.content[0].text)};},reset:()=>remote.reset()};
}

describe('matched D1 retrieval and ownership',()=>{
  it('finds the tail with flag false, preserves prefix/default and returns exact indexed UTF16 slice',async()=>{
    const repo='matched/tail',body='intro '.repeat(1600)+'unique-tailneedle 😀 日本語説明';
    await seed(repo,'tail-full',body);
    expect(await queryFts(env.DB_FTS,'tailneedle',5,{repo,type:'doc'})).toEqual([]);
    const found=await queryMatchedFts(env.DB_FTS,'tailneedle',5,{repo,type:'doc'});
    expect(found.hits.map(h=>h.vectorId)).toEqual(['tail-full']);expect(found.coverage).toMatchObject({total:1,full:1,status:'complete'});
    const resolved=await resolveMatchedContexts(env.DB_FTS,['tail-full'],found.sources);
    const context=resolved.get('tail-full')!.matched_context!;
    expect(context.text).toContain('tailneedle');expect(context.text).toBe(('docs/a.md\n\n'+body).slice(context.start,context.end));
    expect(context.excerpt_hash).toBe(await sha256Hex(context.text));expect(context.end-context.start).toBeLessThanOrEqual(1400);
    const c=await client();
    for(const extra of [{},{doc_context:'prefix'}]) expect((await c.call({query:'tailneedle',repo,type:'doc',fusion:'sparse_only',rerank:false,...extra})).data.count).toBe(0);
    const r=(await c.call({query:'tailneedle',repo,type:'doc',fusion:'sparse_only',rerank:false,doc_context:'matched'})).data;
    expect(r.results[0].matched_context).toEqual(context);expect(r.rerank_applied).toBe(false);expect(r.doc_context_coverage.full).toBe(1);
    expect(r.results[0].content).toBeUndefined();await c.reset();
  });
  it('splits partial preparation, scopes metadata before LIMIT, and reports all scope rows before term matching',async()=>{
    const repo='matched/scope';
    await seed(repo,'scope-full','needle alpha',true,'docs/a.md','doc',{labels:' a, b ',assignees:' x, y ',milestone:'M'});
    await seed(repo,'scope-prefix','needle alpha',false,'docs/b.md','doc',{labels:'a,b',assignees:'y',milestone:'M'});
    await seed(repo,'scope-unmatched','irrelevant',false,'docs/c.md','doc',{labels:'a,b',assignees:'y',milestone:'M'});
    await seed(repo,'scope-excluded','needle alpha '.repeat(100),true,'other/a.md');
    const filter={repo,type:'doc' as const,pathPrefix:'docs/',labels:['a','b'],assignee:'y',milestone:'M',since:'2026-09',until:'2026-11'};
    const r=await queryMatchedFts(env.DB_FTS,'needle alpha',2,filter);
    expect(r.hits.map(h=>h.vectorId)).toEqual(['scope-full','scope-prefix']);
    expect(r.coverage).toEqual({status:'partial',total:3,full:1,prefix_only:2,unprepared:2,out_of_range:0,stale:0});
    expect(await queryMatchedFts(env.DB_FTS,'needle',1,{...filter,state:'closed'})).toMatchObject({hits:[],coverage:{total:0,full:0}});
  });
  it('ranks strict before relaxed across both corpora, with stable ties and one sparse vote',async()=>{
    const repo='matched/tiers';
    await seed(repo,'tiers-z','needle alpha',true);await seed(repo,'tiers-a','needle alpha',false);
    await seed(repo,'tiers-relaxed','needle',true);
    expect((await queryMatchedFts(env.DB_FTS,'needle alpha',5,{repo,type:'doc'})).hits.map(h=>h.vectorId)).toEqual(['tiers-a','tiers-z','tiers-relaxed']);
    expect(mergeSparseTiers([{tier:0,rows:[{vector_id:'x',score:-100}]},{tier:0,rows:[{vector_id:'x',score:-1}]},{tier:1,rows:[{vector_id:'a'}]}],50).map(r=>r.vector_id)).toEqual(['x','a']);
  });
  it('keeps every prefix owner if full query/schema fails and exposes unavailable',async()=>{
    const repo='matched/unavailable';await seed(repo,'unavailable-full','fallbackneedle',true);await seed(repo,'unavailable-prefix','fallbackneedle',false);
    const broken={prepare:(sql:string)=>{if(sql.includes('doc_sparse_fts_v1'))throw new Error('synthetic full failure');return env.DB_FTS.prepare(sql);},batch:env.DB_FTS.batch.bind(env.DB_FTS)} as D1Database;
    const r=await queryMatchedFts(broken,'fallbackneedle',5,{repo,type:'doc'});
    expect(new Set(r.hits.map(h=>h.vectorId))).toEqual(new Set(['unavailable-full','unavailable-prefix']));expect(r.coverage.status).toBe('unavailable');
    await applyD1Migrations(env.DB_FTS_DOC_LEGACY,env.TEST_MIGRATIONS.filter(m=>!m.name.startsWith('0009')));
    await upsertFtsRow(env.DB_FTS_DOC_LEGACY,{vectorId:'matched-legacy',repo,type:'doc',state:'active',labels:'',milestone:'',assignees:'',updatedAt:'2026-10-01',docPath:'a.md',content:'fallbackneedle'});
    expect(await queryMatchedFts(env.DB_FTS_DOC_LEGACY,'fallbackneedle',5,{repo,type:'doc'})).toMatchObject({hits:[{vectorId:'matched-legacy'}],coverage:{status:'unavailable'}});
  });
  it('rejects update/delete races, unknown position, stale owners and raw read failure without losing candidates',async()=>{
    const repo='matched/races';await seed(repo,'race-update','raceneedle',true);await seed(repo,'race-delete','raceneedle',true);await seed(repo,'race-stale','raceneedle',true);
    const r=await queryMatchedFts(env.DB_FTS,'raceneedle',5,{repo,type:'doc'});
    await env.DB_FTS.prepare('UPDATE search_docs SET content=? WHERE vector_id=?').bind('new','race-update').run();
    await env.DB_FTS.prepare('DELETE FROM search_docs WHERE vector_id=?').bind('race-delete').run();
    await env.DB_FTS.prepare('UPDATE doc_sparse_sources SET prefix_revision=prefix_revision+1 WHERE vector_id=?').bind('race-stale').run();
    const out=await resolveMatchedContexts(env.DB_FTS,['race-update','race-delete'],r.sources);
    expect(out.get('race-update')?.matched_context_fallback).toBe('source_changed_or_missing');expect(out.get('race-delete')?.matched_context_fallback).toBe('source_changed_or_missing');
    const fresh=await queryMatchedFts(env.DB_FTS,'raceneedle',5,{repo,type:'doc'});
    expect(fresh.coverage.stale).toBe(1);expect(fresh.hits.map(h=>h.vectorId)).toContain('race-stale');
    expect((await resolveMatchedContexts(env.DB_FTS,['race-stale'],fresh.sources)).get('race-stale')?.matched_context_fallback).toBe('stale_source');
    const fail={prepare:env.DB_FTS.prepare.bind(env.DB_FTS),batch:async()=>{throw new Error('synthetic read failure');}} as unknown as D1Database;
    expect((await resolveMatchedContexts(fail,['race-stale'],r.sources)).get('race-stale')?.matched_context_fallback).toBe('source_read_failed');
  });
  it('validates Unicode, duplicate fragments, segmentation, path/hash/version and span guards',async()=>{
    const raw='p.md\n\n'+'😀 日本語 '.repeat(400)+'終端独自文'; const stored=segmentForFts(raw);
    const b=excerptBounds(raw,stored,segmentForFts('終端独自文'));
    expect(typeof b).toBe('object');if(typeof b==='object') expect(raw.slice(b.start,b.end)).toContain('終端独自文');
    expect(excerptBounds(raw,stored,'😀')).toBe('ambiguous_fragment');expect(excerptBounds(raw,stored+'x','x')).toBe('segmentation_mismatch');
    expect(excerptBounds('😀','😀','\uDE00')).toBe('invalid_span');expect(excerptBounds('xx','xx','\u0001x\u0001x')).toBe('ambiguous_fragment');
    await seed('matched/guards','guards','guardneedle',true);
    const search=await queryMatchedFts(env.DB_FTS,'guardneedle',5,{repo:'matched/guards',type:'doc'}), narrow=search.sources.get('guards')!;
    const owner=(await env.DB_FTS.prepare('SELECT raw,segmented FROM doc_sparse_sources WHERE vector_id=?').bind('guards').first<Record<string,unknown>>())!;
    const row={...narrow,...owner};
    expect(typeof await verifyExcerpt(narrow,row)).toBe('object');
    expect(await verifyExcerpt(narrow,{...row,source_revision:999})).toBe('version_mismatch');
    expect(await verifyExcerpt(narrow,{...row,raw:String(row.raw).replace('guardneedle','wrongneedle')})).toBe('hash_mismatch');
    const bad={...row,body_hash:'wrong'};expect(await verifyExcerpt(bad,bad)).toBe('hash_mismatch');
  });
  it('skips large candidates, respects cumulative raw budget, batches five and caps selected raw reads at 50',async()=>{
    const repo='matched/budget';await seed(repo,'budget-source','budgetneedle',true);
    const r=await queryMatchedFts(env.DB_FTS,'budgetneedle',5,{repo,type:'doc'}), n=r.sources.get('budget-source')!;
    const sources=new Map<string,Record<string,unknown>>(), ids=Array.from({length:60},(_,i)=>`budget-${i}`);
    for(const id of ids)sources.set(id,{...n,vector_id:id});sources.set(ids[0],{...n,vector_id:ids[0],raw_bytes:262145});
    const batches:number[]=[];
    const db={prepare:env.DB_FTS.prepare.bind(env.DB_FTS),batch:async(statements:D1PreparedStatement[])=>{batches.push(statements.length);return statements.map(()=>({results:[]}));}} as unknown as D1Database;
    const out=await resolveMatchedContexts(db,ids,sources);expect(out.size).toBe(50);expect(out.get(ids[0])?.matched_context_fallback).toBe('source_budget');
    expect(batches.reduce((a,b)=>a+b,0)).toBe(49);expect(Math.max(...batches)).toBe(5);
    for(const id of ids)sources.set(id,{...n,vector_id:id,raw_bytes:262144});
    batches.length=0;const limited=await resolveMatchedContexts(db,ids,sources);
    expect(batches).toEqual([4]);expect(limited.get(ids[4])?.matched_context_fallback).toBe('request_budget');
  });
  it('supports wiki, dense-only fallback and exact model text, and rejects incompatible modes',async()=>{
    await seed('matched/wiki','wiki-full','head '.repeat(1800)+'wikitailneedle',true,'Home','wiki_doc');
    await seed('matched/wiki','wiki-prefix','wikitailneedle',false,'Other','wiki_doc');
    const ai=vi.fn(async()=>({response:[{id:0,score:0.9},{id:1,score:0.8}]})), c=await client(ai);
    const r=(await c.call({query:'wikitailneedle',repo:'matched/wiki',type:'wiki_doc',fusion:'sparse_only',doc_context:'matched'})).data;
    const model=ai.mock.calls[0] as unknown as [string,{contexts:{text:string}[]}];
    expect(model[1].contexts.some(v=>v.text===r.results.find((x:any)=>x.vector_id==='wiki-full').matched_context.text)).toBe(true);
    expect(r.results.find((x:any)=>x.vector_id==='wiki-prefix').matched_context_fallback).toBe('unprepared');
    for(const args of [{query:'x',type:'all'},{type:'doc'},{query:'x',type:'doc',vector_ids:['wiki-full']}]) expect((await c.call({...args,doc_context:'matched'})).error).toBe(true);
    await c.reset();
    const denseAi=vi.fn(async()=>({data:[[0.1]]}));
    const dense=await client(denseAi,[{id:'wiki-full',score:0.9,metadata:{repo:'matched/wiki',type:'wiki_doc',state:'active',wiki_path:'Home',updated_at:'2026-10-01'}}]);
    const d=(await dense.call({query:'wikitailneedle',repo:'matched/wiki',type:'wiki_doc',fusion:'dense_only',rerank:false,doc_context:'matched'})).data;
    expect(d.results[0].matched_context_fallback).toBe('no_full_sparse_position');expect(d.doc_context_coverage.full).toBe(1);await dense.reset();
  });
});
