import { describe, it, expect } from "vitest";
import { segmentForFts, needsSegmentation } from "./segment.js";

describe("segment: needsSegmentation", () => {
  it("is true for kana / kanji and false for ASCII-only text", () => {
    expect(needsSegmentation("判断の記録")).toBe(true);
    expect(needsSegmentation("クエリ")).toBe(true);
    expect(needsSegmentation("decision structure write skill")).toBe(false);
    expect(needsSegmentation("")).toBe(false);
  });

  it("is true as soon as one CJK character appears in otherwise ASCII text", () => {
    expect(needsSegmentation("fix the バグ")).toBe(true);
  });
});

describe("segment: segmentForFts", () => {
  it("splits a Japanese phrase at word boundaries (the #180 query)", () => {
    // Without these spaces `unicode61` indexes the whole run as one token and the
    // phrase query returns zero BM25 candidates.
    expect(segmentForFts("判断の記録は状態形式で書く")).toBe(
      "判断 の 記録 は 状態 形式 で 書く",
    );
  });

  it("returns English text byte-identical (fast path, no regression)", () => {
    const en = "decision structure write skill";
    expect(segmentForFts(en)).toBe(en);
    expect(segmentForFts("bge-m3 remove_diacritics abc123")).toBe(
      "bge-m3 remove_diacritics abc123",
    );
  });

  it("keeps ASCII words whole inside mixed Japanese/English text", () => {
    // The English words must survive as single segments, otherwise an unsegmented
    // English query would stop matching a mixed document.
    const out = segmentForFts("日本語とEnglishの混在テキスト");
    expect(out.split(" ")).toContain("English");
    expect(out).toBe("日本語 と English の 混在 テキスト");
  });

  it("drops whitespace and keeps symbols as their own segments", () => {
    expect(segmentForFts("　")).toBe("");
    expect(segmentForFts("。、！？")).toBe("。 、 ！ ？");
    expect(segmentForFts("記録\n\n状態")).toBe("記録 状態");
  });

  it("is idempotent — segmenting segmented text changes nothing", () => {
    // Load-bearing for the backfill: it re-reads its own output and must converge,
    // and for the query side, which segments a query that may already be spaced.
    for (const input of [
      "判断の記録は状態形式で書く",
      "日本語とEnglishの混在テキスト",
      "decision structure write skill",
      "。、！？",
    ]) {
      const once = segmentForFts(input);
      expect(segmentForFts(once)).toBe(once);
    }
  });

  it("returns empty string for empty input", () => {
    expect(segmentForFts("")).toBe("");
  });
});
