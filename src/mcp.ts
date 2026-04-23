/**
 * RagMcpAgent — MCP server Durable Object exposing semantic search tools.
 *
 * Tools:
 *   search_issues       — semantic + structured search via Vectorize + Workers AI
 *   get_issue_context   — aggregated issue view with related PRs, branch, CI
 *   get_doc_content     — retrieve .md document content from a repository
 *   list_recent_activity — recent changes across tracked repositories
 *
 * Extends McpAgent from "agents/mcp" (same pattern as github-webhook-mcp).
 * Per-user: each authenticated user gets their own DO instance via
 * idFromName("user-{githubUserId}").
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, IssueRecord, ReleaseRecord, DocRecord, DiffRecord, VectorMetadata } from "./types.js";
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

/** Classify activity type based on issue timestamps and state */
function classifyActivity(
  record: IssueRecord,
  since: string,
): "created" | "updated" | "closed" {
  if (record.state === "closed" && record.updatedAt >= since) {
    return "closed";
  }
  if (record.createdAt >= since) {
    return "created";
  }
  return "updated";
}

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
      "Hybrid search (dense + sparse + cross-encoder reranker) for GitHub issues, PRs, releases, repository documentation, and commit diffs. " +
        "Dense retrieval uses BGE-M3 embeddings over Vectorize; sparse retrieval uses BM25 over D1 FTS5 " +
        "with a porter tokenizer for natural-language surfaces and a trigram tokenizer for commit diffs. " +
        "The two rankers are combined via Reciprocal Rank Fusion (RRF, k=60). " +
        "By default, the fused candidates are then re-scored with a cross-encoder reranker " +
        "(@cf/baai/bge-reranker-base) — set rerank: false to skip this stage. " +
        "Optional metadata filters (repo, state, labels, milestone, assignee, type) apply to both sides. " +
        "Use type: \"diff\" to retrieve judgment history preserved in commit diffs — including changes to deleted files and non-.md files that are not present in the live document index.",
      {
        query: z.string().describe("Natural language search query"),
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
          .enum(["issue", "pull_request", "release", "doc", "diff", "all"])
          .optional()
          .default("all")
          .describe("Filter by type (default: all). Use \"diff\" to search per-file commit diffs."),
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
              "Use rrf unless debugging a specific ranker.",
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
              "when query is a short identifier where lexical match is already decisive).",
          ),
      },
      async ({ query, repo, state, labels, milestone, assignee, type, top_k, fusion, rerank }) => {
        const requestedTopK = top_k ?? 10;
        const fusionMode = fusion ?? "rrf";
        const rerankEnabled = rerank ?? true;
        // Overfetch on both sides when label/assignee post-filter is needed.
        // Also overfetch when the reranker is enabled, so the cross-encoder
        // sees enough candidates (issue #91 default: top_k × 5, capped at 50).
        // RERANK_MAX_CANDIDATES is the AI-side upper bound; we mirror it here
        // so dense and sparse fetch enough rows to feed the reranker.
        const needsPostFilter = (labels && labels.length > 0) || !!assignee;
        const internalTopK =
          needsPostFilter || rerankEnabled
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
                  text: [query],
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
                  return await queryFts(this.env.DB_FTS, query, internalTopK, ftsFilter);
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

        // ── Post-filter: labels (AND) and assignee ───────────────
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

        // ── Reranker (3rd tier): cross-encoder re-scoring ────────
        // Only invoked when:
        //   - rerank is enabled (default true),
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
        if (rerankEnabled && filtered.length > 1) {
          const rerankInput = filtered.map((f) => {
            const p = payload.get(f.vectorId);
            // Prefer sparse content (always populated when present), fall back
            // to empty string for dense-only hits where we have no FtsRow.
            const content = p?.ftsRow?.content ?? "";
            return { id: f.vectorId, content };
          });

          const reranked = await rerankCandidates(
            this.env,
            query,
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

        // Trim to requested top-K after fusion + post-filter (+ rerank).
        filtered = filtered.slice(0, requestedTopK);

        // ── Format results ───────────────────────────────────────
        const items = filtered.map((f) => {
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

          let url: string;
          if (itemType === "release" && tagName) {
            url = `https://github.com/${itemRepo}/releases/tag/${tagName}`;
          } else if (itemType === "doc" && docPath) {
            url = `https://github.com/${itemRepo}/blob/main/${docPath}`;
          } else if (itemType === "diff" && commitSha) {
            url = `https://github.com/${itemRepo}/commit/${commitSha}`;
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
          };
        });

        // Enrich with titles from IssueStore / release store / doc store
        const store = this.getStore();
        for (const item of items) {
          if (item.type === "release" && item.repo && (item as Record<string, unknown>).tag_name) {
            try {
              const res = await store.fetch(
                new Request(
                  `http://store/release?repo=${encodeURIComponent(item.repo)}&tag_name=${encodeURIComponent((item as Record<string, unknown>).tag_name as string)}`,
                ),
              );
              if (res.ok) {
                const record = (await res.json()) as ReleaseRecord;
                item.title = record.name || record.tagName;
              }
            } catch {
              // Best-effort enrichment
            }
          } else if (item.type === "doc" && item.repo && (item as Record<string, unknown>).doc_path) {
            // Use the file path as the title for docs
            item.title = (item as Record<string, unknown>).doc_path as string;
          } else if (item.type === "diff") {
            // Title = "{short-sha} {file_path}" so the result list remains
            // scannable without making an additional API call.
            const fp = (item as Record<string, unknown>).file_path as string;
            const sha = (item as Record<string, unknown>).commit_sha as string;
            const shortSha = sha ? sha.slice(0, 7) : "";
            item.title = [shortSha, fp].filter(Boolean).join(" ");
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

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: items.length,
                  fusion: fusionMode,
                  dense_candidates: denseResult.hits.length,
                  sparse_candidates: sparseHits.length,
                  // rerank metadata:
                  //   - rerank_requested: caller-facing flag (default true)
                  //   - rerank_applied: whether the cross-encoder actually
                  //     ran and re-scored. False when disabled, when there
                  //     was ≤1 candidate to rerank, or when the AI call
                  //     errored / returned an unexpected shape (graceful
                  //     fallback to fusion order).
                  rerank_requested: rerankEnabled,
                  rerank_applied: rerankApplied,
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

    // ── get_issue_context ──────────────────────────────────────
    this.server.tool(
      "get_issue_context",
      "Get aggregated context for a single issue/PR including related PRs, branch status, and CI status.",
      {
        repo: z
          .string()
          .describe("Repository (owner/repo)"),
        number: z
          .number()
          .int()
          .positive()
          .describe("Issue or PR number"),
      },
      async ({ repo, number }) => {
        const token = this.getGitHubToken();
        const headers = githubHeaders(token);

        // 1. Read basic info from IssueStore
        const store = this.getStore();
        const storeRes = await store.fetch(
          new Request(
            `http://store/issue?repo=${encodeURIComponent(repo)}&number=${number}`,
          ),
        );

        let issueData: IssueRecord | null = null;
        if (storeRes.ok) {
          issueData = (await storeRes.json()) as IssueRecord;
        }

        // 2. Fetch issue/PR details from GitHub API (for body and additional context)
        let ghIssue: Record<string, unknown> | null = null;
        let apiFetchError: string | null = null;
        try {
          const issueRes = await fetch(
            `${GITHUB_API}/repos/${repo}/issues/${number}`,
            { headers },
          );
          if (issueRes.ok) {
            ghIssue = (await issueRes.json()) as Record<string, unknown>;
          } else {
            apiFetchError = `GitHub API returned ${issueRes.status} ${issueRes.statusText}`;
            console.error(
              `get_issue_context: failed to fetch ${repo}#${number} from GitHub API: ${apiFetchError}`,
            );
          }
        } catch (err) {
          apiFetchError = err instanceof Error ? err.message : String(err);
          console.error(
            `get_issue_context: error fetching ${repo}#${number} from GitHub API: ${apiFetchError}`,
          );
        }

        // 3. Fetch linked PRs via timeline events
        const linkedPRs: Array<{
          number: number;
          title: string;
          state: string;
          branch: string;
        }> = [];
        try {
          const timelineRes = await fetch(
            `${GITHUB_API}/repos/${repo}/issues/${number}/timeline?per_page=100`,
            { headers: { ...headers, Accept: "application/vnd.github.mockingbird-preview+json" } },
          );
          if (timelineRes.ok) {
            const events = (await timelineRes.json()) as Array<{
              event?: string;
              source?: { issue?: { number: number; title: string; state: string; pull_request?: { url: string }; head?: { ref: string } } };
            }>;
            for (const event of events) {
              if (
                event.event === "cross-referenced" &&
                event.source?.issue?.pull_request
              ) {
                linkedPRs.push({
                  number: event.source.issue.number,
                  title: event.source.issue.title,
                  state: event.source.issue.state,
                  branch: event.source.issue.head?.ref ?? "",
                });
              }
            }
          }
        } catch {
          // Non-critical
        }

        // 4. If this is a PR, fetch branch and CI status
        let branchStatus: {
          name: string;
          ahead: number;
          behind: number;
        } | null = null;
        let ciStatus: Array<{
          name: string;
          conclusion: string | null;
          status: string;
          url: string;
        }> = [];

        const isPR =
          issueData?.type === "pull_request" ||
          !!(ghIssue as Record<string, unknown> | null)?.pull_request;

        if (isPR) {
          try {
            const prRes = await fetch(
              `${GITHUB_API}/repos/${repo}/pulls/${number}`,
              { headers },
            );
            if (prRes.ok) {
              const pr = (await prRes.json()) as {
                head: { ref: string; sha: string };
                base: { ref: string };
              };
              branchStatus = {
                name: pr.head.ref,
                ahead: 0,
                behind: 0,
              };

              // Fetch CI check runs for the head SHA
              const checksRes = await fetch(
                `${GITHUB_API}/repos/${repo}/commits/${pr.head.sha}/check-runs`,
                { headers },
              );
              if (checksRes.ok) {
                const checksData = (await checksRes.json()) as {
                  check_runs: Array<{
                    name: string;
                    conclusion: string | null;
                    status: string;
                    html_url: string;
                  }>;
                };
                ciStatus = checksData.check_runs.map((cr) => ({
                  name: cr.name,
                  conclusion: cr.conclusion,
                  status: cr.status,
                  url: cr.html_url,
                }));
              }
            }
          } catch {
            // Non-critical
          }
        }

        // 5. Fetch sub-issues if this is a parent issue (via GitHub sub-issues API)
        let subIssues: Array<{
          number: number;
          title: string;
          state: string;
        }> = [];
        try {
          const subRes = await fetch(
            `${GITHUB_API}/repos/${repo}/issues/${number}/sub_issues?per_page=50`,
            { headers },
          );
          if (subRes.ok) {
            const subData = (await subRes.json()) as Array<{
              number: number;
              title: string;
              state: string;
            }>;
            subIssues = subData.map((s) => ({
              number: s.number,
              title: s.title,
              state: s.state,
            }));
          }
        } catch {
          // Sub-issues API may not be available
        }

        // 6. Find related releases (for closed issues, find releases published after close)
        let relatedReleases: Array<{
          tag_name: string;
          name: string;
          prerelease: boolean;
          published_at: string;
          url: string;
        }> = [];

        const issueState = issueData?.state ?? (ghIssue as Record<string, unknown> | null)?.state ?? "";
        if (issueState === "closed") {
          // Use updated_at as proxy for close time
          const closeTime = issueData?.updatedAt ?? "";
          if (closeTime) {
            try {
              const releasesRes = await store.fetch(
                new Request(
                  `http://store/releases-after?repo=${encodeURIComponent(repo)}&after=${encodeURIComponent(closeTime)}&limit=3`,
                ),
              );
              if (releasesRes.ok) {
                const releases = (await releasesRes.json()) as ReleaseRecord[];
                relatedReleases = releases.map((r) => ({
                  tag_name: r.tagName,
                  name: r.name,
                  prerelease: r.prerelease,
                  published_at: r.publishedAt,
                  url: `https://github.com/${repo}/releases/tag/${r.tagName}`,
                }));
              }
            } catch {
              // Non-critical
            }
          }
        }

        // 7. Aggregate result
        const result: Record<string, unknown> = {
          repo,
          number,
          title: issueData?.title ?? (ghIssue as Record<string, unknown> | null)?.title ?? "",
          body: (ghIssue as Record<string, unknown> | null)?.body ?? null,
          state: issueData?.state ?? (ghIssue as Record<string, unknown> | null)?.state ?? "",
          type: issueData?.type ?? (isPR ? "pull_request" : "issue"),
          labels: issueData?.labels ?? [],
          milestone: issueData?.milestone ?? "",
          assignees: issueData?.assignees ?? [],
          created_at: issueData?.createdAt ?? "",
          updated_at: issueData?.updatedAt ?? "",
          url: `https://github.com/${repo}/issues/${number}`,
          linked_prs: linkedPRs,
          branch: branchStatus,
          ci: ciStatus,
          sub_issues: subIssues,
          releases: relatedReleases,
        };

        if (apiFetchError) {
          result.api_error = apiFetchError;
        }

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    );

    // ── get_doc_content ─────────────────────────────────────────
    this.server.tool(
      "get_doc_content",
      "Retrieve the content of a document file (.md) from a GitHub repository. " +
        "Use this to read documents found via search_issues with type: \"doc\". " +
        "Returns the raw file content fetched from the repository.",
      {
        repo: z
          .string()
          .describe("Repository (owner/repo)"),
        path: z
          .string()
          .describe(
            "File path in the repository (e.g. \"docs/0-requirements.md\")",
          ),
        ref: z
          .string()
          .optional()
          .describe(
            "Git ref (branch, tag, or commit SHA) to fetch from. Defaults to the repository's default branch.",
          ),
      },
      async ({ repo, path, ref }) => {
        const token = this.getGitHubToken();
        const headers = githubHeaders(token);

        const url = new URL(`${GITHUB_API}/repos/${repo}/contents/${path}`);
        if (ref) {
          url.searchParams.set("ref", ref);
        }

        let response: Response;
        try {
          response = await fetch(url.toString(), { headers });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          console.error(
            `get_doc_content: network error fetching ${repo}/${path}: ${message}`,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to fetch document: network error — ${message}`,
              },
            ],
            isError: true,
          };
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          console.error(
            `get_doc_content: GitHub API returned ${response.status} for ${repo}/${path}: ${body}`,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to fetch document: HTTP ${response.status} — ${body}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await response.json()) as {
          content?: string;
          encoding?: string;
          name?: string;
          path?: string;
          size?: number;
          sha?: string;
          html_url?: string;
        };

        if (!data.content) {
          console.error(
            `get_doc_content: no content field in response for ${repo}/${path}`,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: "Document response did not contain file content. The path may point to a directory or an unsupported file type.",
              },
            ],
            isError: true,
          };
        }

        // GitHub returns base64-encoded content; decode via Uint8Array for UTF-8 safety
        const binary = atob(data.content.replace(/\n/g, ""));
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const decoded = new TextDecoder().decode(bytes);

        const result = {
          repo,
          path: data.path ?? path,
          sha: data.sha ?? "",
          size: data.size ?? 0,
          url: data.html_url ?? `https://github.com/${repo}/blob/main/${path}`,
          content: decoded,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    );

    // ── list_recent_activity ───────────────────────────────────
    this.server.tool(
      "list_recent_activity",
      "List recent issue/PR/release/documentation activity across tracked repositories. " +
        "Returns changes classified as created, updated, or closed.",
      {
        repo: z
          .string()
          .optional()
          .describe("Filter by repository (owner/repo)"),
        since: z
          .string()
          .optional()
          .describe(
            "ISO 8601 timestamp for activity start (default: 24 hours ago)",
          ),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe("Max results (default: 20, max: 100)"),
      },
      async ({ repo, since, limit }) => {
        const effectiveSince =
          since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const effectiveLimit = limit ?? 20;

        // Query IssueStore for recent activity
        const store = this.getStore();
        const params = new URLSearchParams();
        params.set("since", effectiveSince);
        params.set("limit", String(effectiveLimit));
        if (repo) {
          params.set("repo", repo);
        }

        const res = await store.fetch(
          new Request(`http://store/recent?${params.toString()}`),
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to fetch recent activity: ${res.status}`,
              },
            ],
            isError: true,
          };
        }

        const records = (await res.json()) as IssueRecord[];

        // Classify activity and format results
        const activities: Array<Record<string, unknown>> = records.map((record) => ({
          activity_type: classifyActivity(record, effectiveSince),
          number: record.number,
          title: record.title,
          type: record.type,
          state: record.state,
          labels: record.labels,
          repo: record.repo,
          url: `https://github.com/${record.repo}/issues/${record.number}`,
          updated_at: record.updatedAt,
          created_at: record.createdAt,
        }));

        // Fetch recent releases too
        const releaseParams = new URLSearchParams();
        releaseParams.set("since", effectiveSince);
        releaseParams.set("limit", String(effectiveLimit));
        if (repo) {
          releaseParams.set("repo", repo);
        }

        const releaseRes = await store.fetch(
          new Request(`http://store/recent-releases?${releaseParams.toString()}`),
        );

        if (releaseRes.ok) {
          const releases = (await releaseRes.json()) as ReleaseRecord[];
          for (const release of releases) {
            activities.push({
              activity_type: "created",
              number: 0,
              title: release.name || release.tagName,
              type: "release",
              state: "published",
              labels: [],
              repo: release.repo,
              tag_name: release.tagName,
              prerelease: release.prerelease,
              url: `https://github.com/${release.repo}/releases/tag/${release.tagName}`,
              updated_at: release.publishedAt,
              created_at: release.createdAt,
            });
          }
        }

        // Fetch recent docs too
        const docParams = new URLSearchParams();
        docParams.set("since", effectiveSince);
        docParams.set("limit", String(effectiveLimit));
        if (repo) {
          docParams.set("repo", repo);
        }

        const docRes = await store.fetch(
          new Request(`http://store/recent-docs?${docParams.toString()}`),
        );

        if (docRes.ok) {
          const docs = (await docRes.json()) as DocRecord[];
          for (const doc of docs) {
            activities.push({
              activity_type: "updated",
              number: 0,
              title: doc.path,
              type: "doc",
              state: "active",
              labels: [],
              repo: doc.repo,
              doc_path: doc.path,
              url: `https://github.com/${doc.repo}/blob/main/${doc.path}`,
              updated_at: doc.updatedAt,
              created_at: doc.updatedAt,
            });
          }
        }

        // Fetch recent commit diffs too
        const diffParams = new URLSearchParams();
        diffParams.set("since", effectiveSince);
        diffParams.set("limit", String(effectiveLimit));
        if (repo) {
          diffParams.set("repo", repo);
        }

        const diffRes = await store.fetch(
          new Request(`http://store/recent-diffs?${diffParams.toString()}`),
        );

        if (diffRes.ok) {
          const diffs = (await diffRes.json()) as DiffRecord[];
          for (const diff of diffs) {
            const shortSha = diff.commitSha.slice(0, 7);
            activities.push({
              activity_type: "updated",
              number: 0,
              title: `${shortSha} ${diff.filePath}`,
              type: "diff",
              state: "active",
              labels: [],
              repo: diff.repo,
              commit_sha: diff.commitSha,
              file_path: diff.filePath,
              file_status: diff.fileStatus,
              url: `https://github.com/${diff.repo}/commit/${diff.commitSha}`,
              updated_at: diff.commitDate,
              created_at: diff.indexedAt,
            });
          }
        }

        // Sort combined activities by updated_at descending and apply limit
        activities.sort((a, b) => {
          const aTime = (a.updated_at as string) ?? "";
          const bTime = (b.updated_at as string) ?? "";
          return bTime.localeCompare(aTime);
        });
        const limitedActivities = activities.slice(0, effectiveLimit);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: limitedActivities.length,
                  since: effectiveSince,
                  activities: limitedActivities,
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
}
