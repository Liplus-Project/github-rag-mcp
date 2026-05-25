/**
 * Shared result types reused across per-surface embed modules.
 *
 * Surface-specific result shapes (DiffUpsertResult, CommentUpsertResult) live
 * with their owning module. This file holds only the generic `UpsertResult`
 * used by issue / release / doc / wiki paths.
 */

/** Result of a single-item upsert operation */
export interface UpsertResult {
  /** Whether embedding was generated (vs skipped because hash unchanged) */
  embedded: boolean;
  /** Whether embedding was skipped because content hash matched existing record */
  skippedUnchanged: boolean;
  /** Whether Vectorize metadata was updated without re-embedding (state/labels/assignees change) */
  metadataUpdated: boolean;
  /** Whether embedding failed (item stored with empty bodyHash for retry) */
  failed: boolean;
}
