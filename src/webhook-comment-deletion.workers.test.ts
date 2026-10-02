import { describe, it, expect, vi, beforeAll } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { handleWebhook } from './webhook.js';
import { issueCommentVectorId } from './pipeline/vector-id.js';
import { upsertFtsRow } from './fts.js';
import type { Env } from './types.js';

vi.mock('./github-ip.js', () => ({ isGitHubWebhookIP: async () => true }));
beforeAll(() => applyD1Migrations(env.DB_FTS, env.TEST_MIGRATIONS));
const timestamp = '2026-01-01T00:00:00Z';
const secret = 'synthetic-signature-test';

async function delivery(repo: string, id: number, bindings: Env) {
  const body = JSON.stringify({ action:'deleted', repository:{full_name:repo}, issue:{number:1428}, comment:{id} });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))), b => b.toString(16).padStart(2,'0')).join('');
  return handleWebhook(new Request('https://synthetic.example/webhook',{method:'POST',body,headers:{'X-GitHub-Event':'issue_comment','X-Hub-Signature-256':'sha256='+signature}}), bindings);
}
describe('comment deletion preserves canonical identity on partial teardown', () => {
  for (const failure of ['fts','vector','store-response','store-throw','none']) it(`handles ${failure} and explicit redelivery`, async () => {
    const repo = 'synthetic/delete-'+failure; const id = 263; const vid = await issueCommentVectorId(repo,id);
    const store = env.ISSUE_STORE.get(env.ISSUE_STORE.idFromName(crypto.randomUUID()));
    await store.fetch(new Request('http://store/upsert-comment',{method:'POST',body:JSON.stringify({repo,commentId:id,number:1428,author:'synthetic',bodyHash:'synthetic',createdAt:timestamp,updatedAt:timestamp})}));
    await upsertFtsRow(env.DB_FTS,{vectorId:vid,repo,type:'issue_comment',commentId:id,number:1428,state:'active',labels:'',milestone:'',assignees:'',updatedAt:timestamp,content:'Synthetic indexed comment'});
    let failing = true;
    const calls: string[] = [];
    const bindings = {
      GITHUB_WEBHOOK_SECRET:secret,
      VECTORIZE:{deleteByIds:async () => { calls.push('vector'); if (failing && failure === 'vector') throw new Error('Synthetic vector failure'); }},
      DB_FTS:{prepare:(query: string) => { if (failing && failure === 'fts') throw new Error('Synthetic FTS failure'); return env.DB_FTS.prepare(query); }},
      ISSUE_STORE:{idFromName:() => 'synthetic',get:() => ({fetch:async (r: Request) => { calls.push('store'); if (failing && failure === 'store-response') return new Response('failed',{status:503}); if (failing && failure === 'store-throw') throw new Error('Synthetic store failure'); return store.fetch(r); }})},
    } as unknown as Env;
    const result = await delivery(repo,id,bindings);
    const canonical = () => store.fetch(new Request(`http://store/comment?repo=${encodeURIComponent(repo)}&comment_id=${id}`));
    const rows = () => env.DB_FTS.prepare('SELECT vector_id FROM search_docs WHERE vector_id=?').bind(vid).all();
    if (failure !== 'none') {
      expect(result.status).toBe(503); expect((await result.json() as any).result).toBe('partial_delete');
      expect((await canonical()).status).toBe(200);
      if (failure === 'fts' || failure === 'vector') expect(calls).toEqual(['vector']);
      expect((await rows()).results).toHaveLength(failure === 'fts' ? 1 : 0);
      failing = false;
      expect((await delivery(repo,id,bindings)).status).toBe(202);
    } else {
      expect(result.status).toBe(202); expect((await result.json() as any).result).toBe('deleted');
    }
    expect((await canonical()).status).toBe(404); expect((await rows()).results).toHaveLength(0);
    expect((await delivery(repo,id,bindings)).status).toBe(202);
  });
});
