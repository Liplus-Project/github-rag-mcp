/**
 * RagMcpAgent — MCP server Durable Object exposing a single consolidated
 * semantic search tool.
 *
 * Tools:
 *   search_issues — hybrid search + time-ordered activity scan + inline doc
 *                    content fetch. Single entry point for GitHub issue / PR /
 *                    release / doc / commit-diff retrieval.
 *
 * Extends McpAgent from "agents/mcp" (same pattern as github-webhook-mcp).
 * Per-user: each authenticated user gets their own DO instance via
 * idFromName("user-{githubUserId}").
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  Env,
  IssueRecord,
  ReleaseRecord,
  DocRecord,
  DiffRecord,
  IssueCommentRecord,
  PRReviewRecord,
  PRReviewCommentRecord,
  VectorMetadata,
} from "./types.js";
import type { GitHubUserProps } from "./oauth.js";
import {
  queryFts,
  toRankMap,
  reciprocalRankFusion,
  type FtsHit,
  type FtsFilter,
} from "./fts.js";
import { rerankCandidates, RERANK_MAX_CANDIDATES } from "./rerank.js";

/** User context passed via props from OAuth layer */
interface McpProps extends Record<string, unknown> {
  githubUserId: number;
  githubLogin: string;
  accessToken: string;
}

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "github-rag-mcp/0.1.0";

/** Build GitHub API request headers using the authenticated user's token */
function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

/**
 * Upper bound on how many top-ranked doc rows get their raw content inlined
 * when include_content=true. Separate (and smaller) from top_k to keep
 * GitHub contents API fan-out bounded even when the caller requests a large
 * top_k for generic scanning. Callers that need more should page via
 * additional queries rather than lifting this cap.
 */
const INCLUDE_CONTENT_MAX_DOCS = 5;

export class RagMcpAgent extends McpAgent<Env, unknown, McpProps> {
  // @ts-expect-error -- McpServer version mismatch between top-level SDK and agents' bundled copy (same issue as webhook-mcp; wrangler resolves at bundle time)
  server = new McpServer({
    name: "github-rag-mcp",
    version: "0.1.0",
  });

  /** Get a stub to the global IssueStore DO */
  private getStore(): DurableObjectStub {
    const id = this.env.ISSUE_STORE.idFromName("global");
    return this.env.ISSUE_STORE.get(id);
  }

  /** Get the authenticated user's GitHub access token from props */
  private getGitHubToken(): string {
    const token = this.props?.accessToken;
    if (!token) {
      throw new Error("No GitHub access token available");
    }
    return token;
  }

  async init() {
    // ── search_issues ──────────────────────────────────────────
    this.server.tool(
      "search_issues",
      "Unified search across GitHub issues, PRs, releases, repository documentation, commit diffs, " +
        "issue/PR top-level comments, PR reviews, and PR inline review comments. " +
        "Three modes via the query / sort axes:\n" +
        "  1. Hybrid semantic search (default): dense BGE-M3 over Vectorize + sparse BM25 over D1 FTS5, " +
        "fused via Reciprocal Rank Fusion (RRF, k=60), then re-scored with a cross-encoder " +
        "(@cf/baai/bge-reranker-base; set rerank: false to skip).\n" +
        "  2. Time-ordered activity scan: pass an empty (or omitted) query with sort=\"updated_desc\" or \"created_desc\"; " +
        "optionally narrow via since / until to list recent activity across every type.\n" +
        "  3. Doc content fetch: pass include_content: true to inline the raw file content of top doc results " +
        "(fetched from the GitHub contents API; capped at the first few doc rows).\n" +
        "Optional metadata filters (repo, state, labels, milestone, assignee, type) apply across all modes. " +
        "Use type: \"diff\" to retrieve judgment history preserved in commit diffs — including changes to deleted files " +
        "and non-.md files that are not present in the live document index. " +
        "Use type: \"issue_comment\" / \"pr_review\" / \"pr_review_comment\" to retrieve comment-level judgment history " +
        "(Master's feedback, AI responses, self-review now/later/accepted classifications).",
      {
        query: z
          .string()
          .optional()
          .describe(
            "Natural language search query. When omitted or empty, the tool " +
              "switches to metadata-only scan mode and results are ordered " +
              "by the timestamp implied by sort (default sort=\"updated_desc\" for empty query).",
          ),
        repo: z
          .string()
          .optional()
          .describe("Filter by repository (owner/repo)"),
        state: z
          .enum(["open", "closed", "all"])
          .optional()
          .default("all")
          .describe("Filter by state"),
        labels: z
          .array(z.string())
          .optional()
          .describe("Filter by label names (AND logic)"),
        milestone: z
          .string()
          .optional()
          .describe("Filter by milestone title"),
        assignee: z
          .string()
          .optional()
          .describe("Filter by assignee login"),
        type: z
          .enum([
            "issue",
            "pull_request",
            "release",
            "doc",
            "diff",
            "issue_comment",
            "pr_review",
            "pr_review_comment",
            "all",
          ])
          .optional()
          .default("all")
          .describe(
            "Filter by type (default: all). " +
              "\"diff\" = per-file commit diffs. " +
              "\"issue_comment\" = top-level comments on issues and PRs. " +
              "\"pr_review\" = PR review bodies (approve / request_changes / comment). " +
              "\"pr_review_comment\" = inline per-line review comments on PR diffs.",
          ),
        top_k: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Max results (default: 10, max: 50)"),
        fusion: z
          .enum(["rrf", "dense_only", "sparse_only"])
          .optional()
          .default("rrf")
          .describe(
            "Fusion strategy. Default: rrf (Reciprocal Rank Fusion over dense + sparse). " +
              "dense_only = Vectorize only. sparse_only = D1 FTS5 BM25 only. " +
              "Use rrf unless debugging a specific ranker. Ignored in metadata-only scan mode (empty query).",
          ),
        rerank: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Cross-encoder reranking with @cf/baai/bge-reranker-base. Default: true. " +
              "When enabled, the fused (or single-ranker) candidates are overfetched (top_k × 5, max 50), " +
              "post-filtered, then re-scored by the cross-encoder before being trimmed to top_k. " +
              "Set false to disable (faster, no Workers AI rerank cost; recommended for debugging or " +
              "when query is a short identifier where lexical match is already decisive). " +
              "Ignored in metadata-only scan mode (empty query).",
          ),
        sort: z
          .enum(["relevance", "updated_desc", "created_desc"])
          .optional()
          .describe(
            "Result ordering. Default: \"relevance\" when query is non-empty, \"updated_desc\" when query is empty. " +
              "\"updated_desc\" / \"created_desc\" force time-ordered output and override ranker scores.",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "ISO 8601 timestamp (inclusive) — keep only results whose updated_at >= since. " +
              "Pair with sort=\"updated_desc\" + empty query for an activity scan.",
          ),
        until: z
          .string()
          .optional()
          .describe(
            "ISO 8601 timestamp (exclusive) — keep only results whose updated_at < until.",
          ),
        include_content: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true and a result row is type=\"doc\", fetch the file content from the GitHub " +
              "contents API and inline it as a \"content\" field on that row. Capped at the first " +
              `${INCLUDE_CONTENT_MAX_DOCS} doc rows in the result set to bound API fan-out. ` +
              "Non-doc rows are unaffected.",
          ),
      },
      async ({
        query,
        repo,
        state,
        labels,
        milestone,
        assignee,
        type,
        top_k,
        fusion,
        rerank,
        sort,
        since,
        until,
        include_content,
      }) => {
        const requestedTopK = top_k ?? 10;
        const fusionMode = fusion ?? "rrf";
        const rerankEnabled = rerank ?? true;
        const trimmedQuery = (query ?? "").trim();
        const isScanMode = trimmedQuery.length === 0;
        const effectiveSort =
          sort ?? (isScanMode ? "updated_desc" : "relevance");
        const includeContent = include_content ?? false;

        // ── Scan mode (empty query): pull time-ordered metadata ─────
        // Skip Vectorize / FTS5 / reranker entirely and aggregate from
        // IssueStore's recency endpoints. This path subsumes the former
        // list_recent_activity tool; `since` acts as the window floor and
        // `until` as the upper bound (applied after the store returns).
        if (isScanMode) {
          const store = this.getStore();
          const effectiveSince =
            since ??
            new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          // Overfetch so the `until` filter + type filter can drop rows
          // without starving the final page. Bounded at 100 (the store's
          // per-endpoint cap).
          const storeLimit = Math.min(requestedTopK * 5, 100);

          const buildParams = (): URLSearchParams => {
            const p = new URLSearchParams();
            p.set("since", effectiveSince);
            p.set("limit", String(storeLimit));
            if (repo) p.set("repo", repo);
            return p;
          };

          type ScanRow = {
            type:
              | "issue"
              | "pull_request"
              | "release"
              | "doc"
              | "diff"
              | "issue_comment"
              | "pr_review"
              | "pr_review_comment";
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
          const rows: ScanRow[] = [];

          const wantType = (t: ScanRow["type"]): boolean =>
            !type || type === "all" || type === t;

          // Issues / PRs
          if (wantType("issue") || wantType("pull_request")) {
            try {
              const res = await store.fetch(
                new Request(`http://store/recent?${buildParams().toString()}`),
              );
              if (res.ok) {
                const records = (await res.json()) as IssueRecord[];
                for (const r of records) {
                  if (!wantType(r.type)) continue;
                  rows.push({
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
                  });
                }
              }
            } catch {
              // Non-critical; continue with other sources.
            }
          }

          // Releases
          if (wantType("release")) {
            try {
              const res = await store.fetch(
                new Request(
                  `http://store/recent-releases?${buildParams().toString()}`,
                ),
              );
              if (res.ok) {
                const records = (await res.json()) as ReleaseRecord[];
                for (const r of records) {
                  rows.push({
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
                  });
                }
              }
            } catch {
              // Non-critical.
            }
          }

          // Docs
          if (wantType("doc")) {
            try {
              const res = await store.fetch(
                new Request(
                  `http://store/recent-docs?${buildParams().toString()}`,
                ),
              );
              if (res.ok) {
                const records = (await res.json()) as DocRecord[];
                for (const d of records) {
                  rows.push({
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
                  });
                }
              }
            } catch {
              // Non-critical.
            }
          }

          // Diffs
          if (wantType("diff")) {
            try {
              const res = await store.fetch(
                new Request(
                  `http://store/recent-diffs?${buildParams().toString()}`,
                ),
              );
              if (res.ok) {
                const records = (await res.json()) as DiffRecord[];
                for (const diff of records) {
                  const shortSha = diff.commitSha.slice(0, 7);
                  rows.push({
                    type: "diff",
                    repo: diff.repo,
                    number: 0,
                    title: `${shortSha} ${diff.filePath}`,
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
                  });
                }
              }
            } catch {
              // Non-critical.
            }
          }

          // Issue / PR top-level comments
          if (wantType("issue_comment")) {
            try {
              const res = await store.fetch(
                new Request(
                  `http://store/recent-comments?${buildParams().toString()}`,
                ),
              );
              if (res.ok) {
                const records = (await res.json()) as IssueCommentRecord[];
                for (const c of records) {
                  rows.push({
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
                  });
                }
              }
            } catch {
              // Non-critical.
            }
          }

          // PR reviews (approve / request_changes / comment body)
          if (wantType("pr_review")) {
            try {
              const res = await store.fetch(
                new Request(
                  `http://store/recent-reviews?${buildParams().toString()}`,
                ),
              );
              if (res.ok) {
                const records = (await res.json()) as PRReviewRecord[];
                for (const r of records) {
                  rows.push({
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
                  });
                }
              }
            } catch {
              // Non-critical.
            }
          }

          // PR inline review comments
          if (wantType("pr_review_comment")) {
            try {
              const res = await store.fetch(
                new Request(
                  `http://store/recent-review-comments?${buildParams().toString()}`,
                ),
              );
              if (res.ok) {
                const records = (await res.json()) as PRReviewCommentRecord[];
                for (const rc of records) {
                  rows.push({
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
                  });
                }
              }
            } catch {
              // Non-critical.
            }
          }

          // State / milestone / assignee / labels post-filters (best-effort
          // over the metadata we have; assignees / labels are already arrays).
          let filteredRows = rows;
          if (state && state !== "all") {
            filteredRows = filteredRows.filter((r) => r.state === state);
          }
          if (milestone) {
            filteredRows = filteredRows.filter((r) => r.milestone === milestone);
          }
          if (assignee) {
            filteredRows = filteredRows.filter((r) =>
              r.assignees.includes(assignee),
            );
          }
          if (labels && labels.length > 0) {
            filteredRows = filteredRows.filter((r) =>
              labels.every((l) => r.labels.includes(l)),
            );
          }
          if (until) {
            filteredRows = filteredRows.filter((r) => r.updated_at < until);
          }

          // Time sort. "created_desc" sorts by created_at; "updated_desc"
          // (default for scan mode) sorts by updated_at. "relevance" has no
          // meaning in scan mode and falls back to updated_desc.
          const sortKey: "updated_at" | "created_at" =
            effectiveSort === "created_desc" ? "created_at" : "updated_at";
          filteredRows.sort((a, b) => {
            const av = (a[sortKey] as string) ?? "";
            const bv = (b[sortKey] as string) ?? "";
            return bv.localeCompare(av);
          });

          const pageRows = filteredRows.slice(0, requestedTopK);

          // Optional doc content inlining (scan mode).
          type ScanResultRow = ScanRow & { content?: string };
          const items: ScanResultRow[] = pageRows;
          if (includeContent) {
            await this.inlineDocContent(items, repo);
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    count: items.length,
                    mode: "scan",
                    sort: effectiveSort,
                    since: effectiveSince,
                    until: until ?? null,
                    results: items,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // ── Search mode (non-empty query): existing hybrid pipeline ─
        // Overfetch on both sides when label/assignee post-filter is needed.
        // Also overfetch when the reranker is enabled, so the cross-encoder
        // sees enough candidates (issue #91 default: top_k × 5, capped at 50).
        // RERANK_MAX_CANDIDATES is the AI-side upper bound; we mirror it here
        // so dense and sparse fetch enough rows to feed the reranker.
        const needsPostFilter = (labels && labels.length > 0) || !!assignee;
        const needsTimeFilter = !!since || !!until;
        const internalTopK =
          needsPostFilter || needsTimeFilter || rerankEnabled
            ? Math.min(requestedTopK * 5, RERANK_MAX_CANDIDATES)
            : requestedTopK;

        // ── Dense path: Vectorize embedding query ────────────────
        const densePromise: Promise<{
          hits: Array<{
            vectorId: string;
            score: number;
            meta: VectorMetadata | undefined;
          }>;
          error?: string;
        }> =
          fusionMode === "sparse_only"
            ? Promise.resolve({ hits: [] })
            : (async () => {
                const aiResult = await this.env.AI.run("@cf/baai/bge-m3", {
                  text: [trimmedQuery],
                });
                const vectors = (aiResult as { data: Array<number[]> }).data;
                if (!vectors || vectors.length === 0) {
                  return { hits: [], error: "embedding_failed" };
                }
                const embedding = vectors[0];

                const filter: VectorizeVectorMetadataFilter = {};
                if (repo) filter["repo"] = { $eq: repo };
                if (state && state !== "all") filter["state"] = { $eq: state };
                if (type && type !== "all") filter["type"] = { $eq: type };
                if (milestone) filter["milestone"] = { $eq: milestone };

                const vectorizeFilter: VectorizeVectorMetadataFilter | undefined =
                  Object.keys(filter).length > 0 ? filter : undefined;

                const results = await this.env.VECTORIZE.query(embedding, {
                  topK: internalTopK,
                  filter: vectorizeFilter,
                  returnMetadata: "all",
                });

                return {
                  hits: results.matches.map((m) => ({
                    vectorId: m.id,
                    score: m.score,
                    meta: m.metadata as unknown as VectorMetadata | undefined,
                  })),
                };
              })();

        // ── Sparse path: D1 FTS5 BM25 query ──────────────────────
        const sparsePromise: Promise<FtsHit[]> =
          fusionMode === "dense_only"
            ? Promise.resolve([])
            : (async () => {
                const ftsFilter: FtsFilter = {};
                if (repo) ftsFilter.repo = repo;
                if (state && state !== "all") {
                  ftsFilter.state = state as FtsFilter["state"];
                }
                if (type && type !== "all") {
                  ftsFilter.type = type as FtsFilter["type"];
                }
                if (milestone) ftsFilter.milestone = milestone;
                try {
                  return await queryFts(this.env.DB_FTS, trimmedQuery, internalTopK, ftsFilter);
                } catch (err) {
                  console.error(
                    "search_issues: D1 FTS5 query failed:",
                    err instanceof Error ? err.message : String(err),
                  );
                  return [];
                }
              })();

        const [denseResult, sparseHits] = await Promise.all([
          densePromise,
          sparsePromise,
        ]);

        if (denseResult.error === "embedding_failed" && fusionMode !== "sparse_only") {
          return {
            content: [
              { type: "text" as const, text: "Failed to generate embedding for query" },
            ],
            isError: true,
          };
        }

        // ── Fusion: build rank maps and combine via RRF ──────────
        // Both hit arrays are already ordered best-first by their respective ranker.
        // For dense_only / sparse_only, RRF degenerates to a single-ranker sort,
        // which preserves the original ordering without additional logic.
        const denseRanks = toRankMap(
          denseResult.hits.map((h) => ({ vectorId: h.vectorId })),
        );
        const sparseRanks = toRankMap(
          sparseHits.map((h) => ({ vectorId: h.vectorId })),
        );

        const rankers = new Map<string, Map<string, number>>();
        if (fusionMode !== "sparse_only") rankers.set("dense", denseRanks);
        if (fusionMode !== "dense_only") rankers.set("sparse", sparseRanks);

        const fused = reciprocalRankFusion({ rankers });

        // Build a vector_id → payload lookup combining dense metadata and sparse rows.
        // Dense metadata wins when both sides see a vector; sparse hits fill in the gaps
        // (e.g., when BM25 surfaces a row that dense missed entirely).
        const payload = new Map<
          string,
          {
            meta: VectorMetadata | undefined;
            ftsRow: FtsHit | undefined;
            denseScore: number | undefined;
            sparseScore: number | undefined;
          }
        >();
        for (const h of denseResult.hits) {
          payload.set(h.vectorId, {
            meta: h.meta,
            ftsRow: undefined,
            denseScore: h.score,
            sparseScore: undefined,
          });
        }
        for (const h of sparseHits) {
          const existing = payload.get(h.vectorId);
          if (existing) {
            existing.ftsRow = h;
            existing.sparseScore = h.score;
          } else {
            payload.set(h.vectorId, {
              meta: undefined,
              ftsRow: h,
              denseScore: undefined,
              sparseScore: h.score,
            });
          }
        }

        // ── Post-filter: labels (AND), assignee, and time window ─
        // Applied after fusion on the combined view so both dense-only and sparse-only
        // hits are filtered consistently. Prefers dense metadata when available
        // (has expanded label_0..3 / assignee_0..1 slots), falls back to sparse row
        // (comma-separated labels / assignees) otherwise.
        const resolveLabels = (vectorId: string): Set<string> => {
          const p = payload.get(vectorId);
          if (!p) return new Set();
          const out = new Set<string>();
          if (p.meta) {
            for (const l of [p.meta.label_0, p.meta.label_1, p.meta.label_2, p.meta.label_3]) {
              if (l) out.add(l);
            }
            if (p.meta.labels) {
              for (const l of p.meta.labels.split(",")) {
                const t = l.trim();
                if (t) out.add(t);
              }
            }
          }
          if (p.ftsRow?.labels) {
            for (const l of p.ftsRow.labels.split(",")) {
              const t = l.trim();
              if (t) out.add(t);
            }
          }
          return out;
        };

        const resolveAssignees = (vectorId: string): Set<string> => {
          const p = payload.get(vectorId);
          if (!p) return new Set();
          const out = new Set<string>();
          if (p.meta) {
            if (p.meta.assignee_0) out.add(p.meta.assignee_0);
            if (p.meta.assignee_1) out.add(p.meta.assignee_1);
            if (p.meta.assignees) {
              for (const a of p.meta.assignees.split(",")) {
                const t = a.trim();
                if (t) out.add(t);
              }
            }
          }
          if (p.ftsRow?.assignees) {
            for (const a of p.ftsRow.assignees.split(",")) {
              const t = a.trim();
              if (t) out.add(t);
            }
          }
          return out;
        };

        const resolveUpdatedAt = (vectorId: string): string => {
          const p = payload.get(vectorId);
          return p?.meta?.updated_at ?? p?.ftsRow?.updatedAt ?? "";
        };

        let filtered = fused;
        if (labels && labels.length > 0) {
          filtered = filtered.filter((f) => {
            const all = resolveLabels(f.vectorId);
            return labels.every((l) => all.has(l));
          });
        }
        if (assignee) {
          filtered = filtered.filter((f) => {
            const all = resolveAssignees(f.vectorId);
            return all.has(assignee);
          });
        }
        if (since) {
          filtered = filtered.filter((f) => resolveUpdatedAt(f.vectorId) >= since);
        }
        if (until) {
          filtered = filtered.filter((f) => resolveUpdatedAt(f.vectorId) < until);
        }

        // ── Reranker (3rd tier): cross-encoder re-scoring ────────
        // Only invoked when:
        //   - rerank is enabled (default true),
        //   - sort is "relevance" (time-sorted callers do not need ranker score),
        //   - more than one candidate survived post-filter (single-element
        //     reranking would not change order),
        //   - we have content text to feed (sparse FtsRow has it; dense-only
        //     candidates without sparse hit have no content available — for
        //     those we use an empty string and the reranker contributes
        //     nothing for that row, which is acceptable graceful degradation).
        // The reranker re-orders `filtered` in place. On error or unexpected
        // shape it returns null, in which case we keep the post-filter order.
        const rerankScores = new Map<string, number>();
        let rerankApplied = false;
        if (
          rerankEnabled &&
          effectiveSort === "relevance" &&
          filtered.length > 1
        ) {
          const rerankInput = filtered.map((f) => {
            const p = payload.get(f.vectorId);
            // Prefer sparse content (always populated when present), fall back
            // to empty string for dense-only hits where we have no FtsRow.
            const content = p?.ftsRow?.content ?? "";
            return { id: f.vectorId, content };
          });

          const reranked = await rerankCandidates(
            this.env,
            trimmedQuery,
            rerankInput,
            // Ask the reranker to return all rows so we can attach scores even
            // to candidates that drop below requestedTopK; we trim ourselves.
            rerankInput.length,
          );

          if (reranked) {
            for (const r of reranked) {
              rerankScores.set(r.id, r.score);
            }
            // Re-order `filtered` by reranker score descending. Candidates
            // missing from the reranker response (defensive: model may drop
            // rows) are appended in their original relative order.
            const rerankedIds = new Set(reranked.map((r) => r.id));
            const byId = new Map(filtered.map((f) => [f.vectorId, f]));
            const reorderedHits: typeof filtered = [];
            for (const r of reranked) {
              const hit = byId.get(r.id);
              if (hit) reorderedHits.push(hit);
            }
            for (const f of filtered) {
              if (!rerankedIds.has(f.vectorId)) reorderedHits.push(f);
            }
            filtered = reorderedHits;
            rerankApplied = true;
          }
        }

        // ── Time sort (override ranker order) ─────────────────────
        // When the caller asked for time-ordered output even on a semantic
        // query, re-sort `filtered` by the requested timestamp column.
        // Rows missing the column fall to the tail (empty string sorts low
        // under localeCompare-desc semantics).
        if (effectiveSort === "updated_desc" || effectiveSort === "created_desc") {
          const resolveTimeKey = (vectorId: string): string => {
            const p = payload.get(vectorId);
            if (effectiveSort === "updated_desc") {
              return p?.meta?.updated_at ?? p?.ftsRow?.updatedAt ?? "";
            }
            // created_desc: VectorMetadata has no created_at; FTS hit has no
            // createdAt either, so both collapse to updated_at as the best
            // available proxy. Documented in the schema description.
            return p?.meta?.updated_at ?? p?.ftsRow?.updatedAt ?? "";
          };
          filtered = [...filtered].sort((a, b) => {
            const av = resolveTimeKey(a.vectorId);
            const bv = resolveTimeKey(b.vectorId);
            return bv.localeCompare(av);
          });
        }

        // Trim to requested top-K after fusion + post-filter (+ rerank / time sort).
        filtered = filtered.slice(0, requestedTopK);

        // ── Format results ───────────────────────────────────────
        type ResultItem = {
          number: number;
          title: string;
          state: string;
          type: string;
          labels: string[];
          milestone: string;
          assignees: string[];
          score: number;
          dense_score: number | null;
          sparse_score: number | null;
          dense_rank: number | null;
          sparse_rank: number | null;
          rerank_score: number | null;
          url: string;
          updated_at: string;
          repo: string;
          tag_name?: string;
          doc_path?: string;
          commit_sha?: string;
          file_path?: string;
          file_status?: string;
          commit_date?: string;
          commit_author?: string;
          author?: string;
          comment_id?: number;
          review_id?: number;
          line?: number;
          content?: string;
        };

        const items: ResultItem[] = filtered.map((f) => {
          const p = payload.get(f.vectorId);
          const meta = p?.meta;
          const ftsRow = p?.ftsRow;

          const itemRepo = meta?.repo ?? ftsRow?.repo ?? "";
          const number = meta?.number ?? ftsRow?.number ?? 0;
          const itemType = meta?.type ?? (ftsRow?.type as VectorMetadata["type"] | undefined) ?? "";
          const itemState = meta?.state ?? ftsRow?.state ?? "";
          const labelsCsv = meta?.labels ?? ftsRow?.labels ?? "";
          const milestoneVal = meta?.milestone ?? ftsRow?.milestone ?? "";
          const assigneesCsv = meta?.assignees ?? ftsRow?.assignees ?? "";
          const updatedAt = meta?.updated_at ?? ftsRow?.updatedAt ?? "";
          const tagName = meta?.tag_name ?? ftsRow?.tagName ?? "";
          const docPath = meta?.doc_path ?? ftsRow?.docPath ?? "";
          const commitSha = meta?.commit_sha ?? ftsRow?.commitSha ?? "";
          const filePath = meta?.file_path ?? ftsRow?.filePath ?? "";
          const fileStatus = meta?.file_status ?? ftsRow?.fileStatus ?? "";
          const commitDate = meta?.commit_date ?? ftsRow?.commitDate ?? "";
          const commitAuthor = meta?.commit_author ?? ftsRow?.commitAuthor ?? "";
          const author = meta?.author ?? "";
          const commentId = meta?.comment_id ?? 0;
          const reviewId = meta?.review_id ?? 0;
          const line = meta?.line ?? 0;

          let url: string;
          if (itemType === "release" && tagName) {
            url = `https://github.com/${itemRepo}/releases/tag/${tagName}`;
          } else if (itemType === "doc" && docPath) {
            url = `https://github.com/${itemRepo}/blob/main/${docPath}`;
          } else if (itemType === "diff" && commitSha) {
            url = `https://github.com/${itemRepo}/commit/${commitSha}`;
          } else if (itemType === "issue_comment" && commentId) {
            url = `https://github.com/${itemRepo}/issues/${number}#issuecomment-${commentId}`;
          } else if (itemType === "pr_review" && reviewId) {
            url = `https://github.com/${itemRepo}/pull/${number}#pullrequestreview-${reviewId}`;
          } else if (itemType === "pr_review_comment" && commentId) {
            url = `https://github.com/${itemRepo}/pull/${number}#discussion_r${commentId}`;
          } else {
            url = `https://github.com/${itemRepo}/issues/${number}`;
          }

          return {
            number,
            title: "", // Enriched below
            state: itemState,
            type: itemType,
            labels: labelsCsv ? labelsCsv.split(",").filter(Boolean) : [],
            milestone: milestoneVal,
            assignees: assigneesCsv ? assigneesCsv.split(",").filter(Boolean) : [],
            score: f.fusedScore,
            dense_score: p?.denseScore ?? null,
            sparse_score: p?.sparseScore ?? null,
            dense_rank: f.contributions["dense"] ?? null,
            sparse_rank: f.contributions["sparse"] ?? null,
            // null when reranker was disabled, skipped (≤1 candidate), or
            // failed gracefully; populated otherwise.
            rerank_score: rerankScores.get(f.vectorId) ?? null,
            url,
            updated_at: updatedAt,
            repo: itemRepo,
            ...(itemType === "release" ? { tag_name: tagName } : {}),
            ...(itemType === "doc" ? { doc_path: docPath } : {}),
            ...(itemType === "diff"
              ? {
                  commit_sha: commitSha,
                  file_path: filePath,
                  file_status: fileStatus,
                  commit_date: commitDate,
                  commit_author: commitAuthor,
                }
              : {}),
            ...(itemType === "issue_comment"
              ? {
                  author,
                  comment_id: commentId,
                }
              : {}),
            ...(itemType === "pr_review"
              ? {
                  author,
                  review_id: reviewId,
                }
              : {}),
            ...(itemType === "pr_review_comment"
              ? {
                  author,
                  comment_id: commentId,
                  file_path: filePath,
                  line,
                  commit_sha: commitSha,
                }
              : {}),
          };
        });

        // Enrich with titles from IssueStore / release store / doc store
        const store = this.getStore();
        for (const item of items) {
          if (item.type === "release" && item.repo && item.tag_name) {
            try {
              const res = await store.fetch(
                new Request(
                  `http://store/release?repo=${encodeURIComponent(item.repo)}&tag_name=${encodeURIComponent(item.tag_name)}`,
                ),
              );
              if (res.ok) {
                const record = (await res.json()) as ReleaseRecord;
                item.title = record.name || record.tagName;
              }
            } catch {
              // Best-effort enrichment
            }
          } else if (item.type === "doc" && item.repo && item.doc_path) {
            // Use the file path as the title for docs
            item.title = item.doc_path;
          } else if (item.type === "diff") {
            // Title = "{short-sha} {file_path}" so the result list remains
            // scannable without making an additional API call.
            const fp = item.file_path ?? "";
            const sha = item.commit_sha ?? "";
            const shortSha = sha ? sha.slice(0, 7) : "";
            item.title = [shortSha, fp].filter(Boolean).join(" ");
          } else if (item.type === "issue_comment") {
            // Title = "{author} on #{number}" — enough context to skim results.
            const author = item.author ?? "";
            item.title = author ? `${author} on #${item.number}` : `comment on #${item.number}`;
          } else if (item.type === "pr_review") {
            // Title = "{author} {state} on #{number}" — review state gives
            // the classification at a glance (APPROVED / CHANGES_REQUESTED / COMMENTED).
            const author = item.author ?? "";
            const state = item.state || "";
            item.title = author ? `${author} ${state} on #${item.number}` : `review on #${item.number}`;
          } else if (item.type === "pr_review_comment") {
            // Title = "{author} @ {file_path}:{line}" — inline comment location.
            const author = item.author ?? "";
            const fp = item.file_path ?? "";
            const line = item.line ?? 0;
            item.title = author ? `${author} @ ${fp}:${line}` : `inline on #${item.number}`;
          } else if (item.repo && item.number) {
            try {
              const res = await store.fetch(
                new Request(
                  `http://store/issue?repo=${encodeURIComponent(item.repo)}&number=${item.number}`,
                ),
              );
              if (res.ok) {
                const record = (await res.json()) as IssueRecord;
                item.title = record.title;
              }
            } catch {
              // Best-effort enrichment; continue without title
            }
          }
        }

        // Optional doc content inlining (search mode).
        if (includeContent) {
          await this.inlineDocContent(items);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: items.length,
                  mode: "search",
                  fusion: fusionMode,
                  sort: effectiveSort,
                  dense_candidates: denseResult.hits.length,
                  sparse_candidates: sparseHits.length,
                  // rerank metadata:
                  //   - rerank_requested: caller-facing flag (default true)
                  //   - rerank_applied: whether the cross-encoder actually
                  //     ran and re-scored. False when disabled, when there
                  //     was ≤1 candidate to rerank, when sort != "relevance",
                  //     or when the AI call errored / returned an unexpected
                  //     shape (graceful fallback to fusion order).
                  rerank_requested: rerankEnabled,
                  rerank_applied: rerankApplied,
                  since: since ?? null,
                  until: until ?? null,
                  results: items,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
  }

  /**
   * Inline raw file content on up to INCLUDE_CONTENT_MAX_DOCS doc rows.
   * Mutates the rows in place (adds a `content` field). Non-doc rows and
   * rows beyond the cap are left untouched.
   *
   * Scope note: top-N doc fetch is a fan-out bound for GitHub contents API.
   * Callers needing more doc bodies should page by repeating the search.
   */
  private async inlineDocContent<
    T extends {
      type: string;
      repo?: string;
      doc_path?: string;
      content?: string;
    },
  >(rows: T[], fallbackRepo?: string): Promise<void> {
    const docRows = rows.filter((r) => r.type === "doc");
    if (docRows.length === 0) return;
    const toFetch = docRows.slice(0, INCLUDE_CONTENT_MAX_DOCS);

    const token = this.getGitHubToken();
    const headers = githubHeaders(token);

    await Promise.all(
      toFetch.map(async (row) => {
        const docPath = row.doc_path;
        const itemRepo = row.repo ?? fallbackRepo ?? "";
        if (!docPath || !itemRepo) return;
        const url = new URL(`${GITHUB_API}/repos/${itemRepo}/contents/${docPath}`);
        try {
          const res = await fetch(url.toString(), { headers });
          if (!res.ok) return;
          const data = (await res.json()) as {
            content?: string;
            encoding?: string;
          };
          if (!data.content) return;
          // GitHub returns base64-encoded content; decode via Uint8Array for UTF-8 safety.
          const binary = atob(data.content.replace(/\n/g, ""));
          const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          row.content = new TextDecoder().decode(bytes);
        } catch {
          // Best-effort inline; a failed fetch leaves `content` unset.
        }
      }),
    );
  }
}
