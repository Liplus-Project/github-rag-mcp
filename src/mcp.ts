/**
 * RagMcpAgent — MCP server Durable Object exposing semantic search tools.
 *
 * Tools:
 *   search_issues       — semantic + structured search via Vectorize + Workers AI
 *   get_issue_context   — aggregated issue view with related PRs, branch, CI
 *   list_recent_activity — recent changes across tracked repositories
 *
 * Extends McpAgent from "agents/mcp" (same pattern as github-webhook-mcp).
 * Per-user: each authenticated user gets their own DO instance via
 * idFromName("user-{githubUserId}").
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, IssueRecord, VectorMetadata } from "./types.js";
import type { GitHubUserProps } from "./oauth.js";

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
      "Semantic search for GitHub issues and PRs combined with structured filters. " +
        "Uses embedding similarity (BGE-M3) with optional metadata filters.",
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
          .enum(["issue", "pull_request", "all"])
          .optional()
          .default("all")
          .describe("Filter by type"),
        top_k: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Max results (default: 10, max: 50)"),
      },
      async ({ query, repo, state, labels, milestone, assignee, type, top_k }) => {
        // 1. Generate embedding for query via Workers AI (BGE-M3)
        const aiResult = await this.env.AI.run("@cf/baai/bge-m3", {
          text: [query],
        });
        const vectors = (aiResult as { data: Array<number[]> }).data;
        if (!vectors || vectors.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "Failed to generate embedding for query" },
            ],
            isError: true,
          };
        }
        const embedding = vectors[0];

        // 2. Build Vectorize metadata filter from structured params
        const filter: VectorizeVectorMetadataFilter = {};
        if (repo) {
          filter["repo"] = { $eq: repo };
        }
        if (state && state !== "all") {
          filter["state"] = { $eq: state };
        }
        if (type && type !== "all") {
          filter["type"] = { $eq: type };
        }
        if (milestone) {
          filter["milestone"] = { $eq: milestone };
        }
        if (assignee) {
          // assignees is comma-separated in metadata; use $eq for single assignee match
          filter["assignees"] = { $eq: assignee };
        }
        // Labels: Vectorize metadata stores labels as comma-separated string.
        // For AND logic with multiple labels, we filter client-side after query.
        // For single label, use $eq on the labels field (partial match not supported by Vectorize).

        // 3. Query Vectorize
        const vectorizeFilter: VectorizeVectorMetadataFilter | undefined =
          Object.keys(filter).length > 0 ? filter : undefined;

        const results = await this.env.VECTORIZE.query(embedding, {
          topK: top_k ?? 10,
          filter: vectorizeFilter,
          returnMetadata: "all",
        });

        // 4. Post-filter for labels (AND logic: all requested labels must be present)
        let matches = results.matches;
        if (labels && labels.length > 0) {
          matches = matches.filter((m) => {
            const meta = m.metadata as unknown as VectorMetadata | undefined;
            if (!meta?.labels) return false;
            const itemLabels = meta.labels.split(",").map((l) => l.trim());
            return labels.every((l) => itemLabels.includes(l));
          });
        }

        // 5. Format results
        const items = matches.map((m) => {
          const meta = m.metadata as unknown as VectorMetadata | undefined;
          const itemRepo = meta?.repo ?? "";
          const number = meta?.number ?? 0;
          return {
            number,
            title: "", // Title not stored in Vectorize metadata; enriched below
            state: meta?.state ?? "",
            type: meta?.type ?? "",
            labels: meta?.labels ? meta.labels.split(",").filter(Boolean) : [],
            milestone: meta?.milestone ?? "",
            assignees: meta?.assignees
              ? meta.assignees.split(",").filter(Boolean)
              : [],
            score: m.score,
            url: `https://github.com/${itemRepo}/issues/${number}`,
            updated_at: meta?.updated_at ?? "",
            repo: itemRepo,
          };
        });

        // Enrich with titles from IssueStore
        const store = this.getStore();
        for (const item of items) {
          if (item.repo && item.number) {
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
                { count: items.length, results: items },
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
        try {
          const issueRes = await fetch(
            `${GITHUB_API}/repos/${repo}/issues/${number}`,
            { headers },
          );
          if (issueRes.ok) {
            ghIssue = (await issueRes.json()) as Record<string, unknown>;
          }
        } catch {
          // Continue with IssueStore data if API fails
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

        // 6. Aggregate result
        const result = {
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
      "List recent issue/PR activity across tracked repositories. " +
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
        const activities = records.map((record) => ({
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

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: activities.length,
                  since: effectiveSince,
                  activities,
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
