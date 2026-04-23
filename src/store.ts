/**
 * IssueStore — Durable Object with SQLite-backed issue/PR state store.
 *
 * Provides structured metadata lookup and polling watermark management.
 * Body text is NOT stored (only body_hash for embedding change detection).
 */

import type {
  Env,
  IssueRecord,
  ReleaseRecord,
  DocRecord,
  DiffRecord,
  DiffFileStatus,
  IssueCommentRecord,
  PRReviewRecord,
  PRReviewCommentRecord,
  PollWatermark,
} from "./types.js";

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

/** Row shape returned by SQLite for the diffs table */
type DiffRow = {
  [key: string]: SqlStorageValue;
  repo: string;
  commit_sha: string;
  file_path: string;
  file_status: string;
  commit_date: string;
  commit_author: string;
  blob_sha_before: string;
  blob_sha_after: string;
  indexed_at: string;
};

/** Row shape returned by SQLite for the watermarks table */
type WatermarkRow = {
  [key: string]: SqlStorageValue;
  repo: string;
  last_polled_at: string;
  etag: string;
};

/** Row shape returned by SQLite for the issue_comments table */
type IssueCommentRow = {
  [key: string]: SqlStorageValue;
  repo: string;
  comment_id: number;
  number: number;
  author: string;
  body_hash: string;
  created_at: string;
  updated_at: string;
};

/** Row shape returned by SQLite for the pr_reviews table */
type PRReviewRow = {
  [key: string]: SqlStorageValue;
  repo: string;
  review_id: number;
  number: number;
  author: string;
  state: string;
  body_hash: string;
  submitted_at: string;
  updated_at: string;
};

/** Row shape returned by SQLite for the pr_review_comments table */
type PRReviewCommentRow = {
  [key: string]: SqlStorageValue;
  repo: string;
  comment_id: number;
  number: number;
  author: string;
  file_path: string;
  line: number;
  commit_id: string;
  body_hash: string;
  created_at: string;
  updated_at: string;
};

function rowToIssueCommentRecord(row: IssueCommentRow): IssueCommentRecord {
  return {
    repo: row.repo,
    commentId: row.comment_id,
    number: row.number,
    author: row.author,
    bodyHash: row.body_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPRReviewRecord(row: PRReviewRow): PRReviewRecord {
  return {
    repo: row.repo,
    reviewId: row.review_id,
    number: row.number,
    author: row.author,
    state: row.state,
    bodyHash: row.body_hash,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

function rowToPRReviewCommentRecord(row: PRReviewCommentRow): PRReviewCommentRecord {
  return {
    repo: row.repo,
    commentId: row.comment_id,
    number: row.number,
    author: row.author,
    filePath: row.file_path,
    line: row.line,
    commitId: row.commit_id,
    bodyHash: row.body_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

function rowToDiffRecord(row: DiffRow): DiffRecord {
  return {
    repo: row.repo,
    commitSha: row.commit_sha,
    filePath: row.file_path,
    fileStatus: row.file_status as DiffFileStatus,
    commitDate: row.commit_date,
    commitAuthor: row.commit_author,
    blobShaBefore: row.blob_sha_before === "" ? null : row.blob_sha_before,
    blobShaAfter: row.blob_sha_after === "" ? null : row.blob_sha_after,
    indexedAt: row.indexed_at,
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

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS diffs (
        repo            TEXT NOT NULL,
        commit_sha      TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        file_status     TEXT NOT NULL DEFAULT '',
        commit_date     TEXT NOT NULL,
        commit_author   TEXT NOT NULL DEFAULT '',
        blob_sha_before TEXT NOT NULL DEFAULT '',
        blob_sha_after  TEXT NOT NULL DEFAULT '',
        indexed_at      TEXT NOT NULL,
        PRIMARY KEY (repo, commit_sha, file_path)
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_diffs_repo_date
        ON diffs (repo, commit_date DESC);
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_diffs_commit
        ON diffs (repo, commit_sha);
    `);

    // Migration: add etag column if missing (existing deployments)
    try {
      this.sql.exec(`ALTER TABLE watermarks ADD COLUMN etag TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists — ignore
    }

    // Top-level comments on issues and PRs share the same number space, so we
    // key on (repo, comment_id) directly. `number` stores the parent issue/PR
    // number so we can filter by parent or reindex quickly.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS issue_comments (
        repo       TEXT    NOT NULL,
        comment_id INTEGER NOT NULL,
        number     INTEGER NOT NULL,
        author     TEXT    NOT NULL DEFAULT '',
        body_hash  TEXT    NOT NULL DEFAULT '',
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL,
        PRIMARY KEY (repo, comment_id)
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_issue_comments_parent
        ON issue_comments (repo, number, updated_at DESC);
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_issue_comments_recent
        ON issue_comments (updated_at DESC);
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pr_reviews (
        repo         TEXT    NOT NULL,
        review_id    INTEGER NOT NULL,
        number       INTEGER NOT NULL,
        author       TEXT    NOT NULL DEFAULT '',
        state        TEXT    NOT NULL DEFAULT '',
        body_hash    TEXT    NOT NULL DEFAULT '',
        submitted_at TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        PRIMARY KEY (repo, review_id)
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_pr_reviews_parent
        ON pr_reviews (repo, number, submitted_at DESC);
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_pr_reviews_recent
        ON pr_reviews (updated_at DESC);
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pr_review_comments (
        repo       TEXT    NOT NULL,
        comment_id INTEGER NOT NULL,
        number     INTEGER NOT NULL,
        author     TEXT    NOT NULL DEFAULT '',
        file_path  TEXT    NOT NULL DEFAULT '',
        line       INTEGER NOT NULL DEFAULT 0,
        commit_id  TEXT    NOT NULL DEFAULT '',
        body_hash  TEXT    NOT NULL DEFAULT '',
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL,
        PRIMARY KEY (repo, comment_id)
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_pr_review_comments_parent
        ON pr_review_comments (repo, number, updated_at DESC);
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_pr_review_comments_recent
        ON pr_review_comments (updated_at DESC);
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

  // ---- Diff CRUD ----

  upsertDiff(record: DiffRecord): void {
    this.sql.exec(
      `INSERT INTO diffs (repo, commit_sha, file_path, file_status, commit_date, commit_author, blob_sha_before, blob_sha_after, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, commit_sha, file_path) DO UPDATE SET
         file_status     = excluded.file_status,
         commit_date     = excluded.commit_date,
         commit_author   = excluded.commit_author,
         blob_sha_before = excluded.blob_sha_before,
         blob_sha_after  = excluded.blob_sha_after,
         indexed_at      = excluded.indexed_at`,
      record.repo,
      record.commitSha,
      record.filePath,
      record.fileStatus,
      record.commitDate,
      record.commitAuthor,
      record.blobShaBefore ?? "",
      record.blobShaAfter ?? "",
      record.indexedAt,
    );
  }

  getDiff(repo: string, commitSha: string, filePath: string): DiffRecord | null {
    const cursor = this.sql.exec<DiffRow>(
      `SELECT * FROM diffs WHERE repo = ? AND commit_sha = ? AND file_path = ?`,
      repo,
      commitSha,
      filePath,
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return rowToDiffRecord(rows[0]);
  }

  listDiffsByCommit(repo: string, commitSha: string): DiffRecord[] {
    const cursor = this.sql.exec<DiffRow>(
      `SELECT * FROM diffs WHERE repo = ? AND commit_sha = ? ORDER BY file_path ASC`,
      repo,
      commitSha,
    );
    return [...cursor].map(rowToDiffRecord);
  }

  getRecentDiffs(
    opts?: { since?: string; limit?: number; repo?: string },
  ): DiffRecord[] {
    const limit = opts?.limit ?? 20;
    const since = opts?.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    let query: string;
    let params: (string | number)[];

    if (opts?.repo) {
      query = `SELECT * FROM diffs WHERE repo = ? AND commit_date >= ? ORDER BY commit_date DESC LIMIT ?`;
      params = [opts.repo, since, limit];
    } else {
      query = `SELECT * FROM diffs WHERE commit_date >= ? ORDER BY commit_date DESC LIMIT ?`;
      params = [since, limit];
    }

    const cursor = this.sql.exec<DiffRow>(query, ...params);
    return [...cursor].map(rowToDiffRecord);
  }

  // ---- Issue comment CRUD ----

  upsertIssueComment(record: IssueCommentRecord): void {
    this.sql.exec(
      `INSERT INTO issue_comments (repo, comment_id, number, author, body_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, comment_id) DO UPDATE SET
         number     = excluded.number,
         author     = excluded.author,
         body_hash  = excluded.body_hash,
         updated_at = excluded.updated_at`,
      record.repo,
      record.commentId,
      record.number,
      record.author,
      record.bodyHash,
      record.createdAt,
      record.updatedAt,
    );
  }

  getIssueComment(repo: string, commentId: number): IssueCommentRecord | null {
    const cursor = this.sql.exec<IssueCommentRow>(
      `SELECT * FROM issue_comments WHERE repo = ? AND comment_id = ?`,
      repo,
      commentId,
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return rowToIssueCommentRecord(rows[0]);
  }

  deleteIssueComment(repo: string, commentId: number): void {
    this.sql.exec(
      `DELETE FROM issue_comments WHERE repo = ? AND comment_id = ?`,
      repo,
      commentId,
    );
  }

  getRecentIssueComments(
    opts?: { since?: string; limit?: number; repo?: string },
  ): IssueCommentRecord[] {
    const limit = opts?.limit ?? 20;
    const since = opts?.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    let query: string;
    let params: (string | number)[];

    if (opts?.repo) {
      query = `SELECT * FROM issue_comments WHERE repo = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;
      params = [opts.repo, since, limit];
    } else {
      query = `SELECT * FROM issue_comments WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;
      params = [since, limit];
    }

    const cursor = this.sql.exec<IssueCommentRow>(query, ...params);
    return [...cursor].map(rowToIssueCommentRecord);
  }

  // ---- PR review CRUD ----

  upsertPRReview(record: PRReviewRecord): void {
    this.sql.exec(
      `INSERT INTO pr_reviews (repo, review_id, number, author, state, body_hash, submitted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, review_id) DO UPDATE SET
         number       = excluded.number,
         author       = excluded.author,
         state        = excluded.state,
         body_hash    = excluded.body_hash,
         submitted_at = excluded.submitted_at,
         updated_at   = excluded.updated_at`,
      record.repo,
      record.reviewId,
      record.number,
      record.author,
      record.state,
      record.bodyHash,
      record.submittedAt,
      record.updatedAt,
    );
  }

  getPRReview(repo: string, reviewId: number): PRReviewRecord | null {
    const cursor = this.sql.exec<PRReviewRow>(
      `SELECT * FROM pr_reviews WHERE repo = ? AND review_id = ?`,
      repo,
      reviewId,
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return rowToPRReviewRecord(rows[0]);
  }

  deletePRReview(repo: string, reviewId: number): void {
    this.sql.exec(
      `DELETE FROM pr_reviews WHERE repo = ? AND review_id = ?`,
      repo,
      reviewId,
    );
  }

  getRecentPRReviews(
    opts?: { since?: string; limit?: number; repo?: string },
  ): PRReviewRecord[] {
    const limit = opts?.limit ?? 20;
    const since = opts?.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    let query: string;
    let params: (string | number)[];

    if (opts?.repo) {
      query = `SELECT * FROM pr_reviews WHERE repo = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;
      params = [opts.repo, since, limit];
    } else {
      query = `SELECT * FROM pr_reviews WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;
      params = [since, limit];
    }

    const cursor = this.sql.exec<PRReviewRow>(query, ...params);
    return [...cursor].map(rowToPRReviewRecord);
  }

  // ---- PR review comment CRUD ----

  upsertPRReviewComment(record: PRReviewCommentRecord): void {
    this.sql.exec(
      `INSERT INTO pr_review_comments (repo, comment_id, number, author, file_path, line, commit_id, body_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, comment_id) DO UPDATE SET
         number     = excluded.number,
         author     = excluded.author,
         file_path  = excluded.file_path,
         line       = excluded.line,
         commit_id  = excluded.commit_id,
         body_hash  = excluded.body_hash,
         updated_at = excluded.updated_at`,
      record.repo,
      record.commentId,
      record.number,
      record.author,
      record.filePath,
      record.line,
      record.commitId,
      record.bodyHash,
      record.createdAt,
      record.updatedAt,
    );
  }

  getPRReviewComment(repo: string, commentId: number): PRReviewCommentRecord | null {
    const cursor = this.sql.exec<PRReviewCommentRow>(
      `SELECT * FROM pr_review_comments WHERE repo = ? AND comment_id = ?`,
      repo,
      commentId,
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return rowToPRReviewCommentRecord(rows[0]);
  }

  deletePRReviewComment(repo: string, commentId: number): void {
    this.sql.exec(
      `DELETE FROM pr_review_comments WHERE repo = ? AND comment_id = ?`,
      repo,
      commentId,
    );
  }

  getRecentPRReviewComments(
    opts?: { since?: string; limit?: number; repo?: string },
  ): PRReviewCommentRecord[] {
    const limit = opts?.limit ?? 20;
    const since = opts?.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    let query: string;
    let params: (string | number)[];

    if (opts?.repo) {
      query = `SELECT * FROM pr_review_comments WHERE repo = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;
      params = [opts.repo, since, limit];
    } else {
      query = `SELECT * FROM pr_review_comments WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;
      params = [since, limit];
    }

    const cursor = this.sql.exec<PRReviewCommentRow>(query, ...params);
    return [...cursor].map(rowToPRReviewCommentRecord);
  }

  // ---- Full re-embed reset ----

  /**
   * Reset all state that controls re-embedding so that the next poll
   * will regenerate embeddings for every issue, release, and doc in the repo.
   *
   * Resets:
   * - body_hash in issues table (cleared to '' so poller detects change)
   * - body_hash in releases table (cleared to '' so poller detects change)
   * - blob_sha in docs table (deleted rows so poller re-fetches all files)
   * - diffs table (deleted rows — diffs are append-only, so no backfill happens
   *   on subsequent pushes; historical backfill is out of scope for now)
   * - Watermark entries for issues, releases, and docs (deleted so poller
   *   re-fetches from the beginning, bypassing ETag / since skipping)
   *
   * Returns a summary object with counts of what was reset.
   */
  resetForReEmbed(repo: string): {
    issueHashesReset: number;
    releaseHashesReset: number;
    docsDeleted: number;
    diffsDeleted: number;
    issueCommentHashesReset: number;
    prReviewHashesReset: number;
    prReviewCommentHashesReset: number;
    watermarksDeleted: number;
  } {
    const issuesCursor = this.sql.exec(
      `UPDATE issues SET body_hash = '' WHERE repo = ? AND body_hash != ''`,
      repo,
    );

    const releasesCursor = this.sql.exec(
      `UPDATE releases SET body_hash = '' WHERE repo = ? AND body_hash != ''`,
      repo,
    );

    const docsCursor = this.sql.exec(
      `DELETE FROM docs WHERE repo = ?`,
      repo,
    );

    const diffsCursor = this.sql.exec(
      `DELETE FROM diffs WHERE repo = ?`,
      repo,
    );

    const issueCommentsCursor = this.sql.exec(
      `UPDATE issue_comments SET body_hash = '' WHERE repo = ? AND body_hash != ''`,
      repo,
    );

    const prReviewsCursor = this.sql.exec(
      `UPDATE pr_reviews SET body_hash = '' WHERE repo = ? AND body_hash != ''`,
      repo,
    );

    const prReviewCommentsCursor = this.sql.exec(
      `UPDATE pr_review_comments SET body_hash = '' WHERE repo = ? AND body_hash != ''`,
      repo,
    );

    // Delete all watermark namespaces: issues (repo), releases (releases:{repo}),
    // docs (docs:{repo}), and the three comment/review surfaces
    // (comments:{repo}, reviews:{repo}, review_comments:{repo}).
    const watermarksCursor = this.sql.exec(
      `DELETE FROM watermarks WHERE repo IN (?, ?, ?, ?, ?, ?)`,
      repo,
      `releases:${repo}`,
      `docs:${repo}`,
      `comments:${repo}`,
      `reviews:${repo}`,
      `review_comments:${repo}`,
    );

    return {
      issueHashesReset: issuesCursor.rowsWritten,
      releaseHashesReset: releasesCursor.rowsWritten,
      docsDeleted: docsCursor.rowsWritten,
      diffsDeleted: diffsCursor.rowsWritten,
      issueCommentHashesReset: issueCommentsCursor.rowsWritten,
      prReviewHashesReset: prReviewsCursor.rowsWritten,
      prReviewCommentHashesReset: prReviewCommentsCursor.rowsWritten,
      watermarksDeleted: watermarksCursor.rowsWritten,
    };
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

      // POST /reset-hashes?repo=... — reset all hashes and watermarks for a repo to force re-embedding
      if (request.method === "POST" && path === "/reset-hashes") {
        const repo = url.searchParams.get("repo");
        if (!repo) return new Response("missing repo", { status: 400 });
        const summary = this.resetForReEmbed(repo);
        return Response.json({ repo, ...summary });
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

      // POST /upsert-diff — upsert a single diff record
      if (request.method === "POST" && path === "/upsert-diff") {
        const record = (await request.json()) as DiffRecord;
        this.upsertDiff(record);
        return new Response("ok", { status: 200 });
      }

      // GET /diff?repo=...&commit_sha=...&file_path=... — get a single diff
      if (request.method === "GET" && path === "/diff") {
        const repo = url.searchParams.get("repo");
        const commitSha = url.searchParams.get("commit_sha");
        const filePath = url.searchParams.get("file_path");
        if (!repo || !commitSha || !filePath) {
          return new Response(
            "missing repo, commit_sha, or file_path",
            { status: 400 },
          );
        }
        const diff = this.getDiff(repo, commitSha, filePath);
        if (!diff) return new Response("not found", { status: 404 });
        return Response.json(diff);
      }

      // GET /diffs?repo=...&commit_sha=... — list diffs for a commit
      if (request.method === "GET" && path === "/diffs") {
        const repo = url.searchParams.get("repo");
        const commitSha = url.searchParams.get("commit_sha");
        if (!repo || !commitSha) {
          return new Response("missing repo or commit_sha", { status: 400 });
        }
        const diffs = this.listDiffsByCommit(repo, commitSha);
        return Response.json(diffs);
      }

      // GET /recent-diffs?since=...&limit=...&repo=... — recent diff activity
      if (request.method === "GET" && path === "/recent-diffs") {
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        const repo = url.searchParams.get("repo") ?? undefined;
        const items = this.getRecentDiffs({
          since,
          limit: limit ? parseInt(limit, 10) : undefined,
          repo,
        });
        return Response.json(items);
      }

      // ── Issue comment endpoints ───────────────────────────────

      // POST /upsert-comment — upsert a single issue/PR top-level comment
      if (request.method === "POST" && path === "/upsert-comment") {
        const record = (await request.json()) as IssueCommentRecord;
        this.upsertIssueComment(record);
        return new Response("ok", { status: 200 });
      }

      // GET /comment?repo=...&comment_id=... — get a single comment
      if (request.method === "GET" && path === "/comment") {
        const repo = url.searchParams.get("repo");
        const commentId = url.searchParams.get("comment_id");
        if (!repo || !commentId) {
          return new Response("missing repo or comment_id", { status: 400 });
        }
        const item = this.getIssueComment(repo, parseInt(commentId, 10));
        if (!item) return new Response("not found", { status: 404 });
        return Response.json(item);
      }

      // DELETE /comment?repo=...&comment_id=... — delete a comment
      if (request.method === "DELETE" && path === "/comment") {
        const repo = url.searchParams.get("repo");
        const commentId = url.searchParams.get("comment_id");
        if (!repo || !commentId) {
          return new Response("missing repo or comment_id", { status: 400 });
        }
        this.deleteIssueComment(repo, parseInt(commentId, 10));
        return new Response("ok", { status: 200 });
      }

      // GET /recent-comments?since=...&limit=...&repo=... — recent comments
      if (request.method === "GET" && path === "/recent-comments") {
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        const repo = url.searchParams.get("repo") ?? undefined;
        const items = this.getRecentIssueComments({
          since,
          limit: limit ? parseInt(limit, 10) : undefined,
          repo,
        });
        return Response.json(items);
      }

      // ── PR review endpoints ───────────────────────────────────

      // POST /upsert-review — upsert a single PR review
      if (request.method === "POST" && path === "/upsert-review") {
        const record = (await request.json()) as PRReviewRecord;
        this.upsertPRReview(record);
        return new Response("ok", { status: 200 });
      }

      // GET /review?repo=...&review_id=... — get a single review
      if (request.method === "GET" && path === "/review") {
        const repo = url.searchParams.get("repo");
        const reviewId = url.searchParams.get("review_id");
        if (!repo || !reviewId) {
          return new Response("missing repo or review_id", { status: 400 });
        }
        const item = this.getPRReview(repo, parseInt(reviewId, 10));
        if (!item) return new Response("not found", { status: 404 });
        return Response.json(item);
      }

      // DELETE /review?repo=...&review_id=... — delete a review
      if (request.method === "DELETE" && path === "/review") {
        const repo = url.searchParams.get("repo");
        const reviewId = url.searchParams.get("review_id");
        if (!repo || !reviewId) {
          return new Response("missing repo or review_id", { status: 400 });
        }
        this.deletePRReview(repo, parseInt(reviewId, 10));
        return new Response("ok", { status: 200 });
      }

      // GET /recent-reviews?since=...&limit=...&repo=... — recent PR reviews
      if (request.method === "GET" && path === "/recent-reviews") {
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        const repo = url.searchParams.get("repo") ?? undefined;
        const items = this.getRecentPRReviews({
          since,
          limit: limit ? parseInt(limit, 10) : undefined,
          repo,
        });
        return Response.json(items);
      }

      // ── PR review comment endpoints ───────────────────────────

      // POST /upsert-review-comment — upsert a single PR inline review comment
      if (request.method === "POST" && path === "/upsert-review-comment") {
        const record = (await request.json()) as PRReviewCommentRecord;
        this.upsertPRReviewComment(record);
        return new Response("ok", { status: 200 });
      }

      // GET /review-comment?repo=...&comment_id=... — get a single review comment
      if (request.method === "GET" && path === "/review-comment") {
        const repo = url.searchParams.get("repo");
        const commentId = url.searchParams.get("comment_id");
        if (!repo || !commentId) {
          return new Response("missing repo or comment_id", { status: 400 });
        }
        const item = this.getPRReviewComment(repo, parseInt(commentId, 10));
        if (!item) return new Response("not found", { status: 404 });
        return Response.json(item);
      }

      // DELETE /review-comment?repo=...&comment_id=... — delete a review comment
      if (request.method === "DELETE" && path === "/review-comment") {
        const repo = url.searchParams.get("repo");
        const commentId = url.searchParams.get("comment_id");
        if (!repo || !commentId) {
          return new Response("missing repo or comment_id", { status: 400 });
        }
        this.deletePRReviewComment(repo, parseInt(commentId, 10));
        return new Response("ok", { status: 200 });
      }

      // GET /recent-review-comments?since=...&limit=...&repo=... — recent review comments
      if (request.method === "GET" && path === "/recent-review-comments") {
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        const repo = url.searchParams.get("repo") ?? undefined;
        const items = this.getRecentPRReviewComments({
          since,
          limit: limit ? parseInt(limit, 10) : undefined,
          repo,
        });
        return Response.json(items);
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(message, { status: 500 });
    }
  }
}
