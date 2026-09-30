/** Private SQLite memory. Every mutation runs inside the owning DO transactionSync. */
import { memorySchemas } from './memory-contract.js';
export const MEMORY_POLICY = { half_life_seconds: 3600, activation_cap: 10, retrieved: 0.1, selected: 0.2, validated: 0.5, used: 1, strength_cap: 5, confirmed_delta: 0.25 } as const;
export interface SavedEdge { repo: string; src: string; dst: string; kind: string }
export interface SavedSource { source_id: string; provenance: Record<string, unknown>; axes: string[]; path: SavedEdge[] }
export function decay(value: number, updated: number, now: number): number {
  return Math.max(0, value) * Math.pow(0.5, Math.max(0, now - updated) / (MEMORY_POLICY.half_life_seconds * 1000));
}
export function edgeKey(e: SavedEdge): string { return JSON.stringify([e.repo, e.src, e.dst, e.kind]); }
const stages = ['selected', 'validated', 'used'];
function canonical(x: unknown): string {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(x);
}
export class MemoryStore {
  constructor(private sql: SqlStorage, private transaction: <T>(fn: () => T) => T, private clock = () => Date.now()) {
    sql.exec(`CREATE TABLE IF NOT EXISTS memory_traces (seq INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL, trace_id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL, request TEXT NOT NULL, settings TEXT NOT NULL, sources TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_trace_owner ON memory_traces(principal,seq);
      CREATE TABLE IF NOT EXISTS memory_usage (principal TEXT NOT NULL, trace_id TEXT NOT NULL, source_id TEXT NOT NULL, stage INTEGER NOT NULL, PRIMARY KEY(principal,trace_id,source_id));
      CREATE TABLE IF NOT EXISTS memory_activation (principal TEXT NOT NULL, source_id TEXT NOT NULL, retrieved REAL NOT NULL, usage REAL NOT NULL, updated REAL NOT NULL, PRIMARY KEY(principal,source_id));
      CREATE TABLE IF NOT EXISTS memory_receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL, trace_id TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, UNIQUE(principal,key));
      CREATE INDEX IF NOT EXISTS memory_receipt_trace ON memory_receipts(principal,trace_id,seq);
      CREATE TABLE IF NOT EXISTS memory_edges (principal TEXT NOT NULL, edge TEXT NOT NULL, strength REAL NOT NULL, updated REAL NOT NULL, PRIMARY KEY(principal,edge));
      CREATE TABLE IF NOT EXISTS memory_credits (principal TEXT NOT NULL, trace_id TEXT NOT NULL, receipt_id TEXT NOT NULL, edge TEXT NOT NULL, delta REAL NOT NULL, timestamp REAL NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(principal,trace_id,edge));
      CREATE INDEX IF NOT EXISTS memory_credit_receipt ON memory_credits(principal,receipt_id);`);
  }
  private rows(query: string, ...args: (string | number)[]) { return this.sql.exec(query, ...args).toArray(); }
  private trace(p: string, id: string) {
    const t = this.rows('SELECT * FROM memory_traces WHERE principal=? AND trace_id=?', p, id)[0];
    if (!t) throw new Error('Unknown trace');
    return { ...t, trace_id: t.trace_id, timestamp: t.timestamp, request: t.request, settings: t.settings, sources: JSON.parse(String(t.sources)) as SavedSource[] };
  }
  private activation(p: string, id: string, now: number) {
    const a = this.rows('SELECT * FROM memory_activation WHERE principal=? AND source_id=?', p, id)[0];
    return { retrieved: a ? decay(Number(a.retrieved), Number(a.updated), now) : 0, usage: a ? decay(Number(a.usage), Number(a.updated), now) : 0, updated: a ? Number(a.updated) : now };
  }
  private addActivation(p: string, id: string, channel: 'retrieved' | 'usage', amount: number, now: number) {
    const a = this.activation(p, id, now);
    // Each channel has its own cap, making retrieval and explicit usage inspectable.
    a[channel] = Math.min(MEMORY_POLICY.activation_cap, a[channel] + amount);
    this.sql.exec('INSERT OR REPLACE INTO memory_activation VALUES (?,?,?,?,?)', p, id, a.retrieved, a.usage, Math.max(a.updated, now));
  }
  private current(p: string, s: SavedSource, now: number) {
    const a = this.activation(p, s.source_id, now);
    return { ...s, activation: { retrieved: a.retrieved, usage: a.usage, total: a.retrieved + a.usage, updated_at: new Date(a.updated).toISOString() } };
  }
  save(p: string, input: { request: unknown; settings: unknown; sources: SavedSource[] }) {
    if (!Array.isArray(input.sources) || input.sources.length > 300 || JSON.stringify(input).length > 300000) throw new Error('Trace bound exceeded');
    return this.transaction(() => {
      const now = this.clock(); const trace_id = crypto.randomUUID();
      const unique = [...new Map(input.sources.map(s => [s.source_id, s])).values()];
      this.sql.exec('INSERT INTO memory_traces(principal,trace_id,timestamp,request,settings,sources) VALUES(?,?,?,?,?,?)', p, trace_id, new Date(now).toISOString(), JSON.stringify(input.request), JSON.stringify(input.settings), JSON.stringify(unique));
      for (const s of unique) this.addActivation(p, s.source_id, 'retrieved', MEMORY_POLICY.retrieved, now);
      return { trace_id, timestamp: new Date(now).toISOString(), policy: MEMORY_POLICY, sources: unique.map(s => this.current(p, s, now)) };
    });
  }
  history(p: string, raw: unknown) {
    const args = memorySchemas.memory_history.parse(raw); const now = this.clock();
    if (args.trace_id) {
      const t = this.trace(p, args.trace_id);
      const usage = this.rows('SELECT source_id,stage FROM memory_usage WHERE principal=? AND trace_id=?', p, args.trace_id);
      // Audit is separately paged; never scan the entire receipt history.
      const cursor = args.cursor ? this.receiptCursor(p, args.trace_id, args.cursor) : 0;
      const audit = this.rows('SELECT * FROM memory_receipts WHERE principal=? AND trace_id=? AND seq>? ORDER BY seq LIMIT ?', p, args.trace_id, cursor, args.limit + 1);
      return { trace_id: t.trace_id, timestamp: t.timestamp, request: JSON.parse(String(t.request)), settings: JSON.parse(String(t.settings)), policy: MEMORY_POLICY,
        sources: t.sources.map(s => ({ ...this.current(p, s, now), stage: stages[Number(usage.find(u => u.source_id === s.source_id)?.stage ?? -1)] ?? 'retrieved' })),
        audit: audit.slice(0, args.limit).map(r => ({ ...JSON.parse(String(r.data)), active_credits: this.rows('SELECT edge,delta,timestamp,active FROM memory_credits WHERE principal=? AND receipt_id=?', p, String(r.receipt_id)) })),
        next_cursor: audit.length > args.limit ? audit[args.limit - 1].receipt_id : null };
    }
    let before = Number.MAX_SAFE_INTEGER;
    if (args.cursor) { const c = this.rows('SELECT seq FROM memory_traces WHERE principal=? AND trace_id=?', p, args.cursor)[0]; if (!c) throw new Error('Unknown cursor'); before = Number(c.seq); }
    const list = this.rows('SELECT trace_id,timestamp,request,settings FROM memory_traces WHERE principal=? AND seq<? ORDER BY seq DESC LIMIT ?', p, before, args.limit + 1);
    return { traces: list.slice(0, args.limit).map(t => ({ ...t, request: JSON.parse(String(t.request)), settings: JSON.parse(String(t.settings)) })), next_cursor: list.length > args.limit ? list[args.limit - 1].trace_id : null };
  }
  private receiptCursor(p: string, trace: string, id: string) { const r = this.rows('SELECT seq FROM memory_receipts WHERE principal=? AND trace_id=? AND receipt_id=?', p, trace, id)[0]; if (!r) throw new Error('Unknown cursor'); return Number(r.seq); }
  strengths(p: string, paths: SavedEdge[][]) {
    if (paths.length > 200 || paths.some(path => path.length > 2)) throw new Error('Path bound exceeded');
    const now = this.clock();
    return paths.map(path => path.reduce((sum, e) => { const r = this.rows('SELECT strength,updated FROM memory_edges WHERE principal=? AND edge=?', p, edgeKey(e))[0]; return sum + (r ? decay(Number(r.strength), Number(r.updated), now) : 0); }, 0));
  }
  mutate(p: string, tool: 'record_source_use' | 'record_outcome', raw: unknown) {
    const args = memorySchemas[tool].parse(raw); const payload = canonical({ tool, args });
    return this.transaction(() => {
      const old = this.rows('SELECT payload,data FROM memory_receipts WHERE principal=? AND key=?', p, args.idempotency_key)[0];
      if (old) { if (old.payload !== payload) throw new Error('Idempotency conflict'); return JSON.parse(String(old.data)); }
      const t = this.trace(p, args.trace_id); const now = this.clock(); const receipt_id = crypto.randomUUID();
      const changes: unknown[] = [];
      if (tool === 'record_source_use') {
        const a = memorySchemas.record_source_use.parse(raw);
        for (const u of a.uses) {
          const s = t.sources.find(s => s.source_id === u.source_id); if (!s) throw new Error('Unknown source in trace');
          const prev = this.rows('SELECT stage FROM memory_usage WHERE principal=? AND trace_id=? AND source_id=?', p, a.trace_id, u.source_id)[0];
          const stage = stages.indexOf(u.stage); const current = prev ? Number(prev.stage) : -1;
          if (stage <= current) { changes.push({ ...u, applied: false }); continue; }
          if (stage !== current + 1) throw new Error('Usage stage order violation');
          this.sql.exec('INSERT OR REPLACE INTO memory_usage VALUES(?,?,?,?)', p, a.trace_id, u.source_id, stage);
          this.addActivation(p, u.source_id, 'usage', MEMORY_POLICY[u.stage], now); changes.push({ ...u, applied: true });
        }
      } else {
        const a = memorySchemas.record_outcome.parse(raw);
        if (a.outcome === 'confirmed') {
          if (!a.source_ids || a.confirmation_id) throw new Error('confirmed requires source_ids only');
          const edges = new Map<string, SavedEdge>();
          for (const id of a.source_ids) {
            const s = t.sources.find(s => s.source_id === id); if (!s) throw new Error('Unknown source in trace');
            const u = this.rows('SELECT stage FROM memory_usage WHERE principal=? AND trace_id=? AND source_id=?', p, a.trace_id, id)[0];
            if (Number(u?.stage ?? -1) !== 2) throw new Error('Confirmation requires used source');
            for (const e of s.path) edges.set(edgeKey(e), e);
          }
          for (const [key, e] of edges) {
            if (this.rows('SELECT 1 FROM memory_credits WHERE principal=? AND trace_id=? AND edge=?', p, a.trace_id, key).length) { changes.push({ edge: e, applied: false, reason: 'trace_already_credited' }); continue; }
            const r = this.rows('SELECT * FROM memory_edges WHERE principal=? AND edge=?', p, key)[0]; const at = Math.max(now, Number(r?.updated ?? now));
            const strength = r ? decay(Number(r.strength), Number(r.updated), at) : 0; const delta = Math.min(MEMORY_POLICY.confirmed_delta, Math.max(0, MEMORY_POLICY.strength_cap - strength));
            this.sql.exec('INSERT OR REPLACE INTO memory_edges VALUES(?,?,?,?)', p, key, strength + delta, at);
            this.sql.exec('INSERT INTO memory_credits VALUES(?,?,?,?,?,?,1)', p, a.trace_id, receipt_id, key, delta, at);
            changes.push({ edge: e, delta, reason: delta > 0 ? 'confirmed_path' : 'strength_cap_reached', timestamp: new Date(at).toISOString(), applied: delta > 0 });
          }
        } else {
          if (!a.confirmation_id || a.source_ids) throw new Error('Reversal requires confirmation_id only');
          const r = this.rows('SELECT data FROM memory_receipts WHERE principal=? AND trace_id=? AND receipt_id=?', p, a.trace_id, a.confirmation_id)[0];
          if (!r || JSON.parse(String(r.data)).outcome !== 'confirmed') throw new Error('Unknown confirmation for trace');
          const credits = this.rows('SELECT * FROM memory_credits WHERE principal=? AND receipt_id=?', p, a.confirmation_id);
          for (const c of credits) {
            if (!c.active) continue;
            const edge = this.rows('SELECT * FROM memory_edges WHERE principal=? AND edge=?', p, String(c.edge))[0]; const at = Math.max(now, Number(edge.updated));
            const removed = decay(Number(c.delta), Number(c.timestamp), at);
            this.sql.exec('UPDATE memory_edges SET strength=?,updated=? WHERE principal=? AND edge=?', Math.max(0, decay(Number(edge.strength), Number(edge.updated), at) - removed), at, p, String(c.edge));
            this.sql.exec('UPDATE memory_credits SET active=0 WHERE principal=? AND trace_id=? AND edge=?', p, a.trace_id, String(c.edge));
            changes.push({ edge: JSON.parse(String(c.edge)), reversed_delta: removed, confirmation_id: a.confirmation_id });
          }
        }
      }
      const data = { non_applied_reason: changes.length === 0 ? ('outcome' in args && args.outcome === 'confirmed' ? 'no_graph_path' : 'no_active_credits') : null, receipt_id, trace_id: args.trace_id, timestamp: new Date(now).toISOString(), ...('outcome' in args ? { outcome: args.outcome, reason: args.reason, confirmation_id: args.confirmation_id ?? null } : { uses: memorySchemas.record_source_use.parse(raw).uses }), saved_sources: t.sources.filter(s => 'source_ids' in args && args.source_ids?.includes(s.source_id)), changes };
      this.sql.exec('INSERT INTO memory_receipts(principal,trace_id,key,payload,receipt_id,data) VALUES(?,?,?,?,?,?)', p, args.trace_id, args.idempotency_key, payload, receipt_id, JSON.stringify(data));
      return data;
    });
  }
}
