/**
 * Entity aggregation for the retrieval surface — collapse rows that point at
 * the same referent into one representative.
 *
 * Layer = L4 Operations (retrieval surface)
 *
 * Why this exists (issue #189 / #180 fact 2):
 * One underlying thing is indexed as several rows. A single file is a `doc` row
 * plus one `diff` row per commit that touched it; a single issue is an `issue`
 * row plus one `issue_comment` row per comment; a single PR is a `pull_request`
 * row plus its `pr_review` / `pr_review_comment` rows. All of them compete for
 * slots in the same `top_k` pool, so `top_k: 10` was measured returning roughly
 * 6 independent things. Keeping the diff rows indexed is deliberate (they are
 * the judgment history, and the commit-diff backup design saves storage), so
 * the collapse belongs at the presentation stage, not the index.
 *
 * What is a "same entity" (the load-bearing line):
 * The entity is the REFERENT a row points at, never the EVENT that produced the
 * row. Collapsing several versions of one referent cannot hide an independent
 * thing — the count of referents is unchanged. Collapsing by event would: one
 * commit touches several distinct files, and folding them into a single slot
 * hides files that are genuinely independent. So `file:` keys on the path and
 * NOT on the commit SHA, and issue #1317 / PR #1318 stay two entities even
 * though they are one unit of work (the `Closes #N` link that would join them
 * is not in the index, and putting it there is an index-side change).
 *
 * Out of scope: cross-repo duplication of the same Li+ source file (the same
 * SKILL.md copied into every user repo's `.claude/`). Deciding those are one
 * entity needs a content hash in the index or a path-normalizing heuristic —
 * the first is an index change, the second folds genuinely different files.
 * Tracked separately.
 */

/**
 * The fields of a resolved search row that the entity key is derived from.
 * Deliberately a narrow structural subset: the caller resolves them from
 * Vectorize metadata / the FTS row and passes the projection, so this module
 * stays free of retrieval-layer types and is unit-testable on plain objects.
 */
export interface EntityRow {
  /** Vectorize vector id — the per-row identity, used as the no-fold fallback. */
  vectorId: string;
  repo: string;
  type: string;
  /** Issue / PR number. 0 when the row type has none. */
  number: number;
  /** `doc` rows: repo-relative path of the document. */
  docPath?: string;
  /** `diff` rows: repo-relative path of the file inside the commit. */
  filePath?: string;
}

/** One entity: the highest-ranked row plus the rows collapsed into it. */
export interface EntityGroup<T> {
  key: string;
  representative: T;
  others: T[];
}

/**
 * Entity key for one row.
 *
 * - `file:{repo}:{path}` — a `doc` row and every `diff` row of the same file.
 *   The referent is the file; the commit is the event and is not in the key.
 * - `thread:{repo}:{number}` — an `issue` / `pull_request` row and its
 *   comments / reviews / inline review comments. Issues and PRs share one
 *   number space per repo, so the number alone is unambiguous.
 * - `row:{vectorId}` — everything else, and any row missing the field its
 *   class keys on. A unique key means the row never folds, which is the
 *   safe direction: a missed collapse costs a slot, a wrong collapse hides
 *   an independent result.
 *
 * `wiki_doc` and `release` rows fall through to `row:` on purpose. Each has
 * exactly one row per referent, so there is nothing to collapse, and keying
 * a wiki page into the `file:` namespace would risk folding it together with
 * a repo doc that happens to share its path.
 */
export function entityKey(row: EntityRow): string {
  switch (row.type) {
    case "doc":
    case "diff": {
      const path = (row.type === "doc" ? row.docPath : row.filePath) ?? "";
      if (path === "") break;
      return `file:${row.repo}:${path}`;
    }
    case "issue":
    case "pull_request":
    case "issue_comment":
    case "pr_review":
    case "pr_review_comment": {
      if (!row.number) break;
      return `thread:${row.repo}:${row.number}`;
    }
  }
  return `row:${row.vectorId}`;
}

/**
 * Group an already-ordered candidate list by entity key, preserving rank.
 *
 * The first row seen for a key becomes the representative, so the
 * representative is whatever the fusion / rerank / time sort put highest —
 * the newest version is NOT pinned. That is what keeps a "when did this
 * change" query answerable: for such a query the relevant old diff ranks
 * top, so it is the row that survives the collapse. Pinning the newest
 * version would delete the answer.
 *
 * Groups come back in representative order, so slicing to `top_k` yields
 * `top_k` independent entities.
 */
export function groupByEntity<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): Array<EntityGroup<T>> {
  const byKey = new Map<string, EntityGroup<T>>();
  const ordered: Array<EntityGroup<T>> = [];
  for (const row of rows) {
    const key = keyOf(row);
    const existing = byKey.get(key);
    if (existing) {
      existing.others.push(row);
      continue;
    }
    const group: EntityGroup<T> = { key, representative: row, others: [] };
    byKey.set(key, group);
    ordered.push(group);
  }
  return ordered;
}
