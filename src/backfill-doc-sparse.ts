import type { Env, DocRecord, WikiDocRecord } from './types.js';
import { prepareEmbeddingInput, sha256Hex } from './pipeline/hash.js';
import {
  DOC_SPARSE_INDEX_VERSION, gitBlobSha, prepareSparseSource,
  sparseSourceStatement, utf8Bytes, type PrefixSnapshot,
  prefixSnapshotGuard,
} from './doc-sparse.js';

export const MAX_BACKFILL_BYTES = 1024 * 1024;
export async function handleDocSparseAdmin(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_TOKEN?.trim()
    || request.headers.get('GITHUB_TOKEN') !== env.GITHUB_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const opts: SparseBackfillOptions = {
    repo: url.searchParams.get('repo') ?? '', type: url.searchParams.get('type') as SparseBackfillOptions['type'],
    cursor: Number(url.searchParams.get('cursor') ?? 0), limit: Number(url.searchParams.get('limit') ?? 5),
    maxBytes: Number(url.searchParams.get('max_bytes') ?? MAX_BACKFILL_BYTES),
    apply: url.searchParams.get('apply') === 'true', force: url.searchParams.get('force') === 'true',
  };
  if (['apply', 'force'].some(key => url.searchParams.has(key) && !['true', 'false'].includes(url.searchParams.get(key)!))) {
    return Response.json({ error: 'Boolean options must be true or false' }, { status: 400 });
  }
  try {
    return Response.json(url.pathname.endsWith('stats') ? await docSparseStats(env.DB_FTS, opts) : await backfillDocSparse(env, opts));
  } catch {
    return Response.json({ error: 'Sparse operation failed; check options and migration 0009; cursor unchanged' }, { status: 400 });
  }
}

export interface SparseBackfillOptions {
  repo: string; type: 'doc' | 'wiki_doc'; limit?: number; cursor?: number;
  maxBytes?: number; apply?: boolean; force?: boolean;
}
function validate(opts: SparseBackfillOptions): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo) || !['doc', 'wiki_doc'].includes(opts.type)
    || !Number.isSafeInteger(opts.limit ?? 5) || (opts.limit ?? 5) < 1 || (opts.limit ?? 5) > 10
    || !Number.isSafeInteger(opts.cursor ?? 0) || (opts.cursor ?? 0) < 0
    || !Number.isSafeInteger(opts.maxBytes ?? MAX_BACKFILL_BYTES)
    || (opts.maxBytes ?? MAX_BACKFILL_BYTES) < 1 || (opts.maxBytes ?? MAX_BACKFILL_BYTES) > MAX_BACKFILL_BYTES) {
    throw new Error('Invalid sparse backfill options');
  }
}

class SourceLimitError extends Error {}
class MissingSourceError extends Error {}
class SourceVersionError extends Error {}

/** Bound network acquisition before parsing JSON or decoding the source. */
async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) throw new MissingSourceError('Source missing');
    throw new Error(`Source HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('Source has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new SourceLimitError('Source acquisition byte limit'); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

export async function fetchDocBlob(repo: string, sha: string, token: string, maxBytes?: number): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new SourceVersionError('Not a Git blob SHA');
  const response = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${sha}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'github-rag-mcp/0.1.0', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  // Ordinary ingest retains its existing full source acquisition; only operator runs
  // use the byte cap. The source owner applies its raw/segmented/row budgets after hashing.
  const data = JSON.parse(await readBounded(response, maxBytes === undefined
    ? Number.MAX_SAFE_INTEGER : Math.ceil(maxBytes * 1.4) + 4096)) as {
      sha: string; content: string; encoding: string;
    };
  if (data.sha !== sha) throw new SourceVersionError('Blob response version mismatch');
  if (data.encoding !== 'base64') throw new Error('Blob encoding mismatch');
  const binary = atob(data.content.replace(/\s/g, ''));
  if (maxBytes !== undefined && binary.length > maxBytes) throw new SourceLimitError('Decoded source byte limit');
  const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
  if (await gitBlobSha(body) !== sha) throw new SourceVersionError('Blob body version mismatch');
  return body;
}

type SnapshotRow = PrefixSnapshot & { rid: number; source_revision: number; prepared_version: string | null; prepared_index: string | null; prepared_at: string | null; prepared_revision: number | null };
type StoreRecord = DocRecord | WikiDocRecord;
async function readStore(store: DurableObjectStub, prefix: PrefixSnapshot): Promise<StoreRecord | null> {
  const path = prefix.type === 'doc' ? 'doc' : 'wiki-doc';
  const key = prefix.type === 'doc' ? 'path' : 'page';
  const response = await store.fetch(new Request(`http://store/${path}?repo=${encodeURIComponent(prefix.repo)}&${key}=${encodeURIComponent(prefix.doc_path)}`));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Source store unavailable');
  return await response.json() as StoreRecord;
}
const versionOf = (record: StoreRecord): string => 'blobSha' in record ? record.blobSha : record.contentHash;

export async function backfillDocSparse(env: Env, opts: SparseBackfillOptions) {
  validate(opts);
  const limit = opts.limit ?? 5; const cursor = opts.cursor ?? 0;
  const maxBytes = opts.maxBytes ?? MAX_BACKFILL_BYTES;
  const store = env.ISSUE_STORE.get(env.ISSUE_STORE.idFromName('global'));
  const rows = (await env.DB_FTS.prepare(`SELECT d.rowid AS rid, d.vector_id, d.repo, d.type,
    d.doc_path, d.source_version, d.source_revision, d.content, d.updated_at, d.indexed_at,
    s.source_version AS prepared_version, s.index_version AS prepared_index, s.prefix_indexed_at AS prepared_at,
    s.prefix_revision AS prepared_revision
    FROM search_docs d LEFT JOIN doc_sparse_sources s ON s.vector_id=d.vector_id
    WHERE d.repo=? AND d.type=? AND d.rowid>? ORDER BY d.rowid LIMIT ?`)
    .bind(opts.repo, opts.type, cursor, limit).all<SnapshotRow>()).results ?? [];
  const results: { vector_id: string; source_version: string | null; status: string; reason?: string;
    coverage?: string; raw_bytes?: number | null; segmented_bytes?: number | null; row_bytes?: number;
    prefix_version_repair?: boolean; prefix_source_version?: string }[] = [];
  let bytes = 0; let nextCursor = cursor; let stopped = false; let budgetExhausted = false;
  for (const prefix of rows) {
    let version: string | null = null;
    try {
      const record = await readStore(store, prefix);
      if (!record) {
        results.push({ vector_id: prefix.vector_id, source_version: null, status: 'missing', reason: 'store_missing' });
        nextCursor = prefix.rid; continue;
      }
      version = versionOf(record);
      if (record.updatedAt !== prefix.updated_at) {
        results.push({ vector_id: prefix.vector_id, source_version: version, status: 'conflict', reason: 'store_prefix_version' });
        nextCursor = prefix.rid; continue;
      }
      if (!opts.force && prefix.source_version === version && prefix.prepared_version === version && prefix.prepared_index === DOC_SPARSE_INDEX_VERSION
        && prefix.prepared_at === prefix.indexed_at && prefix.prepared_revision === prefix.source_revision) {
        results.push({ vector_id: prefix.vector_id, source_version: version, status: 'unchanged' });
        nextCursor = prefix.rid; continue;
      }
      const remaining = maxBytes - bytes;
      if (remaining < 1) { stopped = true; budgetExhausted = true; break; }
      let body: string;
      try {
        body = prefix.type === 'doc' ? await fetchDocBlob(opts.repo, version, env.GITHUB_TOKEN, remaining)
          : await readBounded(await fetch(`https://raw.githubusercontent.com/wiki/${opts.repo}/${encodeURIComponent(prefix.doc_path)}.${(record as WikiDocRecord).extension}`, {
            headers: { 'User-Agent': 'github-rag-mcp/0.1.0' },
          }), remaining);
      } catch (error) {
        if (error instanceof SourceLimitError) {
          // An unfetched body has no verified hash. Do not invent a processed snapshot.
          const deferred = bytes > 0;
          results.push({ vector_id: prefix.vector_id, source_version: version,
            status: deferred ? 'retryable_error' : 'conflict',
            reason: deferred ? 'byte_budget_deferred' : 'source_byte_limit_unverified' });
          // The failed acquisition spent the remaining envelope, even though no
          // decoded body was obtained. Stop rather than spending it again per row.
          budgetExhausted = true;
          if (!deferred) nextCursor = prefix.rid;
          stopped = true; break;
        }
        throw error;
      }
      bytes += utf8Bytes(body);
      const actualVersion = prefix.type === 'doc' ? await gitBlobSha(body) : await sha256Hex(body);
      if (actualVersion !== version || prepareEmbeddingInput(prefix.doc_path, body) !== prefix.content) {
        results.push({ vector_id: prefix.vector_id, source_version: version, status: 'conflict', reason: 'source_prefix_version' });
        nextCursor = prefix.rid; continue;
      }
      const source = await prepareSparseSource(prefix.vector_id, prefix.type, prefix.doc_path, body, version, prefix.indexed_at);
      // A DO version read cannot form a cross-database transaction. The D1 CAS below
      // protects against concurrent prefix update/delete; this read rejects store changes too.
      const current = await readStore(store, prefix);
      if (!current || versionOf(current) !== version || current.updatedAt !== record.updatedAt) {
        results.push({ vector_id: prefix.vector_id, source_version: version, status: 'conflict', reason: 'store_changed' });
        nextCursor = prefix.rid; continue;
      }
      if (opts.apply) {
        const guard = prefixSnapshotGuard(prefix);
        const reconcile = prefix.source_version !== version;
        const written = reconcile
          ? (await env.DB_FTS.batch([
            env.DB_FTS.prepare(`UPDATE search_docs SET source_version=? WHERE ${guard.sql} RETURNING vector_id`)
              .bind(version, ...guard.params),
            sparseSourceStatement(env.DB_FTS, source, { ...prefix, source_version: version, source_revision: prefix.source_revision + 1 }, true),
          ]))[1]
          : await sparseSourceStatement(env.DB_FTS, source, prefix).all();
        if (!written.results?.length) {
          results.push({ vector_id: prefix.vector_id, source_version: version, status: 'conflict', reason: 'prefix_changed' });
          nextCursor = prefix.rid; continue;
        }
      } else {
        const guard = prefixSnapshotGuard(prefix);
        if (!await env.DB_FTS.prepare(`SELECT vector_id FROM search_docs WHERE ${guard.sql}`).bind(...guard.params).first()) {
          results.push({ vector_id: prefix.vector_id, source_version: version, status: 'conflict', reason: 'prefix_changed' });
          nextCursor = prefix.rid; continue;
        }
      }
      results.push({ vector_id: prefix.vector_id, source_version: version,
        prefix_version_repair: prefix.source_version !== version, prefix_source_version: prefix.source_version,
        status: source.coverage === 'full' ? 'success' : 'out_of_range', reason: source.reason,
        coverage: source.coverage, raw_bytes: source.rawBytes, segmented_bytes: source.segmentedBytes, row_bytes: source.rowBytes });
      nextCursor = prefix.rid;
    } catch (error) {
      const missing = error instanceof MissingSourceError; const conflict = error instanceof SourceVersionError;
      results.push({ vector_id: prefix.vector_id, source_version: version, status: missing ? 'missing' : conflict ? 'conflict' : 'retryable_error',
        reason: missing ? 'source_missing' : conflict ? 'source_version_unverified' : 'source_or_write_failed' });
      if (missing || conflict) nextCursor = prefix.rid;
      else { stopped = true; break; }
    }
  }
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return { repo: opts.repo, type: opts.type, observed_at: new Date().toISOString(),
    index_version: DOC_SPARSE_INDEX_VERSION, mode: opts.apply ? 'apply' : 'plan',
    source_bytes: bytes, budget_exhausted: budgetExhausted, max_bytes: maxBytes, scanned: results.length, counts, results,
    next_cursor: !stopped && rows.length < limit ? null : nextCursor };
}

export async function docSparseStats(db: D1Database, opts: Pick<SparseBackfillOptions, 'repo' | 'type'>) {
  validate(opts);
  const rows = (await db.prepare(`SELECT
    CASE WHEN s.vector_id IS NULL THEN 'unprepared'
      WHEN (d.source_version<>'' AND d.source_version<>s.source_version) OR d.indexed_at<>s.prefix_indexed_at
        OR d.source_revision<>s.prefix_revision THEN 'version_mismatch'
      ELSE s.coverage END AS coverage, s.index_version,
    COUNT(*) AS count, SUM(COALESCE(s.raw_bytes,0)) AS raw_bytes,
    SUM(CASE WHEN s.vector_id IS NOT NULL AND d.source_version='' THEN 1 ELSE 0 END) AS legacy_version_unverified,
    SUM(COALESCE(s.segmented_bytes,0)) AS segmented_bytes, SUM(COALESCE(s.row_bytes,0)) AS row_bytes
    FROM search_docs d LEFT JOIN doc_sparse_sources s ON s.vector_id=d.vector_id
    WHERE d.repo=? AND d.type=? GROUP BY 1,2`)
    .bind(opts.repo, opts.type).all()).results ?? [];
  return { repo: opts.repo, type: opts.type, observed_at: new Date().toISOString(), population: 'indexed_prefix_owners',
    source_count: rows.reduce((n, row) => n + Number(row.count), 0), rows };
}
