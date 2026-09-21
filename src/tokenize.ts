/**
 * CJK-aware tokenizer (R2).
 *
 * Latin/digit/underscore runs become whole lowercase words; CJK runs emit both
 * character unigrams and overlapping bigrams. The unigrams make a one-character
 * query searchable inside a longer run, while bigrams preserve phrase precision.
 * Punctuation and whitespace separate runs.
 *
 * Tokens only ever contain word characters or CJK characters, so quoting each
 * token with `"` in an FTS5 MATCH expression is always safe — the FTS layer
 * must still quote every token (see `search.ts`) so operators typed by a model
 * (`OR`, `*`, `-`, `"`) are matched literally instead of changing the query.
 *
 * @module dsh-ltm/tokenize
 */

import type { Tokenizer } from "./contracts.js";

/** Latin word characters (kept as whole tokens). */
const LATIN = /[A-Za-z0-9_]/;
/**
 * CJK ideographs (ext-A + basic + compat), Hiragana and Katakana. Hangul is
 * excluded deliberately: it spaces in practice and bigrams would explode.
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]/;

/**
 * Split input into lowercase Latin words plus CJK unigrams and bigrams.
 */
export function tokenizeText(input: string): string[] {
  const chars = Array.from(input);
  const tokens: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    if (LATIN.test(c)) {
      let j = i + 1;
      while (j < chars.length && LATIN.test(chars[j]!)) j++;
      tokens.push(chars.slice(i, j).join("").toLowerCase());
      i = j;
    } else if (CJK.test(c)) {
      let j = i + 1;
      while (j < chars.length && CJK.test(chars[j]!)) j++;
      const run = chars.slice(i, j);
      // Index/query symmetry matters here: emitting every character allows a
      // single-character query to match a longer run. Keep overlapping bigrams
      // as well so multi-character queries retain their more selective terms.
      tokens.push(...run);
      for (let k = 0; k + 1 < run.length; k++) tokens.push(run[k]! + run[k + 1]!);
      i = j;
    } else {
      i++;
    }
  }
  return tokens;
}

/** The frozen seam implementation. */
export const tokenize: Tokenizer = tokenizeText;

/**
 * Join tokens into the whitespace-separated string the FTS index stores.
 * Tags/scope columns store the same shape so one MATCH covers all columns.
 */
export function joinTokens(tokens: readonly string[]): string {
  return tokens.join(" ");
}

/**
 * Normalize a tag list: lowercase, inner whitespace → `-`, deduplicated,
 * space-joined (matches the contracts' `tags` field semantics).
 */
export function normalizeTags(tags: readonly string[]): string {
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase().replaceAll(/\s+/g, "-");
    if (normalized.length > 0) seen.add(normalized);
  }
  return [...seen].join(" ");
}
