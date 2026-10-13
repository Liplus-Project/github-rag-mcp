import { describe, it, expect, vi, afterEach } from 'vitest';
import { prepareSparseSource, gitBlobSha, MAX_RAW_BYTES, MAX_SEGMENTED_BYTES, MAX_ROW_BYTES, sourceRowBytes, docSparseEnabled } from './doc-sparse.js';
import { sha256Hex } from './pipeline/hash.js';
import { segmentForFts } from './segment.js';
import * as segment from './segment.js';
import type { Env } from './types.js';
afterEach(() => vi.restoreAllMocks());

describe('full sparse ownership byte/version contract', () => {
  it('preserves exact raw/hash/segmentation for Japanese and CRLF text', async () => {
    const body = '判断構造\r\n\r\n後半の目印 😀';
    const version = await gitBlobSha(body);
    const source = await prepareSparseSource('doc-id', 'doc', 'docs/a.md', body, version);
    expect(source.raw).toBe(`docs/a.md\n\n${body}`);
    expect(source.rawHash).toBe(await sha256Hex(source.raw!));
    expect(source.bodyHash).toBe(await sha256Hex(body));
    expect(source.sourceHash).toBe(version);
    expect(source.segmented).toBe(segmentForFts(source.raw!));
    expect(source.rowBytes).toBe(sourceRowBytes(source));
    await expect(prepareSparseSource('id', 'doc', 'a', body, '0'.repeat(40))).rejects.toThrow('version');
  });

  it('allows the exact UTF8 raw boundary and processes the next byte as out of range', async () => {
    const body = 'x'.repeat(MAX_RAW_BYTES - 3);
    const allowed = await prepareSparseSource('a', 'wiki_doc', 'p', body, await sha256Hex(body));
    const tooLarge = await prepareSparseSource('b', 'wiki_doc', 'p', body + 'x', await sha256Hex(body + 'x'));
    expect(allowed.coverage).toBe('full'); expect(allowed.rawBytes).toBe(MAX_RAW_BYTES);
    expect(tooLarge.coverage).toBe('out_of_range'); expect(tooLarge.reason).toBe('raw_bytes');
    expect(tooLarge.raw).toBeNull(); expect(tooLarge.segmented).toBeNull();
    expect(tooLarge.bodyHash).toBe(await sha256Hex(body + 'x'));
    expect(tooLarge.segmentedBytes).toBeNull();
  });

  it('counts UTF8 rather than UTF16 and enables only explicitly', async () => {
    const body = '界'.repeat(Math.ceil(MAX_RAW_BYTES / 3));
    const source = await prepareSparseSource('x', 'wiki_doc', 'p', body, await sha256Hex(body));
    expect(source.coverage).toBe('out_of_range'); expect(body.length).toBeLessThan(MAX_RAW_BYTES);
    expect(docSparseEnabled({} as Env)).toBe(false);
    expect(docSparseEnabled({ DOC_SPARSE_CONTEXT_ENABLED: 'TRUE' } as Env)).toBe(false);
    expect(docSparseEnabled({ DOC_SPARSE_CONTEXT_ENABLED: 'true' } as Env)).toBe(true);
  });

  it('enforces the segmented boundary if a segmenter emits expanded text', async () => {
    const spy = vi.spyOn(segment, 'segmentForFts');
    spy.mockReturnValueOnce('s'.repeat(MAX_SEGMENTED_BYTES));
    const exact = await prepareSparseSource('x', 'wiki_doc', 'p', 'body', await sha256Hex('body'));
    expect(exact.coverage).toBe('full'); expect(exact.segmentedBytes).toBe(MAX_SEGMENTED_BYTES);
    spy.mockReturnValueOnce('s'.repeat(MAX_SEGMENTED_BYTES + 1));
    const over = await prepareSparseSource('x', 'wiki_doc', 'p', 'body', await sha256Hex('body'));
    expect(over.coverage).toBe('out_of_range'); expect(over.reason).toBe('segmented_bytes');
    expect(over.segmented).toBeNull();
  });

  it('checks the combined row boundary independently of raw/segmented limits', async () => {
    const body = 'body'.repeat(100);
    const hash = await sha256Hex(body);
    const base = await prepareSparseSource('x', 'wiki_doc', 'p', body, hash);
    const id = 'x'.repeat(MAX_ROW_BYTES - base.rowBytes + 1);
    const exact = await prepareSparseSource(id, 'wiki_doc', 'p', body, hash);
    expect(exact.rowBytes).toBe(MAX_ROW_BYTES); expect(exact.coverage).toBe('full');
    const over = await prepareSparseSource(id + 'x', 'wiki_doc', 'p', body, hash);
    expect(over.coverage).toBe('out_of_range'); expect(over.reason).toBe('row_bytes');
    expect(over.rowBytes).toBeLessThan(MAX_ROW_BYTES); expect(over.raw).toBeNull();
  });
});
