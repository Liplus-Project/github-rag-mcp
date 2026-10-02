import type { SavedEdge, SavedSource } from './memory.js';
import { MEMORY_INSTRUCTIONS, memoryDescriptions, memorySchemas, memoryResultSchema } from './memory-contract.js';
import { getMcpAuthContext } from 'agents/mcp/server';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Env } from './types.js';
import type { McpProps } from './oauth.js';
export async function memoryCall(env: Env, action: string, args: unknown): Promise<any> {
  const id = (getMcpAuthContext()?.props as McpProps | undefined)?.githubUserId;
  if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new Error('Authenticated principal required');
  const stub = env.ISSUE_STORE.get(env.ISSUE_STORE.idFromName('global'));
  const res = await stub.fetch(new Request('http://store/memory', { method: 'POST', body: JSON.stringify({ principal: `github:${id}`, action, args }) }));
  if (!res.ok) { const failure = await res.json() as { error?: string }; throw new Error(failure.error ?? 'invalid_memory_request'); }
  return res.json();
}
export function registerMemoryTools(server: McpServer, env: Env) {
  for (const name of Object.keys(memorySchemas) as (keyof typeof memorySchemas)[]) {
    server.registerTool(name, { description: memoryDescriptions[name], inputSchema: memorySchemas[name], outputSchema: memoryResultSchema,
      annotations: { readOnlyHint: name === 'memory_history', destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (args: unknown) => {
      try { const data = await memoryCall(env, name, args); return { content: [{ type: 'text' as const, text: JSON.stringify({ data }) }], structuredContent: { data } }; }
      catch (err) { const allowed = ['unknown_trace', 'unknown_source', 'unknown_cursor', 'idempotency_conflict', 'stage_order_violation', 'used_source_required', 'unknown_confirmation', 'confirmation_id_required', 'source_ids_required']; const code = err instanceof Error && allowed.includes(err.message) ? err.message : 'invalid_memory_request'; return { content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }], isError: true }; }
    });
  }
}
async function digest(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), x => x.toString(16).padStart(2, '0')).join(''); }
export async function hashReturnedContent(content: string): Promise<string> { return 'sha256:' + await digest(content); }
class SourceIdentityError extends Error {
  constructor(public readonly reason: 'canonical_identity_unavailable' | 'live_version_unavailable') { super(reason); }
}
export async function identifySource(row: Record<string, any>, axis: string): Promise<SavedSource> {
  const repo = String(row.repo ?? ''); const type = String(row.type ?? '');
  const path = type === 'wiki_doc' ? (row.wiki_path || row.doc_path || '') : type === 'doc' ? (row.doc_path || '') : (row.file_path || '');
  const event = type === 'pr_review' ? row.review_id : ['issue_comment', 'pr_review_comment'].includes(type) ? row.comment_id : null;
  if (!repo || !type || !row.updated_at || (event !== null && (!Number.isSafeInteger(event) || event <= 0))) throw new SourceIdentityError('canonical_identity_unavailable');
  const identity = ['doc', 'wiki_doc'].includes(type) ? path : type === 'diff' ? [row.commit_sha, path] : type === 'release' ? row.tag_name : event ?? row.number;
  if (!identity || (Array.isArray(identity) && identity.some(x => !x))) throw new SourceIdentityError('canonical_identity_unavailable');
  const live = row.content_source === 'github_live';
  if (live && (!['doc', 'wiki_doc'].includes(type) || !/^sha256:[0-9a-f]{64}$/.test(row.content_version ?? ''))) throw new SourceIdentityError('live_version_unavailable');
  const canonical = { repo, type, identity, version: live ? row.content_version : row.updated_at, content_source: live ? 'github_live' : 'index' };
  const provenance = { ...canonical, ...(live ? { index_updated_at: row.updated_at } : {}) };
  return { source_id: 's:' + await digest(JSON.stringify(canonical)), provenance, axes: [axis], path: row.graph_path ?? [] };
}
/** Commit a successful result before emitting its trace. No body, title, handle, or auth props is stored. */
export async function rememberResult(env: Env, payload: any, request: unknown) {
  const incomplete = payload.memory_incomplete; delete payload.memory_incomplete;
  // Internal traversal snapshots include nodes omitted by the graph output cap.
  const graphNodes = new Map<any, any[]>();
  for (const row of payload.graph_results ?? []) { graphNodes.set(row, row.memory_graph_nodes ?? []); delete row.memory_graph_nodes; }
  if (incomplete) { return { ...payload, memory_unavailable: true, memory_error: 'retrieval_incomplete', feedback_available: false }; }
  try {
    const entries: { row: Record<string, any>; source: SavedSource }[] = [];
    const excluded: { location: string; reason: string }[] = [];
    const graphExcluded: { location: string; reason: string }[] = [];
    const add = async (row: Record<string, any>, axis: string, location: string) => {
      try { entries.push({ row, source: await identifySource(row, axis) }); }
      catch (err) {
        if (!(err instanceof SourceIdentityError)) throw err;
        excluded.push({ location, reason: err.reason });
        row.feedback_available = false; row.memory_exclusion_reason = err.reason;
      }
    };
    for (const axis of ['results', 'graph_results']) for (const row of payload[axis] ?? []) {
      const location = `${axis}[${payload[axis].indexOf(row)}]`;
      await add(row, axis === 'results' ? 'keyword' : 'graph', location);
      for (const [i, other] of (row.same_entity?.others ?? []).entries()) await add(other, 'keyword', `${location}.same_entity.others[${i}]`);
    }
    for (const { row, source } of entries) {
      if (!source.path.length) continue;
      const nodes = graphNodes.get(row) ?? [];
      let safe = nodes.length === source.path.length + 1 && source.path.length <= 2;
      for (const node of nodes) {
        if (!node || node.type !== 'wiki_doc') { safe = false; continue; }
        try { await identifySource({ ...node, wiki_path: node.doc_path }, 'graph'); }
        catch (err) { if (!(err instanceof SourceIdentityError)) throw err; safe = false; }
      }
      for (const [i, edge] of source.path.entries()) {
        const a = nodes[i], b = nodes[i + 1];
        if (!a || !b || a.repo !== edge.repo || b.repo !== edge.repo || edge.kind !== 'mention' ||
          !((a.doc_path === edge.src && b.doc_path === edge.dst) || (a.doc_path === edge.dst && b.doc_path === edge.src))) safe = false;
      }
      if (!safe) {
        source.path = [];
        row.graph_feedback_available = false; row.graph_feedback_exclusion_reason = 'unverifiable_graph_path';
        graphExcluded.push({ location: `graph_results[${payload.graph_results.indexOf(row)}]`, reason: 'unverifiable_graph_path' });
      }
    }
    const unique = new Map<string, SavedSource>();
    for (const { source } of entries) { const old = unique.get(source.source_id); if (old) { old.axes = [...new Set([...old.axes, ...source.axes])]; if (source.path.length) old.path = source.path; } else unique.set(source.source_id, source); }
    const { results, graph_results, ...settings } = payload;
    const recording = { status: excluded.length ? (entries.length ? 'partial' : 'unresolved') : 'complete', recorded_sources: unique.size, excluded_sources: excluded.length, exclusions: excluded, excluded_graph_paths: graphExcluded.length, graph_exclusions: graphExcluded };
    if (!entries.length && excluded.length) return { ...payload, memory_recording: recording, memory_unavailable: true, memory_error: 'all_sources_unresolved', feedback_available: false };
    // Settings only contain retrieval controls/outcomes, not document text.
    const saved = await memoryCall(env, 'save', { request, settings: { ...settings, memory_recording: recording }, sources: [...unique.values()] });
    const snapshots = new Map(saved.sources.map((s: any) => [s.source_id, s]));
    for (const { row, source } of entries) { row.source_id = source.source_id; row.provenance = source.provenance; row.activation = (snapshots.get(source.source_id) as any).activation; }
    return { ...payload, memory_recording: recording, trace_id: saved.trace_id, timestamp: saved.timestamp, memory_policy: saved.policy, feedback_available: true };
  } catch { return { ...payload, memory_unavailable: true, memory_error: 'memory_save_failed', feedback_available: false }; }
}
export { MEMORY_INSTRUCTIONS };
