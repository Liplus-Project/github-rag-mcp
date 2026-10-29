import { describe, expect, it } from "vitest";
import { isLiteralQuery, literalQueryHint } from "./literal-query.js";

// issue #251: the hint is guidance for a caller that may read past the exact
// match under default rrf. It must fire on the three literal shapes only and
// stay off natural-language queries.
describe("isLiteralQuery", () => {
  it.each([
    "#1562",
    "#1",
    "1562",
    "2026",
    "  #251  ",
    "2bf5ed5",
    "2BF5ED5",
    "19965a7",
    "a".repeat(39) + "1",
    "0123456789abcdef0123456789abcdef01234567",
  ])("accepts the literal token %j", (q) => {
    expect(isLiteralQuery(q)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "#",
    "#12a",
    "# 1562",
    "#1562 #1563",
    "issue #1562",
    "1562 fix",
    "2bf5ed",
    "a".repeat(40) + "1",
    "2bf5ed5g",
    "defaced",
    "effaced",
    "deadbeefcafe",
    "v1.2.3",
    "１５６２",
    "rerank cross-encoder not firing",
    "search: default call does not steer a literal-token query",
  ])("rejects %j", (q) => {
    expect(isLiteralQuery(q)).toBe(false);
  });
});

describe("literalQueryHint", () => {
  it("suggests sparse_only for a literal query under an omitted fusion", () => {
    expect(literalQueryHint("#1562", false)).toEqual({
      reason: "literal_query",
      suggest: { fusion: "sparse_only" },
      message: expect.stringContaining('fusion: "sparse_only"'),
    });
  });

  it("stays silent when fusion was named, whatever its value", () => {
    expect(literalQueryHint("#1562", true)).toBeUndefined();
  });

  it("stays silent on a natural-language query", () => {
    expect(literalQueryHint("why was rerank disabled", false)).toBeUndefined();
  });
});
