/** Explainable, non-mutating heuristics. Findings never contain memory prose. */
import type { Config, MemoryRecord } from "./contracts.js";
import { jaccard } from "./dedupe.js";
import { ngramCounts, ngramVectorCosine } from "./search.js";
import { tokenize } from "./tokenize.js";

export interface QualityFinding {
  ids: number[];
  rule: string;
  reason: string;
  chars?: number;
  similarity?: number;
  measure?: string;
}

export function analyzeQuality(records: readonly MemoryRecord[], config: Config, maxPairs = 100_000) {
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 1) throw new Error("doctor: maxPairs must be a safe integer >= 1");
  const longChars = Math.min(1000, config.maxTextChars);
  const findings: QualityFinding[] = [];
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const group = groups.get(record.scope) ?? [];
    group.push(record);
    groups.set(record.scope, group);
    if (record.text.length >= longChars) findings.push({ ids: [record.id], rule: "long-entry", reason: "UTF-16 length meets advisory threshold; long durable facts remain valid", chars: record.text.length });
    if (/\b(?:todo|pending|in.progress|next step|blocked|waiting for)\b|待办|待处理|下一步|进行中|尚未|等待/i.test(record.text)) findings.push({ ids: [record.id], rule: "possible-transient", reason: "Contains a temporary-state cue; human review only" });
    const pathCue = /(?:\/Users\/|\/home\/|\/tmp\/|~\/|[A-Za-z]:\\|\.git\/.*worktree)/.test(record.text);
    if (pathCue) findings.push({ ids: [record.id], rule: "possible-local-path", reason: "Contains a local-path cue; may be a valid durable instruction" });
    if (record.scope === "" && (pathCue || /\b(?:repository|checkout|worktree|project)\b|仓库|项目/i.test(record.text))) findings.push({ ids: [record.id], rule: "possible-global-project", reason: "Global entry contains a project cue; no project ownership inferred" });
  }
  // Lazily cache per-record derivations; skipped pairs incur no tokenization work.
  const tokens = new Map<number, string[]>();
  const vectors = new Map<number, Map<string, number>>();
  const getTokens = (r: MemoryRecord) => {
    let value = tokens.get(r.id);
    if (!value) { value = tokenize(r.text); tokens.set(r.id, value); }
    return value;
  };
  const getVector = (r: MemoryRecord) => {
    let value = vectors.get(r.id);
    if (!value) { value = ngramCounts(r.text); vectors.set(r.id, value); }
    return value;
  };
  let totalPairs = 0;
  let comparedPairs = 0;
  for (const group of groups.values()) totalPairs += group.length * (group.length - 1) / 2;
  outer: for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      if (comparedPairs >= maxPairs) break outer;
      comparedPairs++;
      const left = group[i]!;
      const right = group[j]!;
      const jac = jaccard(getTokens(left), getTokens(right));
      const cos = jac >= config.dedupeThreshold || config.dedupeCosineThreshold >= 1 ? 0 : ngramVectorCosine(getVector(left), getVector(right));
      if (jac >= config.dedupeThreshold || (config.dedupeCosineThreshold < 1 && cos >= config.dedupeCosineThreshold)) {
        findings.push({ ids: [left.id, right.id], rule: "same-scope-near-duplicate", reason: "Lexical similarity only: neither equivalence nor contradiction is established", similarity: jac >= config.dedupeThreshold ? jac : cos, measure: jac >= config.dedupeThreshold ? "jaccard" : "cosine" });
      }
    }
  }
  return {
    recordCount: records.length,
    scopeDistribution: [...groups].map(([scope, rows]) => ({ scope, count: rows.length, pinned: rows.filter((r) => r.pinned).length })),
    rules: { longChars, lengthUnit: "UTF-16 code units", jaccardThreshold: config.dedupeThreshold, cosineThreshold: config.dedupeCosineThreshold, cosineEnabled: config.dedupeCosineThreshold < 1, heuristicOnly: true, referenceCheck: "not performed: no reliable reference syntax" },
    nearDuplicateScan: { complexity: "quadratic within each scope", maxPairs, totalPairs, comparedPairs, skippedPairs: totalPairs - comparedPairs, complete: comparedPairs === totalPairs },
    findings,
  };
}
