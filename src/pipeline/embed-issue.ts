/**
 * Issue / pull request embedding + upsert pipeline.
 *
 * Owns the GitHub issue / PR data shape (`GitHubIssueData`) and the
 * `processAndUpsertIssue` flow: hash-based change detection, metadata-only
 * Vectorize + D1 refresh when only labels / state changed, and full embed +
 * upsert when the body changed.
 *
 * Mirror-failure handling differs per path, because what makes a retry happen
 * differs. On the embed path a failed FTS5 write is best-effort: the stored
 * bodyHash is what drives the next attempt, and the next body change reconciles
 * the sparse side. On the metadata-only path there is no next body change to
 * wait for, so a failed mirror write holds the IssueStore baseline instead —
 * that record is the diff basis, and advancing it would make the miss permanent
 * (issue #209).
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

/** Per-call overrides for `processAndUpsertIssue`. */
export interface ProcessIssueOptions {
  /** Embed and re-upsert even when the stored hash matches.
   *
   *  The hash check answers "did the body change", which is the wrong question
   *  when a retrieval surface is known to be missing the item: an embed whose
   *  FTS5 mirror failed leaves the hash stored and the sparse row absent, and no
   *  later poll reconciles it because the diff basis already matches. Only the
   *  index backfill sets this (issue #210); the poll and webhook paths must keep
   *  the hash check, or every run would re-embed the whole repository. */
  force?: boolean;
}

/**
 * Process and upsert a single issue/PR: check hash, embed if changed, upsert to Vectorize + Store.
 *
 * @param env - Worker env bindings (AI, VECTORIZE)
 * @param storeStub - Durable Object stub for IssueStore
 * @param repo - Repository in "owner/repo" format
 * @param issue - GitHub issue/PR data
 * @param options - per-call overrides (see `ProcessIssueOptions`)
 * @returns UpsertResult indicating what happened
 */
export async function processAndUpsertIssue(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  issue: GitHubIssueData,
  options: ProcessIssueOptions = {},
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
    if (existing.bodyHash === bodyHash && options.force !== true) {
      needsEmbedding = false;
    }
  }

  if (!needsEmbedding) {
    // Hash matched — skip embedding, but state / labels / milestone / assignees may
    // still have changed and the retrieval surfaces have to follow.
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

    // Check if metadata changed — if so, the dense and sparse sides need updating
    // (Vectorize / search_docs state, labels, assignees must stay in sync with GitHub).
    const sortedLabels = [...labelNames].sort();
    const metadataChanged = existing !== null && (
      existing.state !== issue.state ||
      existing.title !== title ||
      [...existing.labels].sort().join(",") !== sortedLabels.join(",") ||
      existing.milestone !== milestoneTitle ||
      [...existing.assignees].sort().join(",") !== [...assigneeLogins].sort().join(",")
    );

    // The IssueStore record is the *baseline* `metadataChanged` is measured against, so
    // it must not advance until the mirrors it guards have landed. Advancing it first
    // made a failed mirror write permanent: the next poll compares GitHub against an
    // already-updated baseline, sees no diff, and never retries. A body change would
    // reconcile it, but a state-only change never brings one (issue #209).
    let mirrorFailed = false;

    if (metadataChanged) {
      const vid = await vectorId(repo, issue.number);

      // Dense side. A row with no vector is the #210 (missing index entry) surface,
      // not a mirror failure — nothing here can rebuild it without embedding, so it
      // must not hold the baseline hostage.
      try {
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
        }
      } catch (err) {
        console.error(
          `Failed to update Vectorize metadata for ${repo}#${issue.number}:`,
          err instanceof Error ? err.message : String(err),
        );
        mirrorFailed = true;
      }

      // Sparse side. Deliberately outside the dense branch above: the two stores fail
      // independently, and nesting this call inside "the vector exists" skipped the
      // sparse state update for exactly the rows that were already missing a vector.
      // Content stays the same (no body change); only the filterable columns move.
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
        mirrorFailed = true;
      }
    }

    if (mirrorFailed) {
      // Baseline held on purpose: the stale IssueStore record is what makes the next
      // poll / webhook delivery for this item detect the diff again and retry.
      console.warn(
        `Holding IssueStore baseline for ${repo}#${issue.number} so the metadata mirror is retried`,
      );
      return {
        embedded: false,
        skippedUnchanged: false,
        metadataUpdated: false,
        failed: true,
      };
    }

    await storeStub.fetch(
      new Request("http://store/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }),
    );

    return {
      embedded: false,
      skippedUnchanged: !metadataChanged,
      metadataUpdated: metadataChanged,
      failed: false,
    };
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
