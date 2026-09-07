import { describe, expect, it } from "vitest";
import {
  MAX_PATH_PREFIX_UTF8_BYTES,
  pathPrefixRange,
  validateDocPathPrefix,
} from "./path-prefix.js";

describe("document path-prefix contract", () => {
  it("accepts a repository-relative directory only for doc searches", () => {
    expect(validateDocPathPrefix("benchmarks/parity-v4/", "doc")).toBeNull();
    expect(validateDocPathPrefix(undefined, "all")).toBeNull();
    expect(validateDocPathPrefix("benchmarks/", "all")).toMatch(/type="doc"/);
    expect(validateDocPathPrefix("benchmarks/", undefined)).toMatch(/type="doc"/);
  });

  it.each([
    ["", /empty/],
    ["/benchmarks/", /repository-relative/],
    ["benchmarks", /end with/],
    ["benchmarks\\parity/", /separators/],
    ["benchmarks//parity/", /empty/],
    ["benchmarks/./parity/", /\. or \.\./],
    ["benchmarks/../parity/", /\. or \.\./],
    ["benchmarks/\0parity/", /NUL/],
  ])("rejects invalid prefix %j", (prefix, message) => {
    expect(validateDocPathPrefix(prefix, "doc")).toMatch(message);
  });

  it("measures the platform limit in UTF-8 bytes, not JavaScript characters", () => {
    const exact = `${"a".repeat(MAX_PATH_PREFIX_UTF8_BYTES - 1)}/`;
    const over = `${"あ".repeat(22)}/`;
    expect(validateDocPathPrefix(exact, "doc")).toBeNull();
    expect(validateDocPathPrefix(over, "doc")).toMatch(/64 UTF-8 bytes/);
  });

  it("builds a half-open range that includes every suffix but excludes siblings", () => {
    const { lower, upper } = pathPrefixRange("benchmarks/parity/");
    expect(lower).toBe("benchmarks/parity/");
    expect(upper).toBe("benchmarks/parity0");
    for (const path of [
      "benchmarks/parity/a.md",
      "benchmarks/parity/あ.md",
      "benchmarks/parity/😀.md",
    ]) {
      expect(path >= lower && path < upper).toBe(true);
    }
    expect("benchmarks/parity-other/a.md" >= lower && "benchmarks/parity-other/a.md" < upper).toBe(false);
  });
});
