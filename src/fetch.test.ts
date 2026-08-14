/**
 * Unit tests for the fetch-mode item assembly (issue #239).
 *
 * `buildFetchItem` is the half that decides what a caller can tell about the
 * text it gets back: which columns are meaningful for the row's type, and
 * whether the content is a whole body or a prefix. The D1 read around it is
 * exercised against a real database in `fetch.workers.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { buildFetchItem, FETCH_CONTENT_MAX_CHARS } from "./fetch.js";
import { MAX_EMBEDDING_INPUT_CHARS } from "./pipeline/embedding.js";

/** A `search_docs` row as `getDocsByVectorIds` returns it. */
function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    repo: "o/r",
    type: "issue",
    state: "open",
    number: 7,
    updated_at: "2026-01-01T00:00:00Z",
    content: "title\n\nbody",
    tag_name: "",
    doc_path: "",
    commit_sha: "",
    file_path: "",
    file_status: "",
    commit_date: "",
    commit_author: "",
    ...overrides,
  };
}

describe("buildFetchItem: content provenance", () => {
  it("reports the ingest ceiling so the caller can act on it", () => {
    // The ceiling is the pipeline's, not a constant this module invented: a
    // change to the embedding input limit must move both together or the flag
    // starts lying about a limit that no longer applies.
    expect(FETCH_CONTENT_MAX_CHARS).toBe(MAX_EMBEDDING_INPUT_CHARS);
  });

  it("marks a body short of the ceiling as whole", () => {
    const item = buildFetchItem("i:1", row({ content: "x".repeat(100) }));
    expect(item.content_chars).toBe(100);
    expect(item.content_truncated).toBe(false);
  });

  it("marks a body at the ceiling as truncated", () => {
    const item = buildFetchItem(
      "i:2",
      row({ content: "x".repeat(MAX_EMBEDDING_INPUT_CHARS) }),
    );
    expect(item.content_chars).toBe(MAX_EMBEDDING_INPUT_CHARS);
    // Safer side: a natural body of exactly this length reads as truncated, so
    // the caller re-reads something whole rather than trusting a prefix.
    expect(item.content_truncated).toBe(true);
  });

  it("counts characters, not bytes, so multi-byte bodies are not over-reported", () => {
    const item = buildFetchItem("i:3", row({ content: "判断記録" }));
    expect(item.content).toBe("判断記録");
    expect(item.content_chars).toBe(4);
    expect(item.content_truncated).toBe(false);
  });

  it("returns an empty body rather than throwing when the column is absent", () => {
    const item = buildFetchItem("i:4", { type: "issue" });
    expect(item.content).toBe("");
    expect(item.content_chars).toBe(0);
    expect(item.content_truncated).toBe(false);
    expect(item.repo).toBe("");
  });
});

describe("buildFetchItem: per-type identity fields", () => {
  it("carries the vector_id it was asked for", () => {
    expect(buildFetchItem("i:5", row({})).vector_id).toBe("i:5");
  });

  it("attaches nothing type-specific to an issue row", () => {
    const item = buildFetchItem("i:6", row({ type: "issue" }));
    expect(item.number).toBe(7);
    expect(item.doc_path).toBeUndefined();
    expect(item.commit_sha).toBeUndefined();
    expect(item.tag_name).toBeUndefined();
  });

  it("attaches tag_name to a release row", () => {
    const item = buildFetchItem("r:1", row({ type: "release", tag_name: "v1.2.3" }));
    expect(item.tag_name).toBe("v1.2.3");
    expect(item.doc_path).toBeUndefined();
  });

  it("attaches doc_path to a doc row", () => {
    const item = buildFetchItem("d:1", row({ type: "doc", doc_path: "docs/0-requirements.md" }));
    expect(item.doc_path).toBe("docs/0-requirements.md");
    expect(item.wiki_path).toBeUndefined();
  });

  it("reads a wiki_doc slug out of the shared doc_path column", () => {
    // wiki_doc reuses `doc_path` for the page slug at the schema level; the
    // row's `type` is what separates the two surfaces.
    const item = buildFetchItem("w:1", row({ type: "wiki_doc", doc_path: "Decision-Structure" }));
    expect(item.wiki_path).toBe("Decision-Structure");
    expect(item.doc_path).toBeUndefined();
  });

  it("attaches the commit locator to a diff row", () => {
    const item = buildFetchItem(
      "f:1",
      row({
        type: "diff",
        commit_sha: "6acdbd3",
        file_path: "src/mcp.ts",
        file_status: "modified",
        commit_date: "2026-02-02T00:00:00Z",
        commit_author: "smileygames",
      }),
    );
    expect(item.commit_sha).toBe("6acdbd3");
    expect(item.file_path).toBe("src/mcp.ts");
    expect(item.file_status).toBe("modified");
    expect(item.commit_date).toBe("2026-02-02T00:00:00Z");
    expect(item.commit_author).toBe("smileygames");
  });

  it("attaches the diff locator an inline review comment was left on", () => {
    const item = buildFetchItem(
      "rc:1",
      row({ type: "pr_review_comment", file_path: "src/fetch.ts", commit_sha: "abc1234" }),
    );
    expect(item.file_path).toBe("src/fetch.ts");
    expect(item.commit_sha).toBe("abc1234");
    // No file_status / commit_date: the inline-comment ingest writes neither,
    // and an empty string would read as an observed value.
    expect(item.file_status).toBeUndefined();
    expect(item.commit_date).toBeUndefined();
  });

  it("keeps a comment row to its parent number, with no diff fields", () => {
    const item = buildFetchItem("c:1", row({ type: "issue_comment", number: 239 }));
    expect(item.type).toBe("issue_comment");
    expect(item.number).toBe(239);
    expect(item.file_path).toBeUndefined();
    expect(item.commit_sha).toBeUndefined();
  });
});
