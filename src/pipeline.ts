/**
 * Shared embedding pipeline — reusable by both the cron poller and webhook handler.
 *
 * Provides per-item embedding + upsert functions for issues/PRs, releases, and docs.
 * The cron poller calls these in a batch loop; the webhook handler calls them for
 * individual items as events arrive.
 *
 * Barrel re-export over the per-surface modules under `./pipeline/`. Consumers
 * (`./poller.ts` and `./webhook.ts`) keep importing from `./pipeline.js`; the
 * surface split is internal to this directory.
 */

export * from "./pipeline/ingest-filter.js";
export * from "./pipeline/embedding.js";
export * from "./pipeline/hash.js";
export * from "./pipeline/vector-id.js";
export * from "./pipeline/types.js";
export * from "./pipeline/embed-issue.js";
export * from "./pipeline/embed-release.js";
export * from "./pipeline/embed-doc.js";
export * from "./pipeline/embed-diff.js";
export * from "./pipeline/embed-comment.js";
