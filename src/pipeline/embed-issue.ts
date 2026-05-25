/**
 * Issue / pull request embedding + upsert pipeline.
 *
 * Owns the GitHub issue / PR data shape (`GitHubIssueData`) and the
 * `processAndUpsertIssue` flow: hash-based change detection, metadata-only
 * Vectorize refresh when only labels / state changed, and full embed + upsert
 * when the body changed. FTS5 mirror writes are best-effort.
 */

import type { Env, IssueRecord } from "../types.js";
import { upsertFtsRow } from "../fts.js";
import { computeBodyHash, prepareEmbeddingInput } from "./hash.js";
import { generateEmbedding } from "./embedding.js";
import { vectorId } from "./vector-id.js";
import type { UpsertResult } from "./types.js";

/** GitHub API issue/PR response shape (subset of fields we need) */
export interface GitHubIssueData {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  milestone: { title: string } | null;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  pull_request?: { url: string };
  html_url: string;
}

/**
 * Process and upsert a single issue/PR: check hash, embed if changed, upsert to Vectorize + Store.
 *
 * @param env - Worker env bindings (AI, VECTORIZE)
 * @param storeStub - Durable Object stub for IssueStore
 * @param repo - Repository in "owner/repo" format
 * @param issue - GitHub issue/PR data
 * @returns UpsertResult indicating what happened
 */
export async function processAndUpsertIssue(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  issue: GitHubIssueData,
): Promise<UpsertResult> {
  const body = issue.body ?? "";
  const title = issue.title;
  const bodyHash = await computeBodyHash(title, body);

  const type: IssueRecord["type"] = issue.pull_request
    ? "pull_request"
    : "issue";

  // Check if body has changed by comparing hash with stored value
  const existingResp = await storeStub.fetch(
    new Request(
      `http://store/issue?repo=${encodeURIComponent(repo)}&number=${issue.number}`,
    ),
  );

  let needsEmbedding = true;
  let existing: IssueRecord | null = null;
  if (existingResp.ok) {
    existing = (await existingResp.json()) as IssueRecord;
    if (existing.bodyHash === bodyHash) {
      needsEmbedding = false;
    }
  }

  if (!needsEmbedding) {
    // Hash matched — skip embedding but update IssueStore (metadata may have changed)
    const labelNames = issue.labels.map((l) => l.name);
    const assigneeLogins = issue.assignees.map((a) => a.login);
    const milestoneTitle = issue.milestone?.title ?? "";

    const record: IssueRecord = {
      repo,
      number: issue.number,
      type,
      state: issue.state,
      title,
      labels: labelNames,
      milestone: milestoneTitle,
      assignees: assigneeLogins,
      bodyHash,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    };

    await storeStub.fetch(
      new Request("http://store/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }),
    );

    // Check if metadata changed — if so, update Vectorize metadata too
    // (Vectorize state/labels/assignees must stay in sync with GitHub)
    const sortedLabels = [...labelNames].sort();
    const metadataChanged = existing !== null && (
      existing.state !== issue.state ||
      existing.title !== title ||
      [...existing.labels].sort().join(",") !== sortedLabels.join(",") ||
      existing.milestone !== milestoneTitle ||
      [...existing.assignees].sort().join(",") !== [...assigneeLogins].sort().join(",")
    );

    if (metadataChanged) {
      try {
        // Retrieve existing vector values to re-upsert with updated metadata
        const vid = await vectorId(repo, issue.number);
        const vectors = await env.VECTORIZE.getByIds([vid]);

        if (vectors.length > 0 && vectors[0].values) {
          const metadata: Record<string, string | number> = {
            repo,
            number: issue.number,
            type,
            state: issue.state,
            labels: sortedLabels.join(","),
            milestone: milestoneTitle,
            assignees: assigneeLogins.join(","),
            updated_at: issue.updated_at,
            label_0: sortedLabels[0] ?? "",
            label_1: sortedLabels[1] ?? "",
            label_2: sortedLabels[2] ?? "",
            label_3: sortedLabels[3] ?? "",
            assignee_0: assigneeLogins[0] ?? "",
            assignee_1: assigneeLogins[1] ?? "",
          };

          await env.VECTORIZE.upsert([
            {
              id: vid,
              values: vectors[0].values as number[],
              metadata,
            },
          ]);

          // Mirror the metadata change onto D1 FTS5 so sparse retrieval stays filterable.
          // Content stays the same (no body change), but labels/state/milestone etc.
          // on the sparse side must match the dense side for pre-filter consistency.
          try {
            await upsertFtsRow(env.DB_FTS, {
              vectorId: vid,
              repo,
              type,
              state: issue.state,
              labels: sortedLabels.join(","),
              milestone: milestoneTitle,
              assignees: assigneeLogins.join(","),
              updatedAt: issue.updated_at,
              number: issue.number,
              content: prepareEmbeddingInput(title, issue.body),
            });
          } catch (ftsErr) {
            console.error(
              `Failed to update FTS5 metadata for ${repo}#${issue.number}:`,
              ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
            );
            // Non-fatal: sparse side will catch up on next body change.
          }

          return { embedded: false, skippedUnchanged: false, metadataUpdated: true, failed: false };
        }
      } catch (err) {
        console.error(
          `Failed to update Vectorize metadata for ${repo}#${issue.number}:`,
          err instanceof Error ? err.message : String(err),
        );
        // IssueStore was already updated — Vectorize metadata will catch up on next body change
      }
    }

    return { embedded: false, skippedUnchanged: true, metadataUpdated: false, failed: false };
  }

  // Content changed — generate embedding
  let embeddingSucceeded = false;
  try {
    const embeddingInput = prepareEmbeddingInput(title, issue.body);
    const embedding = await generateEmbedding(env.AI, embeddingInput);

    // Expand labels into individual metadata fields (first 4, sorted)
    // for potential Vectorize pre-filtering. Sorted order ensures deterministic
    // slot assignment across upserts.
    const labelNames = issue.labels.map((l) => l.name).sort();
    const assigneeLogins = issue.assignees.map((a) => a.login);

    const metadata: Record<string, string | number> = {
      repo,
      number: issue.number,
      type,
      state: issue.state,
      labels: labelNames.join(","),
      milestone: issue.milestone?.title ?? "",
      assignees: assigneeLogins.join(","),
      updated_at: issue.updated_at,
      // Expanded label fields (first 4, sorted alphabetically)
      label_0: labelNames[0] ?? "",
      label_1: labelNames[1] ?? "",
      label_2: labelNames[2] ?? "",
      label_3: labelNames[3] ?? "",
      // Expanded assignee fields (first 2)
      assignee_0: assigneeLogins[0] ?? "",
      assignee_1: assigneeLogins[1] ?? "",
    };

    const vid = await vectorId(repo, issue.number);
    await env.VECTORIZE.upsert([
      {
        id: vid,
        values: embedding,
        metadata,
      },
    ]);

    // Mirror the same content into D1 FTS5 for sparse (BM25) retrieval.
    // Failure here does not invalidate the Vectorize upsert — we still consider the
    // embedding successful and rely on the next run to reconcile the sparse side.
    try {
      await upsertFtsRow(env.DB_FTS, {
        vectorId: vid,
        repo,
        type,
        state: issue.state,
        labels: labelNames.join(","),
        milestone: issue.milestone?.title ?? "",
        assignees: assigneeLogins.join(","),
        updatedAt: issue.updated_at,
        number: issue.number,
        content: embeddingInput,
      });
    } catch (ftsErr) {
      console.error(
        `Failed to upsert FTS5 row for ${repo}#${issue.number}:`,
        ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
      );
    }

    embeddingSucceeded = true;
  } catch (err) {
    console.error(
      `Failed to embed ${repo}#${issue.number}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Store record — save bodyHash only when embedding succeeded.
  // When embedding fails, store empty bodyHash so next attempt retries.
  const record: IssueRecord = {
    repo,
    number: issue.number,
    type,
    state: issue.state,
    title,
    labels: issue.labels.map((l) => l.name),
    milestone: issue.milestone?.title ?? "",
    assignees: issue.assignees.map((a) => a.login),
    bodyHash: embeddingSucceeded ? bodyHash : "",
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };

  await storeStub.fetch(
    new Request("http://store/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    }),
  );

  return {
    embedded: embeddingSucceeded,
    skippedUnchanged: false,
    metadataUpdated: false,
    failed: !embeddingSucceeded,
  };
}
