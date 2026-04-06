/**
 * IssueStore — Durable Object with SQLite-backed issue/PR state store.
 *
 * Provides structured metadata lookup and polling watermark management.
 * Body text is NOT stored (only body_hash for embedding change detection).
 */

import type { Env, IssueRecord, ReleaseRecord, DocRecord, PollWatermark } from "./types.js";

/** Row shape returned by SQLite for the issues table */
type IssueRow = {
  [key: string]: SqlStorageValue;
  repo: string;
  number: number;
  type: string;
  state: string;
  title: string;
  labels: string;
  milestone: string;
  assignees: string;
  body_hash: string;
  created_at: string;
  updated_at: string;
};

/** Row shape returned by SQLite for the releases table */
type ReleaseRow = {
  [key: string]: SqlStorageValue;
  repo: string;
  tag_name: string;
  name: string;
  body: string;
  prerelease: number;
  body_hash: string;
  created_at: string;
  published_at: string;
};

/** Row shape returned by SQLite for the docs table */
type DocRow = {
  [key: string]: SqlStorageValue;
  repo: string;
  path: string;
  blob_sha: string;
  updated_at: string;
};

/** Row shape returned by SQLite for the watermarks table */
type WatermarkRow = {
  [key: string]: SqlStorageValue;
  repo: string;
  last_polled_at: string;
  etag: string;
};

function rowToReleaseRecord(row: ReleaseRow): ReleaseRecord {
  return {
    repo: row.repo,
    tagName: row.tag_name,
    name: row.name,
    body: row.body,
    prerelease: row.prerelease === 1,
    bodyHash: row.body_hash,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

function rowToIssueRecord(row: IssueRow): IssueRecord {
  return {
    repo: row.repo,
    number: row.number,
    type: row.type as IssueRecord["type"],
    state: row.state as IssueRecord["state"],
    title: row.title,
    labels: row.labels ? row.labels.split(",") : [],
    milestone: row.milestone,
    assignees: row.assignees ? row.assignees.split(",") : [],
    bodyHash: row.body_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDocRecord(row: DocRow): DocRecord {
  return {
    repo: row.repo,
    path: row.path,
    blobSha: row.blob_sha,
    updatedAt: row.updated_at,
  };
}

export class IssueStore implements DurableObject {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, _env: Env) {
    this.sql = state.storage.sql;
    this.initSchema();
  }

  /**
   * Create tables if they don't exist.
   * DDL is idempotent — safe to run on every construction.
   */
  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        repo       TEXT    NOT NULL,
        number     INTEGER NOT NULL,
        type       TEXT    NOT NULL CHECK (type IN ('issue', 'pull_request')),
        state      TEXT    NOT NULL CHECK (state IN ('open', 'closed')),
        title      TEXT    NOT NULL,
        labels     TEXT    NOT NULL DEFAULT '',
        milestone  TEXT    NOT NULL DEFAULT '',
        assignees  TEXT    NOT NULL DEFAULT '',
        body_hash  TEXT    NOT NULL DEFAULT '',
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL,
        PRIMARY KEY (repo, number)
      );
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS watermarks (
        repo           TEXT NOT NULL PRIMARY KEY,
        last_polled_at TEXT NOT NULL,
        etag           TEXT NOT NULL DEFAULT ''
      );
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        repo         TEXT    NOT NULL,
        tag_name     TEXT    NOT NULL,
        name         TEXT    NOT NULL DEFAULT '',
        body         TEXT    NOT NULL DEFAULT '',
        prerelease   INTEGER NOT NULL DEFAULT 0,
        body_hash    TEXT    NOT NULL DEFAULT '',
        created_at   TEXT    NOT NULL,
        published_at TEXT    NOT NULL,
        PRIMARY KEY (repo, tag_name)
      );
    `);

    // Index for recent release queries
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_releases_published
        ON releases (published_at DESC);
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_releases_repo
        ON releases (repo, published_at DESC);
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        repo       TEXT NOT NULL,
        path       TEXT NOT NULL,
        blob_sha   TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo, path)
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_docs_repo
        ON docs (repo, updated_at DESC);
    `);

    // Migration: add etag column if missing (existing deployments)
    try {
      this.sql.exec(`ALTER TABLE watermarks ADD COLUMN etag TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists — ignore
    }

    // Index for recent-activity queries (updated_at descending scan)
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_issues_updated
        ON issues (updated_at DESC);
    `);

    // Index for repo-scoped listing
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_issues_repo
        ON issues (repo, updated_at DESC);
    `);
  }

  // ---- Issue CRUD ----

  upsertIssue(record: IssueRecord): void {
    this.sql.exec(
      `INSERT INTO issues (repo, number, type, state, title, labels, milestone, assignees, body_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, number) DO UPDATE SET
         type       = excluded.type,
         state      = excluded.state,
         title      = excluded.title,
         labels     = excluded.labels,
         milestone  = excluded.milestone,
         assignees  = excluded.assignees,
         body_hash  = excluded.body_hash,
         updated_at = excluded.updated_at`,
      record.repo,
      record.number,
      record.type,
      record.state,
      record.title,
      record.labels.join(","),
      record.milestone,
      record.assignees.join(","),
      record.bodyHash,
      record.createdAt,
      record.updatedAt,
    );
  }

  getIssue(repo: string, number: number): IssueRecord | null {
    const cursor = this.sql.exec<IssueRow>(
      `SELECT * FROM issues WHERE repo = ? AND number = ?`,
      repo,
      number,
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return rowToIssueRecord(rows[0]);
  }

  listIssuesByRepo(
    repo: string,
    opts?: { state?: "open" | "closed"; limit?: number; offset?: number },
  ): IssueRecord[] {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;

    let query: string;
    let params: (string | number)[];

    if (opts?.state) {
      query = `SELECT * FROM issues WHERE repo = ? AND state = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
      params = [repo, opts.state, limit, offset];
    } else {
      query = `SELECT * FROM issues WHERE repo = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
      params = [repo, limit, offset];
    }

    const cursor = this.sql.exec<IssueRow>(query, ...params);
    return [...cursor].map(rowToIssueRecord);
  }

  getRecentActivity(
    opts?: { since?: string; limit?: number; repo?: string },
  ): IssueRecord[] {
    const limit = opts?.limit ?? 20;
    const since = opts?.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    let query: string;
    let params: (string | number)[];

    if (opts?.repo) {
      query = `SELECT * FROM issues WHERE repo = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;
      params = [opts.repo, since, limit];
    } else {
      query = `SELECT * FROM issues WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;
      params = [since, limit];
    }

    const cursor = this.sql.exec<IssueRow>(query, ...params);
    return [...cursor].map(rowToIssueRecord);
  }

  // ---- Release CRUD ----

  upsertRelease(record: ReleaseRecord): void {
    this.sql.exec(
      `INSERT INTO releases (repo, tag_name, name, body, prerelease, body_hash, created_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, tag_name) DO UPDATE SET
         name         = excluded.name,
         body         = excluded.body,
         prerelease   = excluded.prerelease,
         body_hash    = excluded.body_hash,
         published_at = excluded.published_at`,
      record.repo,
      record.tagName,
      record.name,
      record.body,
      record.prerelease ? 1 : 0,
      record.bodyHash,
      record.createdAt,
      record.publishedAt,
    );
  }

  getRelease(repo: string, tagName: string): ReleaseRecord | null {
    const cursor = this.sql.exec<ReleaseRow>(
      `SELECT * FROM releases WHERE repo = ? AND tag_name = ?`,
      repo,
      tagName,
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return rowToReleaseRecord(rows[0]);
  }

  listReleasesByRepo(
    repo: string,
    opts?: { limit?: number },
  ): ReleaseRecord[] {
    const limit = opts?.limit ?? 50;
    const cursor = this.sql.exec<ReleaseRow>(
      `SELECT * FROM releases WHERE repo = ? ORDER BY published_at DESC LIMIT ?`,
      repo,
      limit,
    );
    return [...cursor].map(rowToReleaseRecord);
  }

  getRecentReleases(
    opts?: { since?: string; limit?: number; repo?: string },
  ): ReleaseRecord[] {
    const limit = opts?.limit ?? 20;
    const since = opts?.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    let query: string;
    let params: (string | number)[];

    if (opts?.repo) {
      query = `SELECT * FROM releases WHERE repo = ? AND published_at >= ? ORDER BY published_at DESC LIMIT ?`;
      params = [opts.repo, since, limit];
    } else {
      query = `SELECT * FROM releases WHERE published_at >= ? ORDER BY published_at DESC LIMIT ?`;
      params = [since, limit];
    }

    const cursor = this.sql.exec<ReleaseRow>(query, ...params);
    return [...cursor].map(rowToReleaseRecord);
  }

  /**
   * Find releases published after a given timestamp (e.g., issue close time).
   * Used by get_issue_context to find which release an issue was included in.
   */
  getReleasesAfter(repo: string, afterTimestamp: string, limit = 5): ReleaseRecord[] {
    const cursor = this.sql.exec<ReleaseRow>(
      `SELECT * FROM releases WHERE repo = ? AND published_at >= ? ORDER BY published_at ASC LIMIT ?`,
      repo,
      afterTimestamp,
      limit,
    );
    return [...cursor].map(rowToReleaseRecord);
  }

  // ---- Doc CRUD ----

  upsertDoc(record: DocRecord): void {
    this.sql.exec(
      `INSERT INTO docs (repo, path, blob_sha, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (repo, path) DO UPDATE SET
         blob_sha   = excluded.blob_sha,
         updated_at = excluded.updated_at`,
      record.repo,
      record.path,
      record.blobSha,
      record.updatedAt,
    );
  }

  getDoc(repo: string, path: string): DocRecord | null {
    const cursor = this.sql.exec<DocRow>(
      `SELECT * FROM docs WHERE repo = ? AND path = ?`,
      repo,
      path,
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return rowToDocRecord(rows[0]);
  }

  listDocsByRepo(repo: string): DocRecord[] {
    const cursor = this.sql.exec<DocRow>(
      `SELECT * FROM docs WHERE repo = ? ORDER BY path ASC`,
      repo,
    );
    return [...cursor].map(rowToDocRecord);
  }

  getRecentDocs(
    opts?: { since?: string; limit?: number; repo?: string },
  ): DocRecord[] {
    const limit = opts?.limit ?? 20;
    const since = opts?.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    let query: string;
    let params: (string | number)[];

    if (opts?.repo) {
      query = `SELECT * FROM docs WHERE repo = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;
      params = [opts.repo, since, limit];
    } else {
      query = `SELECT * FROM docs WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;
      params = [since, limit];
    }

    const cursor = this.sql.exec<DocRow>(query, ...params);
    return [...cursor].map(rowToDocRecord);
  }

  /**
   * Delete a doc record (e.g., when a file is removed from the repo).
   */
  deleteDoc(repo: string, path: string): void {
    this.sql.exec(
      `DELETE FROM docs WHERE repo = ? AND path = ?`,
      repo,
      path,
    );
  }

  // ---- Hash reset for re-sync ----

  /**
   * Reset all bodyHashes for a given repo so that the next poll
   * will regenerate embeddings for every issue.
   * Returns the number of rows affected.
   */
  resetBodyHashes(repo: string): number {
    const cursor = this.sql.exec(
      `UPDATE issues SET body_hash = '' WHERE repo = ? AND body_hash != ''`,
      repo,
    );
    return cursor.rowsWritten;
  }

  // ---- Watermark management ----

  getWatermark(repo: string): PollWatermark | null {
    const cursor = this.sql.exec<WatermarkRow>(
      `SELECT * FROM watermarks WHERE repo = ?`,
      repo,
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return {
      repo: rows[0].repo,
      lastPolledAt: rows[0].last_polled_at,
      etag: rows[0].etag || undefined,
    };
  }

  setWatermark(repo: string, lastPolledAt: string, etag?: string): void {
    this.sql.exec(
      `INSERT INTO watermarks (repo, last_polled_at, etag)
       VALUES (?, ?, ?)
       ON CONFLICT (repo) DO UPDATE SET
         last_polled_at = excluded.last_polled_at,
         etag = excluded.etag`,
      repo,
      lastPolledAt,
      etag ?? "",
    );
  }

  // ---- HTTP interface ----

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /upsert — upsert a single issue record
      if (request.method === "POST" && path === "/upsert") {
        const record = (await request.json()) as IssueRecord;
        this.upsertIssue(record);
        return new Response("ok", { status: 200 });
      }

      // GET /issue?repo=...&number=... — get a single issue
      if (request.method === "GET" && path === "/issue") {
        const repo = url.searchParams.get("repo");
        const num = url.searchParams.get("number");
        if (!repo || !num) {
          return new Response("missing repo or number", { status: 400 });
        }
        const issue = this.getIssue(repo, parseInt(num, 10));
        if (!issue) return new Response("not found", { status: 404 });
        return Response.json(issue);
      }

      // GET /issues?repo=...&state=...&limit=...&offset=... — list issues by repo
      if (request.method === "GET" && path === "/issues") {
        const repo = url.searchParams.get("repo");
        if (!repo) return new Response("missing repo", { status: 400 });
        const state = url.searchParams.get("state") as "open" | "closed" | null;
        const limit = url.searchParams.get("limit");
        const offset = url.searchParams.get("offset");
        const issues = this.listIssuesByRepo(repo, {
          state: state ?? undefined,
          limit: limit ? parseInt(limit, 10) : undefined,
          offset: offset ? parseInt(offset, 10) : undefined,
        });
        return Response.json(issues);
      }

      // GET /recent?since=...&limit=...&repo=... — recent activity
      if (request.method === "GET" && path === "/recent") {
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        const repo = url.searchParams.get("repo") ?? undefined;
        const items = this.getRecentActivity({
          since,
          limit: limit ? parseInt(limit, 10) : undefined,
          repo,
        });
        return Response.json(items);
      }

      // POST /upsert-release — upsert a single release record
      if (request.method === "POST" && path === "/upsert-release") {
        const record = (await request.json()) as ReleaseRecord;
        this.upsertRelease(record);
        return new Response("ok", { status: 200 });
      }

      // GET /release?repo=...&tag_name=... — get a single release
      if (request.method === "GET" && path === "/release") {
        const repo = url.searchParams.get("repo");
        const tagName = url.searchParams.get("tag_name");
        if (!repo || !tagName) {
          return new Response("missing repo or tag_name", { status: 400 });
        }
        const release = this.getRelease(repo, tagName);
        if (!release) return new Response("not found", { status: 404 });
        return Response.json(release);
      }

      // GET /releases?repo=...&limit=... — list releases by repo
      if (request.method === "GET" && path === "/releases") {
        const repo = url.searchParams.get("repo");
        if (!repo) return new Response("missing repo", { status: 400 });
        const limit = url.searchParams.get("limit");
        const releases = this.listReleasesByRepo(repo, {
          limit: limit ? parseInt(limit, 10) : undefined,
        });
        return Response.json(releases);
      }

      // GET /releases-after?repo=...&after=...&limit=... — releases published after timestamp
      if (request.method === "GET" && path === "/releases-after") {
        const repo = url.searchParams.get("repo");
        const after = url.searchParams.get("after");
        if (!repo || !after) {
          return new Response("missing repo or after", { status: 400 });
        }
        const limit = url.searchParams.get("limit");
        const releases = this.getReleasesAfter(
          repo,
          after,
          limit ? parseInt(limit, 10) : undefined,
        );
        return Response.json(releases);
      }

      // GET /recent-releases?since=...&limit=...&repo=... — recent release activity
      if (request.method === "GET" && path === "/recent-releases") {
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        const repo = url.searchParams.get("repo") ?? undefined;
        const items = this.getRecentReleases({
          since,
          limit: limit ? parseInt(limit, 10) : undefined,
          repo,
        });
        return Response.json(items);
      }

      // POST /reset-hashes?repo=... — reset all bodyHashes for a repo to force re-embedding
      if (request.method === "POST" && path === "/reset-hashes") {
        const repo = url.searchParams.get("repo");
        if (!repo) return new Response("missing repo", { status: 400 });
        const count = this.resetBodyHashes(repo);
        return Response.json({ repo, reset: count });
      }

      // GET /watermark?repo=... — get poll watermark
      if (request.method === "GET" && path === "/watermark") {
        const repo = url.searchParams.get("repo");
        if (!repo) return new Response("missing repo", { status: 400 });
        const wm = this.getWatermark(repo);
        if (!wm) return new Response("not found", { status: 404 });
        return Response.json(wm);
      }

      // POST /watermark — set poll watermark { repo, lastPolledAt, etag? }
      if (request.method === "POST" && path === "/watermark") {
        const { repo, lastPolledAt, etag } = (await request.json()) as PollWatermark;
        this.setWatermark(repo, lastPolledAt, etag);
        return new Response("ok", { status: 200 });
      }

      // POST /upsert-doc — upsert a single doc record
      if (request.method === "POST" && path === "/upsert-doc") {
        const record = (await request.json()) as DocRecord;
        this.upsertDoc(record);
        return new Response("ok", { status: 200 });
      }

      // GET /doc?repo=...&path=... — get a single doc record
      if (request.method === "GET" && path === "/doc") {
        const repo = url.searchParams.get("repo");
        const docPath = url.searchParams.get("path");
        if (!repo || !docPath) {
          return new Response("missing repo or path", { status: 400 });
        }
        const doc = this.getDoc(repo, docPath);
        if (!doc) return new Response("not found", { status: 404 });
        return Response.json(doc);
      }

      // GET /docs?repo=... — list docs by repo
      if (request.method === "GET" && path === "/docs") {
        const repo = url.searchParams.get("repo");
        if (!repo) return new Response("missing repo", { status: 400 });
        const docs = this.listDocsByRepo(repo);
        return Response.json(docs);
      }

      // GET /recent-docs?since=...&limit=...&repo=... — recent doc activity
      if (request.method === "GET" && path === "/recent-docs") {
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        const repo = url.searchParams.get("repo") ?? undefined;
        const items = this.getRecentDocs({
          since,
          limit: limit ? parseInt(limit, 10) : undefined,
          repo,
        });
        return Response.json(items);
      }

      // DELETE /doc?repo=...&path=... — delete a doc record
      if (request.method === "DELETE" && path === "/doc") {
        const repo = url.searchParams.get("repo");
        const docPath = url.searchParams.get("path");
        if (!repo || !docPath) {
          return new Response("missing repo or path", { status: 400 });
        }
        this.deleteDoc(repo, docPath);
        return new Response("ok", { status: 200 });
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(message, { status: 500 });
    }
  }
}
