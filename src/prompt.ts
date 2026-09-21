/**
 * Recall prompt section rendering (P1' surface).
 *
 * Pinned records always render first; unpinned recent ones follow; the whole
 * section lives under a character budget so a too-large store degrades by
 * dropping recent lines, never pinned ones (R9). Memory text is escaped for
 * configured template-injection sequences before rendering.
 *
 * @module dsh-ltm/prompt
 */

import type { Config, MemoryRecord, MemoryStore } from "./contracts.js";
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
 * @param escapeSequences - sequences broken with a zero-width space.
 * @returns a single line carrying id, flags, tags, and escaped text.
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
export function renderPrompt(
  records: readonly MemoryRecord[],
  config: Pick<Config, "promptMaxChars" | "escapeSequences" | "staleAfterDays">,
): string {
  if (records.length === 0) return "";
  const budget = config.promptMaxChars;
  const render = (record: MemoryRecord): RenderedLine => ({
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
    if (bodyBudget < 0) return "";
    const notice = omissionNotice(records.length - 1);
    if (notice.length > 0 && bodyBudget - notice.length > 0) {
      const body = truncateToUnits(first.line, bodyBudget - notice.length);
      // Keep the notice only when the pinned record stays identifiable
      // (`- (#id` survives the truncation).
      if (body.includes(first.identity)) {
        return HEADER + body + TRUNCATION_MARKER + notice;
      }
    }
    return (
      HEADER + truncateToUnits(first.line, bodyBudget) + TRUNCATION_MARKER
    );
  }

  if (kept.length === 0) return "";

  // The omission notice competes for the budget. Evict disposable recent lines
  // only — never a pinned one — and, if even that is not enough, drop the
  // optional notice itself. `HEADER + kept-pinned` always fits, because the
  // greedy pass accepted every kept line under the budget.
  for (;;) {
    const tail = omissionNotice(omitted);
    if (used + tail.length <= budget) {
      return HEADER + kept.map((entry) => entry.line).join("\n") + tail;
    }
    const last = kept[kept.length - 1];
    if (last !== undefined && !last.pinned) {
      kept.pop();
      used -= 1 + last.line.length;
      omitted++;
      continue;
    }
    return HEADER + kept.map((entry) => entry.line).join("\n");
  }
}

/**
 * Build the `text` callback for `ctx.systemPrompt.section`.
 *
 * @param store - the live memory store.
 * @param config - validated plugin config.
 * @returns a zero-argument renderer for the recall section.
 */
export function recallRenderer(store: MemoryStore, config: Config): () => string {
  return () =>
    renderPrompt(store.forPrompt(config.promptRecentCount), config);
}
