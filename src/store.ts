/**
 * IssueStore — Durable Object with SQLite-backed issue/PR state store.
 *
 * Provides structured metadata lookup and polling watermark management.
 * Body text is NOT stored (only body_hash for embedding change detection).
 */

import type { Env, IssueRecord, PollWatermark } from "./types.js";

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

/** Row shape returned by SQLite for the watermarks table */
type WatermarkRow = {
  [key: string]: SqlStorageValue;
  repo: string;
  last_polled_at: string;
};

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
        last_polled_at TEXT NOT NULL
      );
    `);

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
    };
  }

  setWatermark(repo: string, lastPolledAt: string): void {
    this.sql.exec(
      `INSERT INTO watermarks (repo, last_polled_at)
       VALUES (?, ?)
       ON CONFLICT (repo) DO UPDATE SET last_polled_at = excluded.last_polled_at`,
      repo,
      lastPolledAt,
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

      // GET /watermark?repo=... — get poll watermark
      if (request.method === "GET" && path === "/watermark") {
        const repo = url.searchParams.get("repo");
        if (!repo) return new Response("missing repo", { status: 400 });
        const wm = this.getWatermark(repo);
        if (!wm) return new Response("not found", { status: 404 });
        return Response.json(wm);
      }

      // POST /watermark — set poll watermark { repo, lastPolledAt }
      if (request.method === "POST" && path === "/watermark") {
        const { repo, lastPolledAt } = (await request.json()) as PollWatermark;
        this.setWatermark(repo, lastPolledAt);
        return new Response("ok", { status: 200 });
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(message, { status: 500 });
    }
  }
}
