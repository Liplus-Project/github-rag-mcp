/**
 * Release embedding + upsert pipeline.
 *
 * Owns the GitHub release data shape (`GitHubReleaseData`) and the
 * `processAndUpsertRelease` flow: hash-based change detection,
 * Vectorize upsert under the "r" prefix, and FTS5 mirror writes.
 */

import type { Env, ReleaseRecord } from "../types.js";
import { upsertFtsRow } from "../fts.js";
import { computeBodyHash, prepareEmbeddingInput } from "./hash.js";
import { generateEmbedding } from "./embedding.js";
import { releaseVectorId } from "./vector-id.js";
import type { UpsertResult } from "./types.js";

/** GitHub API release response shape (subset of fields we need) */
export interface GitHubReleaseData {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  html_url: string;
}

/**
 * Process and upsert a single release: check hash, embed if changed, upsert to Vectorize + Store.
 *
 * @param env - Worker env bindings (AI, VECTORIZE)
 * @param storeStub - Durable Object stub for IssueStore
 * @param repo - Repository in "owner/repo" format
 * @param release - GitHub release data
 * @returns UpsertResult indicating what happened
 */
export async function processAndUpsertRelease(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  release: GitHubReleaseData,
): Promise<UpsertResult> {
  const body = release.body ?? "";
  const name = release.name ?? release.tag_name;
  const bodyHash = await computeBodyHash(name, body);

  // Check if release body has changed
  const existingResp = await storeStub.fetch(
    new Request(
      `http://store/release?repo=${encodeURIComponent(repo)}&tag_name=${encodeURIComponent(release.tag_name)}`,
    ),
  );

  let needsEmbedding = true;
  if (existingResp.ok) {
    const existing = (await existingResp.json()) as ReleaseRecord;
    if (existing.bodyHash === bodyHash) {
      needsEmbedding = false;
    }
  }

  if (!needsEmbedding) {
    // Hash matched — store record but skip embedding
    const record: ReleaseRecord = {
      repo,
      tagName: release.tag_name,
      name,
      body,
      prerelease: release.prerelease,
      bodyHash,
      createdAt: release.created_at,
      publishedAt: release.published_at ?? release.created_at,
    };

    await storeStub.fetch(
      new Request("http://store/upsert-release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }),
    );

    return { embedded: false, skippedUnchanged: true, metadataUpdated: false, failed: false };
  }

  // Content changed — generate embedding
  let embeddingSucceeded = false;
  try {
    const embeddingInput = prepareEmbeddingInput(name, body);
    const embedding = await generateEmbedding(env.AI, embeddingInput);

    const metadata: Record<string, string | number> = {
      repo,
      number: 0,
      type: "release",
      state: "published",
      labels: "",
      milestone: "",
      assignees: "",
      updated_at: release.published_at ?? release.created_at,
      tag_name: release.tag_name,
    };

    const rvid = await releaseVectorId(repo, release.tag_name);
    await env.VECTORIZE.upsert([
      {
        id: rvid,
        values: embedding,
        metadata,
      },
    ]);

    // Mirror into D1 FTS5 sparse index.
    try {
      await upsertFtsRow(env.DB_FTS, {
        vectorId: rvid,
        repo,
        type: "release",
        state: "published",
        labels: "",
        milestone: "",
        assignees: "",
        updatedAt: release.published_at ?? release.created_at,
        tagName: release.tag_name,
        content: embeddingInput,
      });
    } catch (ftsErr) {
      console.error(
        `Failed to upsert FTS5 row for release ${repo}#${release.tag_name}:`,
        ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
      );
    }

    embeddingSucceeded = true;
  } catch (err) {
    console.error(
      `Failed to embed release ${repo}#${release.tag_name}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Store record
  const record: ReleaseRecord = {
    repo,
    tagName: release.tag_name,
    name,
    body,
    prerelease: release.prerelease,
    bodyHash: embeddingSucceeded ? bodyHash : "",
    createdAt: release.created_at,
    publishedAt: release.published_at ?? release.created_at,
  };

  await storeStub.fetch(
    new Request("http://store/upsert-release", {
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
