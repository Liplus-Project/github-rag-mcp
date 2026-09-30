import { issueCommentVectorId, prReviewVectorId, prReviewCommentVectorId } from './pipeline/vector-id.js';
export async function backfillSourceIdentities(db: D1Database, store: { fetch(request: Request): Promise<Response> }, opts: { repo: string; cursor?: string; limit?: number }) {
  const limit = opts.limit ?? 50;
  if (!opts.repo || opts.repo.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (opts.cursor && !/^(issue_comment|pr_review|pr_review_comment):[0-9]+$/.test(opts.cursor))) throw new Error('Invalid identity backfill options');
  const url = new URL('http://store/source-identities'); url.searchParams.set('repo', opts.repo); url.searchParams.set('limit', String(limit)); if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
  const res = await store.fetch(new Request(url)); if (!res.ok) throw new Error('Identity page unavailable');
  const page = await res.json() as { rows: { repo: string; type: string; event_id: number }[]; next_cursor: string | null; done: boolean };
  const statements: D1PreparedStatement[] = [];
  for (const r of page.rows) {
    const id = r.type === 'issue_comment' ? await issueCommentVectorId(r.repo, r.event_id) : r.type === 'pr_review' ? await prReviewVectorId(r.repo, r.event_id) : await prReviewCommentVectorId(r.repo, r.event_id);
    const column = r.type === 'pr_review' ? 'review_id' : 'comment_id';
    statements.push(db.prepare(`UPDATE search_docs SET ${column}=? WHERE vector_id=? AND repo=? AND type=? AND ${column}<>? RETURNING vector_id`).bind(r.event_id, id, r.repo, r.type, r.event_id));
  }
  const result = statements.length ? await db.batch(statements) : [];
  return { scanned: page.rows.length, updated: result.reduce((n,r) => n + (r.results?.length ?? 0), 0), next_cursor: page.next_cursor, done: page.done };
}
