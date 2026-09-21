/**
 * Near-duplicate detection on write (R4).
 *
 * Token-set Jaccard is always computed; char n-gram cosine is additionally
 * consulted when a cosine threshold is configured (< 1). A record is a hit
 * when either measure meets its threshold. Thresholds live in config so the
 * plugin surface can tune them; the engine only receives numbers.
 *
 * @module dsh-ltm/dedupe
 */

import type { DedupeHit, MemoryRecord } from "./contracts.js";
import { ngramCosine } from "./search.js";
import { tokenize } from "./tokenize.js";

export interface DedupeOptions {
  /** Jaccard similarity >= this marks a near-duplicate. */
  jaccardThreshold: number;
  /**
   * Cosine similarity >= this also marks a near-duplicate. Values >= 1
   * disable the cosine check (cosine is bounded by 1).
   */
  cosineThreshold: number;
}

/** Jaccard similarity between the token sets of two texts. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Find near-duplicates of `text` among `records`, best match first.
 * Only records sharing the new record's scope are considered (per
 * docs/data-model.md §4).
 */
export function findDuplicates(
  text: string,
  records: readonly MemoryRecord[],
  options: DedupeOptions,
): DedupeHit[] {
  const tokens = tokenize(text);
  const hits: DedupeHit[] = [];
  for (const record of records) {
    const jac = jaccard(tokens, tokenize(record.text));
    if (jac >= options.jaccardThreshold) {
      hits.push({ record, similarity: jac, measure: "jaccard" });
      continue;
    }
    if (options.cosineThreshold < 1) {
      const cos = ngramCosine(text, record.text);
      if (cos >= options.cosineThreshold) {
        hits.push({ record, similarity: cos, measure: "cosine" });
      }
    }
  }
  hits.sort((a, b) => b.similarity - a.similarity || a.record.id - b.record.id);
  return hits;
}
