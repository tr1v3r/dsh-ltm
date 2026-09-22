/**
 * Recall prompt section rendering (P1' surface).
 *
 * Pinned records always render first; unpinned recent ones follow; the whole
 * section lives under a character budget so a too-large store degrades by
 * dropping recent lines, never pinned ones (R9). Memory text is preserved by
 * default; deployments may explicitly configure output sequences to break.
 *
 * @module dsh-ltm/prompt
 */

import type { Config, MemoryRecord, MemoryStore, TokenCounter, PromptRenderResult, PromptBudgetReport } from "./contracts.js";
import { validateTokenBudget } from "./token-counter.js";
import { escapeForPrompt } from "./config.js";
import { isStale } from "./expire.js";

/** Header shown above the rendered lines. */
const HEADER =
  "Memories you previously stored (use memory_search for anything not listed):\n";

/**
 * Render one memory as a prompt line. `stale` flags records due for a
 * `memory_confirm` review so the model can refresh them opportunistically.
 *
 * @param record - the memory to render.
 * @param escapeSequences - opt-in output sequences broken with a zero-width space.
 * @returns a single line carrying id, flags, tags, and rendered text.
 */
export function promptLine(
  record: MemoryRecord,
  escapeSequences: readonly string[],
  staleAfterDays: number,
): string {
  const flags: string[] = [];
  if (record.pinned) flags.push("pinned");
  if (isStale(record, staleAfterDays)) flags.push("stale");
  const flagText = flags.length > 0 ? `, ${flags.join(", ")}` : "";
  const tags = record.tags.length > 0 ? ` [${record.tags}]` : "";
  const scope = record.scope.length > 0 ? ` {${record.scope}}` : "";
  return `- (#${record.id}${flagText})${tags}${scope} ${escapeForPrompt(
    record.text,
    escapeSequences,
  )}`;
}

/**
 * Whether a record's `lastConfirmedAt` is older than the configured horizon.
 *
 * Re-exported from {@link ./expire.ts} so the staleness rule has a single
 * definition (this module and the CLI both import `isStale` from here). A
 * second copy previously lived here and could drift from `expire.ts`.
 */
export { isStale };

/** Ellipsis appended to a truncation, never counted as a record. */
const TRUNCATION_MARKER = "…";

/** Omission notice for `dropped` records left out; `""` when nothing was. */
function omissionNotice(dropped: number): string {
  return dropped > 0 ? `\n(${dropped} more memories not shown; use memory_search)` : "";
}

/**
 * Truncate `line` to at most `room` UTF-16 code units without splitting a
 * surrogate pair. `room` is measured in the same units as `String#length`
 * (what the budget compares against), so an astral character cannot overflow
 * the budget by counting as one code point.
 */
function truncateToUnits(line: string, room: number): string {
  if (room <= 0) return "";
  let out = "";
  for (const point of line) {
    if (out.length + point.length > room) break;
    out += point;
  }
  return out;
}

/** One rendered line plus whether it came from a pinned record, and the
 * `- (#id` prefix that makes the record identifiable when truncated. */
interface RenderedLine {
  id: number;
  line: string;
  pinned: boolean;
  identity: string;
}

/**
 * Render the section body under a character budget. Pinned memories are
 * emitted first (the store returns them first), so a budget too small for
 * everything keeps what the deployment explicitly marked as always-relevant.
 *
 * Invariants (regression-tested in `tests/prompt.test.ts`):
 * - the rendered section is never longer than `promptMaxChars`;
 * - a recent line is only ever emitted when every pinned line was emitted;
 * - a pinned line is never evicted; when only the optional omission notice
 *   cannot fit, the notice gives way;
 * - when no pinned line fits the budget, the first pinned line is emitted
 *   truncated (code-point safe) rather than the section being dropped (M-1).
 *
 * @param records - pinned records followed by recent ones.
 * @param config - prompt rendering knobs (`promptMaxChars`, `escapeSequences`).
 * @returns the section text, or `""` when nothing fits or nothing is stored.
 */
export function renderPromptResult(
  records: readonly MemoryRecord[],
  config: Pick<Config, "promptMaxChars" | "escapeSequences" | "staleAfterDays" | "promptMaxTokens">,
  tokenCounter?: TokenCounter,
): PromptRenderResult {
  const finish = selectionResult(records);
  validateTokenBudget(config.promptMaxTokens, tokenCounter);
  if (config.promptMaxTokens !== undefined) {
    return renderTokenBounded(records, config, tokenCounter!, config.promptMaxTokens);
  }
  if (records.length === 0) return finish("");
  const budget = config.promptMaxChars;
  const render = (record: MemoryRecord): RenderedLine => ({
    id: record.id,
    line: promptLine(record, config.escapeSequences, config.staleAfterDays),
    pinned: record.pinned,
    identity: `- (#${record.id}`,
  });
  // Pinned first regardless of the caller's order; `forPrompt` already does
  // this, but the renderer must not depend on it.
  const pinnedLines = records.filter((r) => r.pinned).map(render);
  const recentLines = records.filter((r) => !r.pinned).map(render);

  // Greedy pass. `used` is HEADER plus one separator per accepted line, which
  // is a deliberate upper bound on the final string's length: the budget is
  // respected even though the first line needs no separator.
  const kept: RenderedLine[] = [];
  let used = HEADER.length;
  let omitted = 0;

  // Pinned memories are what the deployment marked always-relevant (R9): fit as
  // many as possible, skipping any single line too large for the budget.
  for (const entry of pinnedLines) {
    if (used + 1 + entry.line.length <= budget) {
      kept.push(entry);
      used += 1 + entry.line.length;
    } else {
      omitted++;
    }
  }
  // Recent lines are disposable, and only rendered when every pinned line fit:
  // otherwise a large pinned line could be skipped while a smaller later recent
  // line was still emitted — exactly the R9 inversion (always-relevant lost,
  // disposable kept).
  if (omitted === 0) {
    for (const entry of recentLines) {
      if (used + 1 + entry.line.length <= budget) {
        kept.push(entry);
        used += 1 + entry.line.length;
      } else {
        omitted++;
      }
    }
  } else {
    omitted += recentLines.length;
  }

  // A single pinned line larger than the whole budget would otherwise erase the
  // recall section entirely, silently dropping an always-relevant fact. Guarantee
  // at least the first pinned memory, truncated on a code-point boundary (never
  // mid-character) with an ellipsis. The optional omission notice is kept only
  // when it still leaves the pinned record identifiable (`(#id` survives);
  // otherwise the always-relevant content wins over a pointer to the rest.
  if (kept.length === 0 && pinnedLines.length > 0) {
    const first = pinnedLines[0]!;
    const bodyBudget = budget - HEADER.length - TRUNCATION_MARKER.length;
    if (bodyBudget < 0) return finish("");
    const notice = omissionNotice(records.length - 1);
    if (notice.length > 0 && bodyBudget - notice.length > 0) {
      const body = truncateToUnits(first.line, bodyBudget - notice.length);
      // Keep the notice only when the pinned record stays identifiable
      // (`- (#id` survives the truncation).
      if (body.length >= first.identity.length) {
        return finish(HEADER + body + TRUNCATION_MARKER + notice, [first], [first.id]);
      }
    }
    const body = truncateToUnits(first.line, bodyBudget);
    // Track the actual source even when a tiny legacy budget cuts its id prefix.
    return finish(HEADER + body + TRUNCATION_MARKER, body.length > 0 ? [first] : [], body.length > 0 ? [first.id] : []);
  }

  if (kept.length === 0) return finish("");

  // The omission notice competes for the budget. Evict disposable recent lines
  // only — never a pinned one — and, if even that is not enough, drop the
  // optional notice itself. `HEADER + kept-pinned` always fits, because the
  // greedy pass accepted every kept line under the budget.
  for (;;) {
    const tail = omissionNotice(omitted);
    if (used + tail.length <= budget) {
      return finish(HEADER + kept.map((entry) => entry.line).join("\n") + tail, kept);
    }
    const last = kept[kept.length - 1];
    if (last !== undefined && !last.pinned) {
      kept.pop();
      used -= 1 + last.line.length;
      omitted++;
      continue;
    }
    return finish(HEADER + kept.map((entry) => entry.line).join("\n"), kept);
  }
}

type PromptConfig = Pick<Config, "promptMaxChars" | "escapeSequences" | "staleAfterDays" | "promptMaxTokens">;

function selectionResult(records: readonly MemoryRecord[]) {
  return (text: string, entries: readonly RenderedLine[] = [], truncatedIds: number[] = []): PromptRenderResult => {
    const selectedIds = entries.map((entry) => entry.id);
    const selected = new Set(selectedIds);
    return { text, selectedIds, truncatedIds, omittedIds: records.filter((r) => !selected.has(r.id)).map((r) => r.id) };
  };
}

/** Compatibility text surface backed by the structural selection algorithm. */
export function renderPrompt(records: readonly MemoryRecord[], config: PromptConfig, tokenCounter?: TokenCounter): string {
  return renderPromptResult(records, config, tokenCounter).text;
}

/** Budget snapshot for supplied visible prompt records; does not read or mutate the store. */
export function promptBudgetReport(records: readonly MemoryRecord[], config: PromptConfig, tokenCounter?: TokenCounter): PromptBudgetReport {
  const result = renderPromptResult(records, config, tokenCounter);
  const pinned = new Set(records.filter((r) => r.pinned).map((r) => r.id));
  const report: PromptBudgetReport = {
    selectedIds: result.selectedIds, truncatedIds: result.truncatedIds, omittedIds: result.omittedIds,
    chars: result.text.length, maxChars: config.promptMaxChars,
    pinnedCount: pinned.size,
    selectedPinnedCount: result.selectedIds.filter((id) => pinned.has(id)).length,
    omittedPinnedIds: result.omittedIds.filter((id) => pinned.has(id)),
    truncatedPinnedIds: result.truncatedIds.filter((id) => pinned.has(id)),
  };
  if (config.promptMaxTokens !== undefined) {
    const tokens = tokenCounter!(result.text);
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("ltm: TokenCounter must return a nonnegative safe integer");
    report.tokens = tokens;
    report.maxTokens = config.promptMaxTokens;
  }
  return report;
}

/**
 * Build the `text` callback for `ctx.systemPrompt.section`.
 *
 * @param store - the live memory store.
 * @param config - validated plugin config.
 * @returns a zero-argument renderer for the recall section.
 */
export function recallRenderer(store: MemoryStore, config: Config, tokenCounter?: TokenCounter): () => string {
  validateTokenBudget(config.promptMaxTokens, tokenCounter);
  return () =>
    renderPrompt(store.forPrompt(config.promptRecentCount), config, tokenCounter);
}

/** Opt-in path deliberately leaves the frozen char-only algorithm untouched.
 * Count each complete candidate: token counts are neither additive nor monotone
 * in prefix length (BPE merges can reduce the count after adding characters).
 */
function renderTokenBounded(
  records: readonly MemoryRecord[],
  config: Pick<Config, "promptMaxChars" | "escapeSequences" | "staleAfterDays">,
  count: TokenCounter,
  maxTokens: number,
): PromptRenderResult {
  const finish = selectionResult(records);
  const fits = (text: string): boolean => {
    if (text.length > config.promptMaxChars) return false;
    const tokens = count(text);
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("ltm: TokenCounter must return a nonnegative safe integer");
    return tokens <= maxTokens;
  };
  if (records.length === 0) return finish("");
  const render = (record: MemoryRecord): RenderedLine => ({
    id: record.id,
    line: promptLine(record, config.escapeSequences, config.staleAfterDays),
    pinned: record.pinned,
    identity: `- (#${record.id}`,
  });
  const pinned = records.filter((record) => record.pinned).map(render);
  const recent = records.filter((record) => !record.pinned).map(render);
  const kept: RenderedLine[] = [];
  const section = (entries: readonly RenderedLine[]) => HEADER + entries.map((entry) => entry.line).join("\n");
  let omitted = 0;
  for (const entry of pinned) {
    if (fits(section([...kept, entry]))) kept.push(entry);
    else omitted++;
  }
  if (omitted === 0) {
    for (const entry of recent) {
      if (fits(section([...kept, entry]))) kept.push(entry);
      else omitted++;
    }
  } else omitted += recent.length;

  if (kept.length === 0 && pinned.length > 0) {
    const first = pinned[0]!;
    let prefix = truncateToUnits(first.line, config.promptMaxChars - HEADER.length - TRUNCATION_MARKER.length);
    // Descending code-point prefixes find the longest fitting prefix without
    // assuming monotonicity. Never emit a broken surrogate or unidentifiable id.
    while (prefix.length >= first.identity.length) {
      const candidate = HEADER + prefix + TRUNCATION_MARKER;
      if (fits(candidate)) {
        const withNotice = candidate + omissionNotice(records.length - 1);
        return finish(fits(withNotice) ? withNotice : candidate, [first], [first.id]);
      }
      const last = prefix.charCodeAt(prefix.length - 1);
      prefix = prefix.slice(0, prefix.length - (last >= 0xdc00 && last <= 0xdfff ? 2 : 1));
    }
    // Impossible budget: hard caps win over the first-pinned fallback.
    return finish("");
  }
  if (kept.length === 0) return finish("");
  for (;;) {
    const body = section(kept);
    const candidate = body + omissionNotice(omitted);
    if (fits(candidate)) return finish(candidate, kept);
    const last = kept[kept.length - 1];
    if (!last || last.pinned) return finish(body, kept); // already measured; never evict pinned for notice
    kept.pop();
    omitted++;
    if (kept.length === 0) return finish("");
  }
}
