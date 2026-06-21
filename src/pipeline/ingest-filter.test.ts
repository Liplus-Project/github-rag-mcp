import { describe, it, expect } from "vitest";
import { isBotSender, isBodyTooShort, MIN_COMMENT_BODY_CHARS } from "./ingest-filter.js";

describe("ingest-filter: isBotSender", () => {
  it("flags [bot]-suffixed logins", () => {
    expect(isBotSender("dependabot[bot]")).toBe(true);
    expect(isBotSender("github-actions[bot]")).toBe(true);
  });

  it("passes human logins (including ones containing 'bot')", () => {
    expect(isBotSender("octocat")).toBe(false);
    expect(isBotSender("user-with-bot-in-name")).toBe(false);
  });

  it("only matches [bot] as a suffix, not anywhere", () => {
    expect(isBotSender("[bot]prefix")).toBe(false);
    expect(isBotSender("mid[bot]dle")).toBe(false);
  });

  it("treats null/undefined/empty as non-bot", () => {
    expect(isBotSender(null)).toBe(false);
    expect(isBotSender(undefined)).toBe(false);
    expect(isBotSender("")).toBe(false);
  });
});

describe("ingest-filter: isBodyTooShort (floor = MIN_COMMENT_BODY_CHARS)", () => {
  it("the floor is 10", () => {
    expect(MIN_COMMENT_BODY_CHARS).toBe(10);
  });

  it("rejects null/undefined/empty", () => {
    expect(isBodyTooShort(null)).toBe(true);
    expect(isBodyTooShort(undefined)).toBe(true);
    expect(isBodyTooShort("")).toBe(true);
  });

  it("rejects short / whitespace-only bodies", () => {
    expect(isBodyTooShort("LGTM")).toBe(true);
    expect(isBodyTooShort("   \n  ")).toBe(true); // trims first
    expect(isBodyTooShort("123456789")).toBe(true); // 9 chars, below floor
  });

  it("accepts bodies whose trimmed length is at or above the floor", () => {
    expect(isBodyTooShort("1234567890")).toBe(false); // exactly 10
    expect(isBodyTooShort("  1234567890  ")).toBe(false); // 10 after trim
    expect(isBodyTooShort("This is a real comment.")).toBe(false);
  });
});
