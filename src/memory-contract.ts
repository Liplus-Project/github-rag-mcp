import { z } from 'zod';

export const MEMORY_INSTRUCTIONS = 'Successful search/scan/fetch writes a private trace. Retrieval is not usage or confirmation. Call record_source_use with selected (chosen for investigation), then validated (exact source checked and judged usable), then used (actually used in an answer or decision). record_outcome confirmed reinforces only saved graph paths of used sources. corrected/rolled_back names the confirmation receipt to reverse. Use a new idempotency_key for each operation; retry the same payload with the same key. memory_history lists traces or reads one trace. use_memory only orders graph candidates within the same hop; keyword scores/ranks never change. memory_unavailable means no usable trace was saved. Live inline doc/wiki bodies use returned-content SHA-256 versions and github_live provenance; stored-content fetch refers to the indexed snapshot.';
const handle = z.string().min(1).max(128);
const reason = z.string().min(1).max(1000);
export const memorySchemas = {
  memory_history: z.strictObject({ trace_id: handle.optional(), limit: z.number().int().min(1).max(50).default(10), cursor: handle.optional() }),
  record_source_use: z.strictObject({ trace_id: handle, idempotency_key: handle, uses: z.array(z.strictObject({ source_id: handle, stage: z.enum(['selected', 'validated', 'used']) })).min(1).max(100) }),
  record_outcome: z.strictObject({ trace_id: handle, idempotency_key: handle, outcome: z.enum(['confirmed', 'corrected', 'rolled_back']), source_ids: z.array(handle).min(1).max(100).optional(), confirmation_id: handle.optional(), reason }),
};
export const memoryDescriptions = {
  memory_history: 'Read your private, bounded trace history. trace_id returns source usage, current activation, saved paths, and outcome/reversal audit. Otherwise limit/cursor pages trace summaries.',
  record_source_use: 'Atomically record selected -> validated -> used for sources in your trace. selected = chosen for investigation; validated = exact source checked and usable; used = actually used in an answer/decision. Search alone is never used. Same key/payload returns the saved receipt; conflicting payload is rejected. Repeating a completed stage adds no activation.',
  record_outcome: 'confirmed requires source_ids already used in this trace and strengthens only saved actual graph paths. One trace contributes to each edge once. corrected/rolled_back requires confirmation_id and reverses only that receipt contribution, preserving other traces. reason is saved for audit. Lexical sources have no graph credit. Idempotent by key/payload.',
};
const metadata = z.record(z.string(), z.unknown());
const edge = z.object({ repo: z.string(), src: z.string(), dst: z.string(), kind: z.string() });
const savedSource = z.object({ source_id: handle, provenance: metadata, axes: z.array(z.string()), path: z.array(edge).max(2) });
const receipt = z.object({ receipt_id: handle, trace_id: handle, timestamp: z.string(), outcome: z.enum(['confirmed', 'corrected', 'rolled_back']).optional(), reason: z.string().optional(), confirmation_id: handle.nullable().optional(), uses: z.array(z.object({ source_id: handle, stage: z.enum(['selected', 'validated', 'used']) })).optional(), saved_sources: z.array(savedSource), changes: z.array(metadata), non_applied_reason: z.string().nullable(), active_credits: z.array(metadata).optional() });
const summary = z.object({ traces: z.array(z.object({ trace_id: handle, timestamp: z.string(), request: metadata, settings: metadata })).max(50), next_cursor: handle.nullable() });
const detail = z.object({ trace_id: handle, timestamp: z.string(), request: metadata, settings: metadata, policy: metadata, sources: z.array(savedSource.extend({ stage: z.enum(['retrieved', 'selected', 'validated', 'used']), activation: z.object({ retrieved: z.number().nonnegative(), usage: z.number().nonnegative(), total: z.number().nonnegative(), updated_at: z.string() }) })).max(300), audit: z.array(receipt).max(50), next_cursor: handle.nullable() });
export const memoryResultSchema = z.object({ data: z.union([summary, detail, receipt]) });
