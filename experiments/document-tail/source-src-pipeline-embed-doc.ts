/**
 * Doc + wiki page embedding + upsert pipelines.
 *
 * Hosts both `processAndUpsertDoc` (repo docs, blob-SHA change detection done
 * by caller) and `processAndUpsertWikiDoc` (wiki pages, SHA-256 content hash
 * computed in-flow). Both surfaces share the same metadata shape and FTS5
 * column reuse pattern.
 */

import type { Env, DocRecord, WikiDocRecord } from "../types.js";
import { upsertFtsRow } from "../fts.js";
import { indexWikiEdges } from "../graph.js";
import { prepareEmbeddingInput, sha256Hex } from "./hash.js";
import { generateEmbedding } from "./embedding.js";
import { docVectorId, wikiDocVectorId } from "./vector-id.js";
import type { UpsertResult } from "./types.js";

/**
 * Process and upsert a single doc: embed content and upsert to Vectorize + Store.
 *
 * Unlike issues/releases, docs use blob SHA for change detection (handled by the caller).
 * This function always generates an embedding — the caller is responsible for determining
 * whether the doc content has changed.
 *
 * @param env - Worker env bindings (AI, VECTORIZE)
 * @param storeStub - Durable Object stub for IssueStore
 * @param repo - Repository in "owner/repo" format
 * @param path - File path within the repo (e.g. "docs/0-requirements.md")
 * @param content - Decoded file content
 * @param blobSha - Git blob SHA for this version of the file
 * @returns UpsertResult indicating what happened
 */
export async function processAndUpsertDoc(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  path: string,
  content: string,
  blobSha: string,
): Promise<UpsertResult> {
  const now = new Date().toISOString();

  try {
    // Generate embedding (use path as title, content as body)
    const embeddingInput = prepareEmbeddingInput(path, content);
    const embedding = await generateEmbedding(env.AI, embeddingInput);

    const metadata: Record<string, string | number> = {
      repo,
      number: 0,
      type: "doc",
      state: "active",
      labels: "",
      milestone: "",
      assignees: "",
      updated_at: now,
      doc_path: path,
    };

    // Upsert vector into Vectorize
    const dvid = await docVectorId(repo, path);
    await env.VECTORIZE.upsert([
      {
        id: dvid,
        values: embedding,
        metadata,
      },
    ]);

    // Mirror into D1 FTS5 sparse index.
    try {
      await upsertFtsRow(env.DB_FTS, {
        vectorId: dvid,
        repo,
        type: "doc",
        state: "active",
        labels: "",
        milestone: "",
        assignees: "",
        updatedAt: now,
        docPath: path,
        content: embeddingInput,
      });
    } catch (ftsErr) {
      console.error(
        `Failed to upsert FTS5 row for doc ${repo}/${path}:`,
        ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
      );
    }

    // Upsert doc record into store
    const record: DocRecord = {
      repo,
      path,
      blobSha,
      updatedAt: now,
    };

    await storeStub.fetch(
      new Request("http://store/upsert-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }),
    );

    return { embedded: true, skippedUnchanged: false, metadataUpdated: false, failed: false };
  } catch (err) {
    console.error(
      `Failed to embed doc ${repo}/${path}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { embedded: false, skippedUnchanged: false, metadataUpdated: false, failed: true };
  }
}

// ── Wiki doc surface ─────────────────────────────────────────

/**
 * Embed and upsert a single wiki page.
 *
 * Mirrors `processAndUpsertDoc` but writes vector / FTS / store records under
 * the `wiki_doc` type. Vector ID prefix `"w:"` keeps wiki rows in their own
 * namespace so they never collide with repo doc rows even when page name and
 * doc path coincide.
 *
 * @param env         Worker env bindings (AI, VECTORIZE, DB_FTS)
 * @param storeStub   Durable Object stub for IssueStore
 * @param repo        Repository in "owner/repo" format (the wiki belongs to {repo}.wiki)
 * @param pageName    GitHub Wiki page slug (dash-separated, e.g., "Home" or "Foo-Bar")
 * @param extension   Markup file extension that serves the page (e.g., "md", "markdown", "org")
 * @param content     Raw markup content fetched from raw.githubusercontent.com/wiki
 * @returns UpsertResult indicating what happened
 */
export async function processAndUpsertWikiDoc(
  env: Env,
  storeStub: DurableObjectStub,
  repo: string,
  pageName: string,
  extension: string,
  content: string,
): Promise<UpsertResult> {
  const now = new Date().toISOString();

  try {
    // Generate embedding (use page name as title surrogate, content as body)
    const embeddingInput = prepareEmbeddingInput(pageName, content);
    const embedding = await generateEmbedding(env.AI, embeddingInput);

    const metadata: Record<string, string | number> = {
      repo,
      number: 0,
      type: "wiki_doc",
      state: "active",
      labels: "",
      milestone: "",
      assignees: "",
      updated_at: now,
      wiki_path: pageName,
      wiki_extension: extension,
    };

    const wvid = await wikiDocVectorId(repo, pageName);
    await env.VECTORIZE.upsert([
      {
        id: wvid,
        values: embedding,
        metadata,
      },
    ]);

    // Mirror into D1 FTS5. We reuse the existing `doc_path` column to store
    // the wiki page slug — semantically the same kind of "where did this come
    // from" field, distinguished by the row's `type='wiki_doc'`.
    try {
      await upsertFtsRow(env.DB_FTS, {
        vectorId: wvid,
        repo,
        type: "wiki_doc",
        state: "active",
        labels: "",
        milestone: "",
        assignees: "",
        updatedAt: now,
        docPath: pageName,
        content: embeddingInput,
      });
    } catch (ftsErr) {
      console.error(
        `Failed to upsert FTS5 row for wiki ${repo}/${pageName}:`,
        ftsErr instanceof Error ? ftsErr.message : String(ftsErr),
      );
    }

    // Extract + index graph "mention" edges to other wiki pages in this repo.
    // Additive: the default retrieval path never reads these. Failures here must
    // not break indexing of the page itself.
    try {
      await indexWikiEdges(env.DB_FTS, repo, pageName, wvid, content);
    } catch (edgeErr) {
      console.error(
        `Failed to index graph edges for wiki ${repo}/${pageName}:`,
        edgeErr instanceof Error ? edgeErr.message : String(edgeErr),
      );
    }

    const contentHash = await sha256Hex(content);
    const record: WikiDocRecord = {
      repo,
      pageName,
      extension,
      contentHash,
      updatedAt: now,
    };

    await storeStub.fetch(
      new Request("http://store/upsert-wiki-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }),
    );

    return { embedded: true, skippedUnchanged: false, metadataUpdated: false, failed: false };
  } catch (err) {
    console.error(
      `Failed to embed wiki doc ${repo}/${pageName}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { embedded: false, skippedUnchanged: false, metadataUpdated: false, failed: true };
  }
}
