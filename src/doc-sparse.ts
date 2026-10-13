import { segmentForFts } from './segment.js';
import { sha256Hex } from './pipeline/hash.js';
import type { Env } from './types.js';

export const DOC_SPARSE_INDEX_VERSION = 'full-v1';
export const MAX_RAW_BYTES = 256 * 1024;
export const MAX_SEGMENTED_BYTES = 512 * 1024;
export const MAX_ROW_BYTES = 1024 * 1024;
export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
export const docSparseEnabled = (env: Env): boolean => env.DOC_SPARSE_CONTEXT_ENABLED === 'true';

export interface SparseSource {
  vectorId: string; type: 'doc' | 'wiki_doc'; sourceVersion: string;
  prefixIndexedAt: string; indexVersion: string;
  sourceHash: string | null; bodyHash: string | null; rawHash: string | null;
  raw: string | null; segmented: string | null;
  rawBytes: number | null; segmentedBytes: number | null; rowBytes: number;
  coverage: 'full' | 'out_of_range'; reason: string; observedAt: string;
}

/** Conservative owner budget: all TEXT bytes plus 256 bytes of scalar/header allowance. */
export function sourceRowBytes(source: SparseSource): number {
  return 256 + Object.values(source).reduce<number>((n, v) => n + (typeof v === 'string' ? utf8Bytes(v) : 0), 0);
}

export async function gitBlobSha(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header); all.set(bytes, header.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', all)))
    .map(v => v.toString(16).padStart(2, '0')).join('');
}

export async function prepareSparseSource(
  vectorId: string, type: SparseSource['type'], path: string, body: string,
  sourceVersion: string, prefixIndexedAt = '',
): Promise<SparseSource> {
  const bodyHash = await sha256Hex(body);
  const sourceHash = type === 'doc' ? await gitBlobSha(body) : bodyHash;
  if (sourceHash !== sourceVersion) throw new Error('Source version mismatch');
  const raw = `${path}\n\n${body}`;
  const source: SparseSource = {
    vectorId, type, sourceVersion, prefixIndexedAt, indexVersion: DOC_SPARSE_INDEX_VERSION,
    sourceHash, bodyHash, rawHash: await sha256Hex(raw), raw: null, segmented: null,
    rawBytes: utf8Bytes(raw), segmentedBytes: null, rowBytes: 0,
    coverage: 'out_of_range', reason: 'raw_bytes', observedAt: new Date().toISOString(),
  };
  if (source.rawBytes! <= MAX_RAW_BYTES) {
    const segmented = segmentForFts(raw);
    source.segmentedBytes = utf8Bytes(segmented);
    source.reason = 'segmented_bytes';
    if (source.segmentedBytes <= MAX_SEGMENTED_BYTES) {
      source.raw = raw; source.segmented = segmented; source.coverage = 'full'; source.reason = '';
      source.rowBytes = sourceRowBytes(source);
      if (source.rowBytes > MAX_ROW_BYTES) {
        source.raw = null; source.segmented = null; source.coverage = 'out_of_range'; source.reason = 'row_bytes';
      }
    }
  }
  source.rowBytes = sourceRowBytes(source);
  return source;
}

export interface PrefixSnapshot {
  vector_id: string; repo: string; type: SparseSource['type']; doc_path: string;
  source_version: string; content: string; updated_at: string; indexed_at: string;
  source_revision?: number;
}

export function prefixSnapshotGuard(prefix: PrefixSnapshot): { sql: string; params: (string | number)[] } {
  return {
    sql: `vector_id=? AND repo=? AND type=? AND doc_path=? AND source_version=?
      AND content=? AND updated_at=? AND indexed_at=?${prefix.source_revision === undefined ? '' : ' AND source_revision=?'}`,
    params: [prefix.vector_id, prefix.repo, prefix.type, prefix.doc_path, prefix.source_version,
      prefix.content, prefix.updated_at, prefix.indexed_at, ...(prefix.source_revision === undefined ? [] : [prefix.source_revision])],
  };
}

/** INSERT SELECT is the CAS: a deleted/changed canonical owner cannot accept this snapshot. */
export function sparseSourceStatement(db: D1Database, source: SparseSource, prefix: PrefixSnapshot, requirePriorUpdate = false): D1PreparedStatement {
  if (sourceRowBytes(source) > MAX_ROW_BYTES) throw new Error('Sparse owner metadata exceeds row budget');
  const guard = prefixSnapshotGuard(prefix);
  return db.prepare(`INSERT INTO doc_sparse_sources (
    vector_id, source_type, source_version, prefix_indexed_at, index_version, prefix_revision,
    source_hash, body_hash, raw_hash, raw, segmented, raw_bytes, segmented_bytes,
    row_bytes, coverage, reason, observed_at)
    SELECT ?,?,?,?,?,source_revision,?,?,?,?,?,?,?,?,?,?,? FROM search_docs
    WHERE ${guard.sql}${requirePriorUpdate ? ' AND changes()=1' : ''}
    ON CONFLICT(vector_id) DO UPDATE SET
      source_type=excluded.source_type, source_version=excluded.source_version,
      prefix_indexed_at=excluded.prefix_indexed_at, index_version=excluded.index_version,
      prefix_revision=excluded.prefix_revision,
      source_hash=excluded.source_hash, body_hash=excluded.body_hash, raw_hash=excluded.raw_hash,
      raw=excluded.raw, segmented=excluded.segmented, raw_bytes=excluded.raw_bytes,
      segmented_bytes=excluded.segmented_bytes, row_bytes=excluded.row_bytes,
      coverage=excluded.coverage, reason=excluded.reason, observed_at=excluded.observed_at
    RETURNING vector_id`).bind(
      source.vectorId, source.type, source.sourceVersion, source.prefixIndexedAt, source.indexVersion,
      source.sourceHash, source.bodyHash, source.rawHash, source.raw, source.segmented,
      source.rawBytes, source.segmentedBytes, source.rowBytes, source.coverage, source.reason, source.observedAt,
      ...guard.params,
    );
}
