/**
 * Scan mode — the empty-query branch of the `search` tool.
 *
 * Skips Vectorize / FTS5 / reranker entirely and aggregates time-ordered
 * metadata from the IssueStore recency endpoints. This path subsumes the former
 * `list_recent_activity` tool.
 *
 * The window is half-open: [since, until). Both bounds are pushed down to the
 * store so the per-endpoint row cap applies *inside* the window. Filtering
 * `until` on the caller side instead is what made old windows unreachable: the
 * cap selects the newest rows first, and the filter then drops every one of
 * them, so a window holding thousands of rows still read as zero (issue #194).
 *
 * Lives outside `mcp.ts` so the aggregation can be exercised against a real
 * IssueStore in tests without standing up the MCP agent.
 */

import type {
  IssueRecord,
  ReleaseRecord,
  DocRecord,
  WikiDocRecord,
  DiffRecord,
  IssueCommentRecord,
  PRReviewRecord,
  PRReviewCommentRecord,
} from "./types.js";

/** Result types scan mode can emit; `all` is the union filter value. */
export type ScanType =
  | "issue"
  | "pull_request"
  | "release"
  | "doc"
  | "wiki_doc"
  | "diff"
  | "issue_comment"
  | "pr_review"
  | "pr_review_comment";

export type ScanRow = {
  type: ScanType;
  repo: string;
  number: number;
  title: string;
  state: string;
  labels: string[];
  milestone: string;
  assignees: string[];
  url: string;
  updated_at: string;
  created_at: string;
  tag_name?: string;
  prerelease?: boolean;
  doc_path?: string;
  /** Wiki page slug (wiki_doc rows only) */
  wiki_path?: string;
  /** Wiki page extension (wiki_doc rows only, e.g. "md", "org") */
  wiki_extension?: string;
  commit_sha?: string;
  file_path?: string;
  file_status?: string;
  commit_date?: string;
  commit_author?: string;
  /** Comment / review author login */
  author?: string;
  /** GitHub comment / review id (comment rows only) */
  comment_id?: number;
  /** GitHub review id (pr_review rows only) */
  review_id?: number;
  /** Inline review-comment line number (pr_review_comment rows only) */
  line?: number;
};

/** The subset of a DurableObjectStub scan mode needs. */
export interface ScanStore {
  fetch(request: Request): Promise<Response>;
}

export interface ScanParams {
  repo?: string;
  state?: string;
  labels?: string[];
  milestone?: string;
  assignee?: string;
  type?: ScanType | "all";
  /** Page size the caller asked for (`top_k`). */
  topK: number;
  sort: "relevance" | "updated_desc" | "created_desc";
  since?: string;
  until?: string;
}

export interface ScanOutcome {
  rows: ScanRow[];
  /** Window floor actually applied (the caller's `since`, or the default). */
  since: string;
  /**
   * True when the window holds rows beyond the ones returned — either a store
   * endpoint filled its row cap, or the merged set was longer than `topK`.
   *
   * This is what separates "the window is empty" from "the window is bigger
   * than one response": a caller seeing `truncated: true` knows to narrow the
   * window (walk backwards by moving `until` to the oldest row returned)
   * instead of concluding the rows do not exist.
   */
  truncated: boolean;
}

/** Window width used when `since` is omitted. */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-endpoint row cap. Bounded by the store's subrequest / D1 read budget,
 * so overfetch stops here rather than growing with `top_k`.
 */
const STORE_ROW_CAP = 100;

/**
 * Aggregate one scan page from the store's recency endpoints.
 *
 * Endpoints are queried in sequence rather than in parallel to keep the
 * subrequest burst flat; a failing source is skipped, never fatal, so one dead
 * surface cannot empty the whole scan.
 */
export async function runScan(
  store: ScanStore,
  params: ScanParams,
): Promise<ScanOutcome> {
  const { topK, sort, until } = params;

  // With `until` given but no `since`, anchor the default window to the
  // requested upper bound. Anchoring it to "now" would put the floor above the
  // ceiling and return an empty window for every historical query.
  const windowEnd = until ? Date.parse(until) : Number.NaN;
  const anchor = Number.isNaN(windowEnd) ? Date.now() : windowEnd;
  const since =
    params.since ?? new Date(anchor - DEFAULT_WINDOW_MS).toISOString();

  // Overfetch so the type / state / label post-filters can drop rows without
  // starving the final page.
  const storeLimit = Math.min(topK * 5, STORE_ROW_CAP);

  const buildParams = (): URLSearchParams => {
    const p = new URLSearchParams();
    p.set("since", since);
    if (until) p.set("until", until);
    p.set("limit", String(storeLimit));
    if (params.repo) p.set("repo", params.repo);
    return p;
  };

  const rows: ScanRow[] = [];
  let truncated = false;

  const collect = async <T>(
    path: string,
    map: (record: T) => ScanRow | null,
  ): Promise<void> => {
    try {
      const res = await store.fetch(
        new Request(`http://store/${path}?${buildParams().toString()}`),
      );
      if (!res.ok) return;
      const records = (await res.json()) as T[];
      // A full page means the cap, not the window, ended the read.
      if (records.length >= storeLimit) truncated = true;
      for (const record of records) {
        const row = map(record);
        if (row) rows.push(row);
      }
    } catch {
      // Non-critical; continue with the other sources.
    }
  };

  const type = params.type;
  const wantType = (t: ScanType): boolean => !type || type === "all" || type === t;

  // Issues / PRs (one endpoint, two types)
  if (wantType("issue") || wantType("pull_request")) {
    await collect<IssueRecord>("recent", (r) =>
      wantType(r.type)
        ? {
            type: r.type,
            repo: r.repo,
            number: r.number,
            title: r.title,
            state: r.state,
            labels: r.labels,
            milestone: r.milestone,
            assignees: r.assignees,
            url: `https://github.com/${r.repo}/issues/${r.number}`,
            updated_at: r.updatedAt,
            created_at: r.createdAt,
          }
        : null,
    );
  }

  if (wantType("release")) {
    await collect<ReleaseRecord>("recent-releases", (r) => ({
      type: "release",
      repo: r.repo,
      number: 0,
      title: r.name || r.tagName,
      state: "published",
      labels: [],
      milestone: "",
      assignees: [],
      url: `https://github.com/${r.repo}/releases/tag/${r.tagName}`,
      updated_at: r.publishedAt,
      created_at: r.createdAt,
      tag_name: r.tagName,
      prerelease: r.prerelease,
    }));
  }

  if (wantType("doc")) {
    await collect<DocRecord>("recent-docs", (d) => ({
      type: "doc",
      repo: d.repo,
      number: 0,
      title: d.path,
      state: "active",
      labels: [],
      milestone: "",
      assignees: [],
      url: `https://github.com/${d.repo}/blob/main/${d.path}`,
      updated_at: d.updatedAt,
      created_at: d.updatedAt,
      doc_path: d.path,
    }));
  }

  if (wantType("wiki_doc")) {
    await collect<WikiDocRecord>("recent-wiki-docs", (w) => ({
      type: "wiki_doc",
      repo: w.repo,
      number: 0,
      title: w.pageName,
      state: "active",
      labels: [],
      milestone: "",
      assignees: [],
      url: `https://github.com/${w.repo}/wiki/${encodeURIComponent(w.pageName)}`,
      updated_at: w.updatedAt,
      created_at: w.updatedAt,
      wiki_path: w.pageName,
      wiki_extension: w.extension,
    }));
  }

  if (wantType("diff")) {
    await collect<DiffRecord>("recent-diffs", (diff) => ({
      type: "diff",
      repo: diff.repo,
      number: 0,
      title: `${diff.commitSha.slice(0, 7)} ${diff.filePath}`,
      state: "active",
      labels: [],
      milestone: "",
      assignees: [],
      url: `https://github.com/${diff.repo}/commit/${diff.commitSha}`,
      updated_at: diff.commitDate,
      created_at: diff.indexedAt,
      commit_sha: diff.commitSha,
      file_path: diff.filePath,
      file_status: diff.fileStatus,
      commit_date: diff.commitDate,
      commit_author: diff.commitAuthor,
    }));
  }

  if (wantType("issue_comment")) {
    await collect<IssueCommentRecord>("recent-comments", (c) => ({
      type: "issue_comment",
      repo: c.repo,
      number: c.number,
      title: `${c.author} on #${c.number}`,
      state: "active",
      labels: [],
      milestone: "",
      assignees: [],
      url: `https://github.com/${c.repo}/issues/${c.number}#issuecomment-${c.commentId}`,
      updated_at: c.updatedAt,
      created_at: c.createdAt,
      author: c.author,
      comment_id: c.commentId,
    }));
  }

  if (wantType("pr_review")) {
    await collect<PRReviewRecord>("recent-reviews", (r) => ({
      type: "pr_review",
      repo: r.repo,
      number: r.number,
      title: `${r.author} ${r.state} on #${r.number}`,
      state: r.state,
      labels: [],
      milestone: "",
      assignees: [],
      url: `https://github.com/${r.repo}/pull/${r.number}#pullrequestreview-${r.reviewId}`,
      updated_at: r.updatedAt,
      created_at: r.submittedAt,
      author: r.author,
      review_id: r.reviewId,
    }));
  }

  if (wantType("pr_review_comment")) {
    await collect<PRReviewCommentRecord>("recent-review-comments", (rc) => ({
      type: "pr_review_comment",
      repo: rc.repo,
      number: rc.number,
      title: `${rc.author} @ ${rc.filePath}:${rc.line}`,
      state: "active",
      labels: [],
      milestone: "",
      assignees: [],
      url: `https://github.com/${rc.repo}/pull/${rc.number}#discussion_r${rc.commentId}`,
      updated_at: rc.updatedAt,
      created_at: rc.createdAt,
      author: rc.author,
      comment_id: rc.commentId,
      file_path: rc.filePath,
      line: rc.line,
      commit_sha: rc.commitId,
    }));
  }

  // State / milestone / assignee / label post-filters (best-effort over the
  // metadata we have; assignees / labels are already arrays).
  let filtered = rows;
  if (params.state && params.state !== "all") {
    filtered = filtered.filter((r) => r.state === params.state);
  }
  if (params.milestone) {
    filtered = filtered.filter((r) => r.milestone === params.milestone);
  }
  if (params.assignee) {
    const assignee = params.assignee;
    filtered = filtered.filter((r) => r.assignees.includes(assignee));
  }
  const labels = params.labels;
  if (labels && labels.length > 0) {
    filtered = filtered.filter((r) => labels.every((l) => r.labels.includes(l)));
  }

  // Time sort. "created_desc" sorts by created_at; "updated_desc" (the scan
  // default) sorts by updated_at. "relevance" has no meaning here and falls
  // back to updated_desc.
  const sortKey: "updated_at" | "created_at" =
    sort === "created_desc" ? "created_at" : "updated_at";
  filtered.sort((a, b) => (b[sortKey] ?? "").localeCompare(a[sortKey] ?? ""));

  if (filtered.length > topK) truncated = true;

  return { rows: filtered.slice(0, topK), since, truncated };
}
