import { describe, expect, it } from "vitest";
import { BM25_WEIGHT, rerankResults } from "../src/search.js";
import type { SearchResult } from "../src/contracts.js";

/** Build a minimal SearchResult; only ftsRank/text/id/score matter to rerank. */
function hit(overrides: Partial<SearchResult>): SearchResult {
  return {
    id: 1,
    text: "",
    tags: "",
    scope: "",
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    lastConfirmedAt: 0,
    ftsRank: 0,
    score: 0,
    ...overrides,
  };
}

describe("rerankResults — BM25 component (regression: H-1)", () => {
  it("actually blends BM25 with cosine (does not collapse to pure cosine)", () => {
    // FTS5 `rank` is lower-is-better and normally NEGATIVE: the best match here
    // is the most negative. With identical text both hits get cosine 0, so the
    // final ordering is decided by BM25 alone — which only happens if BM25 is
    // genuinely in the blend. The old `1 − rank/max(rank)` formula produced a
    // constant 1 for every negative-rank hit, erasing BM25 entirely.
    const results = rerankResults("anything", [
      hit({ id: 1, text: "same text", ftsRank: -1e-6 }), // worst
      hit({ id: 2, text: "same text", ftsRank: -3e-6 }), // best (most negative)
    ]);
    expect(results[0]!.id).toBe(2);
    expect(results[1]!.id).toBe(1);
    // Best rank normalizes to 1, worst to 0; with cosine 0 the scores are the
    // pure BM25 contributions, which must differ.
    expect(results[0]!.score).toBeCloseTo(BM25_WEIGHT, 5);
    expect(results[1]!.score).toBeCloseTo(0, 5);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("normalizes correctly for positive ranks too (sign-agnostic)", () => {
    const results = rerankResults("q", [
      hit({ id: 1, text: "aaa", ftsRank: 10 }), // worst
      hit({ id: 2, text: "aaa", ftsRank: 2 }), // best
    ]);
    // Lower rank is better regardless of sign.
    expect(results[0]!.id).toBe(2);
  });

  it("gives a single candidate the neutral BM25 term (no divide-by-zero)", () => {
    const [only] = rerankResults("q", [hit({ id: 7, text: "solo", ftsRank: -2e-6 })]);
    // BM25 term is 1; score = BM25_WEIGHT * 1 + (1-BM25_WEIGHT) * cosine("q","solo").
    expect(only!.score).toBeGreaterThanOrEqual(BM25_WEIGHT);
    expect(Number.isFinite(only!.score)).toBe(true);
  });

  it("treats a zero-spread rank set neutrally (all ranks equal)", () => {
    const results = rerankResults("q", [
      hit({ id: 1, text: "alpha", ftsRank: -5e-6 }),
      hit({ id: 2, text: "beta", ftsRank: -5e-6 }),
    ]);
    for (const r of results) expect(Number.isFinite(r.score)).toBe(true);
  });
});
