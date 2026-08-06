import { describe, it, expect } from "vitest";
import {
  toRankMap,
  reciprocalRankFusion,
  escapeFtsQuery,
  tokenizerKindForType,
  detectUnmatchedFilters,
} from "./fts.js";

describe("fts: tokenizerKindForType", () => {
  it("routes diff to the trigram (code) tokenizer and everything else to nat", () => {
    expect(tokenizerKindForType("diff")).toBe("code");
    expect(tokenizerKindForType("issue")).toBe("nat");
    expect(tokenizerKindForType("release")).toBe("nat");
    expect(tokenizerKindForType("wiki_doc")).toBe("nat");
  });
});

describe("fts: escapeFtsQuery", () => {
  it("quotes each whitespace-separated token", () => {
    expect(escapeFtsQuery("hello world")).toBe('"hello" "world"');
    expect(escapeFtsQuery("single")).toBe('"single"');
  });

  it("collapses empty / whitespace-only input to empty string", () => {
    expect(escapeFtsQuery("")).toBe("");
    expect(escapeFtsQuery("   \n\t ")).toBe("");
  });

  it("escapes embedded double quotes by doubling them (FTS5 syntax)", () => {
    // token `"hi"` -> inner quotes doubled -> wrapped -> `"""hi"""`
    expect(escapeFtsQuery('say "hi"')).toBe('"say" """hi"""');
  });

  it("joins with OR in `any` mode and keeps implicit AND as the default (#186)", () => {
    expect(escapeFtsQuery("alpha bravo charlie", "any")).toBe('"alpha" OR "bravo" OR "charlie"');
    expect(escapeFtsQuery("alpha bravo charlie", "all")).toBe('"alpha" "bravo" "charlie"');
    expect(escapeFtsQuery("alpha bravo charlie")).toBe(escapeFtsQuery("alpha bravo charlie", "all"));
  });

  it("produces an identical string in both modes for a single token", () => {
    // queryFts uses this equality to skip the relaxed UNION arm entirely.
    expect(escapeFtsQuery("single", "any")).toBe(escapeFtsQuery("single", "all"));
    expect(escapeFtsQuery("", "any")).toBe("");
  });
});

describe("fts: toRankMap", () => {
  it("assigns 1-based ranks in best-first order", () => {
    const m = toRankMap([{ vectorId: "a" }, { vectorId: "b" }, { vectorId: "c" }]);
    expect(m.get("a")).toBe(1);
    expect(m.get("b")).toBe(2);
    expect(m.get("c")).toBe(3);
  });

  it("keeps the first (best) rank on duplicate ids", () => {
    const m = toRankMap([{ vectorId: "a" }, { vectorId: "a" }]);
    expect(m.get("a")).toBe(1);
    expect(m.size).toBe(1);
  });
});

describe("fts: reciprocalRankFusion", () => {
  const rankMap = (...ids: string[]) => new Map(ids.map((id, i) => [id, i + 1]));

  it("pins the RRF formula score = sum 1/(k+rank), default k=60", () => {
    const rankers = new Map([["dense", rankMap("a")]]);
    const [hit] = reciprocalRankFusion({ rankers });
    expect(hit.vectorId).toBe("a");
    expect(hit.fusedScore).toBeCloseTo(1 / 61, 12);
    expect(hit.contributions).toEqual({ dense: 1 });
  });

  it("sums contributions across rankers that agree", () => {
    const rankers = new Map([
      ["dense", rankMap("a")],
      ["sparse", rankMap("a")],
    ]);
    const [hit] = reciprocalRankFusion({ rankers });
    expect(hit.fusedScore).toBeCloseTo(2 / 61, 12);
    expect(hit.contributions).toEqual({ dense: 1, sparse: 1 });
  });

  it("gives partial credit + null contribution for single-ranker hits", () => {
    const rankers = new Map([
      ["dense", rankMap("a", "b")], // a@1, b@2
      ["sparse", rankMap("b")], // b@1
    ]);
    const out = reciprocalRankFusion({ rankers });
    const a = out.find((h) => h.vectorId === "a")!;
    const b = out.find((h) => h.vectorId === "b")!;
    expect(a.contributions).toEqual({ dense: 1, sparse: null });
    expect(b.contributions).toEqual({ dense: 2, sparse: 1 });
    // b appears in both rankers -> outranks a, which appears in one
    expect(out[0].vectorId).toBe("b");
  });

  it("sorts hits by fused score descending", () => {
    const rankers = new Map([
      ["dense", rankMap("low", "high")], // high@2
      ["sparse", rankMap("high")], // high@1
    ]);
    const out = reciprocalRankFusion({ rankers });
    expect(out.map((h) => h.vectorId)).toEqual(["high", "low"]);
  });

  it("honors a custom k", () => {
    const rankers = new Map([["dense", rankMap("a")]]);
    const [hit] = reciprocalRankFusion({ rankers, k: 1 });
    expect(hit.fusedScore).toBeCloseTo(1 / 2, 12);
  });

  it("returns empty for no rankers / empty rankers", () => {
    expect(reciprocalRankFusion({ rankers: new Map() })).toEqual([]);
    expect(reciprocalRankFusion({ rankers: new Map([["dense", new Map()]]) })).toEqual([]);
  });
});

// Issue #219. Two searches that both return zero results are indistinguishable
// to the caller: one found nothing, the other filtered on a repo slug that
// selects no rows at all. `detectUnmatchedFilters` is what makes the responses
// differ, so the test pins the decision, not the SQL (the SQL is exercised
// against a real D1 in fts.workers.test.ts).
describe("fts: detectUnmatchedFilters (#219)", () => {
  /** Minimal D1 stand-in: records probes, answers from a fixed repo set. */
  function fakeDb(indexedRepos: string[], opts: { throws?: boolean } = {}) {
    const probes: string[] = [];
    const db = {
      probes,
      prepare() {
        return {
          bind(repo: string) {
            probes.push(repo);
            return {
              first: async () => {
                if (opts.throws) throw new Error("D1_ERROR: unreachable");
                return indexedRepos.includes(repo) ? { present: 1 } : null;
              },
            };
          },
        };
      },
    };
    return db as typeof db & D1Database;
  }

  it("flags repo when the filter value selects no indexed row", async () => {
    const db = fakeDb(["Liplus-Project/liplus-language"]);
    // Bare repository name — the exact-match filter yields an empty population.
    expect(await detectUnmatchedFilters(db, { repo: "liplus-language" }, 0)).toEqual(["repo"]);
    expect(db.probes).toEqual(["liplus-language"]);
  });

  it("stays empty for a genuine zero-hit search on a repo that exists", async () => {
    const db = fakeDb(["Liplus-Project/liplus-language"]);
    expect(
      await detectUnmatchedFilters(db, { repo: "Liplus-Project/liplus-language" }, 0),
    ).toEqual([]);
  });

  it("does not probe when candidates exist (the filter provably matched)", async () => {
    const db = fakeDb([]);
    expect(await detectUnmatchedFilters(db, { repo: "anything" }, 7)).toEqual([]);
    expect(db.probes).toEqual([]);
  });

  it("does not probe when no repo filter was applied", async () => {
    const db = fakeDb([]);
    expect(await detectUnmatchedFilters(db, {}, 0)).toEqual([]);
    expect(db.probes).toEqual([]);
  });

  it("reports nothing when the probe itself fails (never assert an unobserved mismatch)", async () => {
    const db = fakeDb([], { throws: true });
    expect(await detectUnmatchedFilters(db, { repo: "owner/repo" }, 0)).toEqual([]);
  });
});
