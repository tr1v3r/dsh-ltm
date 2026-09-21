/**
 * Search pipeline (R2, R3 default tier — zero network).
 *
 * query ─tokenize→ tokens ─全引号 MATCH→ FTS5/BM25 candidates
 *       └─char n-gram(2..3) cosine ──┐
 *                                     ├→ score = w·bm25norm + (1−w)·cosine
 * candidates ──rerank────────────────┘
 *
 * @module dsh-ltm/search
 */

import type { Reranker, SearchResult } from "./contracts.js";
import { tokenize } from "./tokenize.js";

/**
 * Quote one token for an FTS5 MATCH expression. Tokens from `tokenize()` never
 * contain `"`, so doubling any stray quote is defense in depth, not the primary
 * guard: every token is always wrapped in double quotes, which makes FTS5
 * operators in user input match literally (constraint 3 in requirements §4).
 */
function quoteToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

/**
 * Compile a free-text query into an FTS5 MATCH expression with every token
 * quoted. Returns undefined when nothing quotable survives.
 */
export function compileMatch(query: string): string | undefined {
  const tokens = tokenize(query);
  if (tokens.length === 0) return undefined;
  // Deduplicate: repeated quoted tokens would double-weight BM25. Tokens are
  // joined with OR (still individually quoted) so a synonym-rewritten query
  // that misses one bigram still recalls candidates; the hybrid rerank then
  // orders them (R3) and the LIMIT caps noise.
  return [...new Set(tokens)].map(quoteToken).join(" OR ");
}

// ---------------------------------------------------------------------------
// Char n-gram cosine
// ---------------------------------------------------------------------------

/** Build a char n-gram (n = 2..3) frequency map over lowercased text. */
export function ngramCounts(text: string): Map<string, number> {
  const s = text.toLowerCase().replaceAll(/\s+/g, " ");
  const counts = new Map<string, number>();
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const gram = s.slice(i, i + n);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  return counts;
}

/** Cosine similarity between two texts via char n-gram frequency vectors. */
export function ngramCosine(a: string, b: string): number {
  const va = ngramCounts(a);
  const vb = ngramCounts(b);
  if (va.size === 0 || vb.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of va.values()) na += v * v;
  for (const v of vb.values()) nb += v * v;
  const [small, large] = va.size <= vb.size ? [va, vb] : [vb, va];
  for (const [gram, v] of small) {
    const w = large.get(gram);
    if (w !== undefined) dot += v * w;
  }
  return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// Hybrid reranker
// ---------------------------------------------------------------------------

/** Weight of the normalized BM25 component; 1 − w goes to n-gram cosine. */
export const BM25_WEIGHT = 0.6;

/**
 * Blend FTS5 BM25 ranks and char n-gram cosine into one descending score
 * (contracts' {@link Reranker}). BM25 is normalized as `1 − rank/max(rank)`
 * (lower rank = better). With a single candidate the normalized BM25 term is 1.
 */
export function rerankResults(query: string, hits: SearchResult[]): SearchResult[] {
  if (hits.length === 0) return hits;
  const maxRank = Math.max(...hits.map((h) => h.ftsRank));
  const out = hits.map((hit) => {
    // A single candidate has no rank spread; treat it as fully BM25-relevant.
    const bm25norm = hits.length === 1 ? 1 : maxRank > 0 ? 1 - hit.ftsRank / maxRank : 1;
    const cos = ngramCosine(query, hit.text);
    return { ...hit, score: BM25_WEIGHT * bm25norm + (1 - BM25_WEIGHT) * cos };
  });
  out.sort((x, y) => y.score - x.score || x.id - y.id);
  return out;
}

/** The frozen seam implementation. */
export const reranker: Reranker = { rerank: rerankResults };
