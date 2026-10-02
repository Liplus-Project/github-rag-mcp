import { describe, it, expect, vi } from 'vitest';
import { rememberResult } from './memory-api.js';
import type { Env } from './types.js';
vi.mock('agents/mcp/server', () => ({ getMcpAuthContext: () => ({props:{githubUserId:9263}}) }));
const row = (identity: string) => ({repo:'synthetic/unit',type:'wiki_doc',wiki_path:identity,updated_at:'2026-01-01T00:00:00Z'});
function fixture() {
  const saved: any[] = [];
  const env = { ISSUE_STORE:{idFromName:() => 'global',get:() => ({ fetch:async (r: Request) => {
    const data = await r.json() as any; saved.push(data.args);
    return Response.json({trace_id:'synthetic-trace',timestamp:'2026-01-01T00:00:00Z',policy:{},sources:data.args.sources.map((s: any) => ({...s,activation:{retrieved:0.1,usage:0,total:0.1,updated_at:'2026-01-01T00:00:00Z'}}))});
  }})} } as unknown as Env;
  return {env,saved};
}
describe('source-level memory failure classification', () => {
  it('handles mixed axes and folded members independently, including invalid live versions', async () => {
    const {env,saved} = fixture();
    const bad = {repo:'synthetic/unit',type:'pr_review',number:1,review_id:0,updated_at:'2026-01-01T00:00:00Z'};
    const payload = {count:1,mode:'search',results:[{...bad,same_entity:{others:[row('good-fold')]}}],graph_results:[{...row('good-graph'),same_entity:{others:[{...row('bad-live'),content_source:'github_live',content_version:'invalid'}]}}]};
    const result = await rememberResult(env,payload,{query:'synthetic'});
    expect(result.memory_recording).toMatchObject({status:'partial',recorded_sources:2,excluded_sources:2,exclusions:[{location:'results[0]',reason:'canonical_identity_unavailable'},{location:'graph_results[0].same_entity.others[0]',reason:'live_version_unavailable'}]});
    expect(result.results[0].source_id).toBeUndefined(); expect(result.results[0].same_entity.others[0].source_id).toBeTruthy();
    expect(saved[0].sources).toHaveLength(2); expect(saved[0].settings.memory_recording).toEqual(result.memory_recording);
    expect(saved[0].settings.results).toBeUndefined(); expect(saved[0].settings.graph_results).toBeUndefined();
  });
  it('does not classify an unexpected processing exception as an excluded source', async () => {
    const {env,saved} = fixture(); const bad = {...row('unexpected'),get updated_at(): string {throw new Error('Synthetic unexpected exception');}};
    const result = await rememberResult(env,{count:2,mode:'fetch',results:[row('valid'),bad]},{});
    expect(result.memory_error).toBe('memory_save_failed'); expect(result.memory_recording).toBeUndefined();
    expect(result.trace_id).toBeUndefined(); expect(result.feedback_available).toBe(false); expect(saved).toEqual([]);
  });
});
