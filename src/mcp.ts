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
import type { Env, IssueRecord, ReleaseRecord, DocRecord, VectorMetadata } from "./types.js";
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
      "Semantic search for GitHub issues, PRs, releases, and repository documentation combined with structured filters. " +
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
          .enum(["issue", "pull_request", "release", "doc", "all"])
          .optional()
          .default("all")
          .describe("Filter by type (default: all)"),
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

        // Labels and assignees cannot be pre-filtered via Vectorize because:
        //   - They are multi-valued (an issue can have many labels / assignees)
        //   - Stored in individual slots (label_0..3, assignee_0..1) but a given
        //     label can land in any slot depending on sort order
        //   - Vectorize filters only support AND between fields, not OR across them
        //     (e.g., "label_0 = 'bug' OR label_1 = 'bug'" is not expressible)
        //
        // Strategy: overfetch from Vectorize when post-filters are active,
        // then apply label/assignee filters client-side on the larger result set.
        // This significantly improves recall vs. the previous fixed-topK approach.
        const requestedTopK = top_k ?? 10;
        const needsPostFilter = (labels && labels.length > 0) || !!assignee;
        const internalTopK = needsPostFilter
          ? Math.min(requestedTopK * 5, 50)
          : requestedTopK;

        // 3. Query Vectorize with potentially larger topK
        const vectorizeFilter: VectorizeVectorMetadataFilter | undefined =
          Object.keys(filter).length > 0 ? filter : undefined;

        const results = await this.env.VECTORIZE.query(embedding, {
          topK: internalTopK,
          filter: vectorizeFilter,
          returnMetadata: "all",
        });

        // 4. Post-filter for labels (AND) and assignee
        // Uses both expanded fields (label_0..3, assignee_0..1) and the
        // comma-separated fallback fields for overflow (5th+ label, 3rd+ assignee).
        let matches = results.matches;
        if (labels && labels.length > 0) {
          matches = matches.filter((m) => {
            const meta = m.metadata as unknown as VectorMetadata | undefined;
            if (!meta) return false;
            // Collect all labels from expanded fields + comma-separated fallback
            const expandedLabels = [
              meta.label_0, meta.label_1, meta.label_2, meta.label_3,
            ].filter((l): l is string => !!l);
            const csvLabels = meta.labels
              ? meta.labels.split(",").map((l) => l.trim()).filter(Boolean)
              : [];
            const allLabels = new Set([...expandedLabels, ...csvLabels]);
            return labels.every((l) => allLabels.has(l));
          });
        }
        if (assignee) {
          matches = matches.filter((m) => {
            const meta = m.metadata as unknown as VectorMetadata | undefined;
            if (!meta) return false;
            // Check expanded fields first, then comma-separated fallback
            if (meta.assignee_0 === assignee || meta.assignee_1 === assignee) {
              return true;
            }
            if (meta.assignees) {
              const csvAssignees = meta.assignees.split(",").map((a) => a.trim());
              return csvAssignees.includes(assignee);
            }
            return false;
          });
        }

        // Trim to originally requested topK after post-filtering
        matches = matches.slice(0, requestedTopK);

        // 5. Format results
        const items = matches.map((m) => {
          const meta = m.metadata as unknown as VectorMetadata | undefined;
          const itemRepo = meta?.repo ?? "";
          const number = meta?.number ?? 0;
          const itemType = meta?.type ?? "";
          const tagName = meta?.tag_name ?? "";
          const docPath = meta?.doc_path ?? "";

          // Build URL based on type
          let url: string;
          if (itemType === "release" && tagName) {
            url = `https://github.com/${itemRepo}/releases/tag/${tagName}`;
          } else if (itemType === "doc" && docPath) {
            url = `https://github.com/${itemRepo}/blob/main/${docPath}`;
          } else {
            url = `https://github.com/${itemRepo}/issues/${number}`;
          }

          return {
            number,
            title: "", // Enriched below
            state: meta?.state ?? "",
            type: itemType,
            labels: meta?.labels ? meta.labels.split(",").filter(Boolean) : [],
            milestone: meta?.milestone ?? "",
            assignees: meta?.assignees
              ? meta.assignees.split(",").filter(Boolean)
              : [],
            score: m.score,
            url,
            updated_at: meta?.updated_at ?? "",
            repo: itemRepo,
            ...(itemType === "release" ? { tag_name: tagName } : {}),
            ...(itemType === "doc" ? { doc_path: docPath } : {}),
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
