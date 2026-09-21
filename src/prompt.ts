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

/**
 * Render the section body under a character budget. Pinned memories are
 * emitted first (the store returns them first), so a budget too small for
 * everything keeps what the deployment explicitly marked as always-relevant.
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
  const render = (record: MemoryRecord): string =>
    promptLine(record, config.escapeSequences, config.staleAfterDays);
  const pinned = records.filter((r) => r.pinned).map(render);
  const recent = records.filter((r) => !r.pinned).map(render);

  const kept: string[] = [];
  let used = HEADER.length;
  let dropped = 0;

  // Pinned memories are what the deployment marked always-relevant (R9): fit as
  // many as possible, skipping any single line too large for the budget.
  let pinnedDropped = 0;
  for (const line of pinned) {
    if (used + line.length + 1 <= budget) {
      kept.push(line);
      used += line.length + 1;
    } else {
      pinnedDropped++;
    }
  }
  // Recent lines are disposable. The previous loop used `continue`, so a large
  // pinned line was skipped while a smaller later recent line was still emitted —
  // exactly the R9 inversion (always-relevant lost, disposable kept). Only render
  // recent lines when every pinned line fit.
  if (pinnedDropped === 0) {
    for (const line of recent) {
      if (used + line.length + 1 <= budget) {
        kept.push(line);
        used += line.length + 1;
      } else {
        dropped++;
      }
    }
  } else {
    dropped += recent.length;
  }
  dropped += pinnedDropped;

  // A single pinned line larger than the whole budget would otherwise erase the
  // recall section entirely, silently dropping an always-relevant fact. Guarantee
  // at least the first pinned memory, truncated on a code-point boundary (never
  // mid-character) with an ellipsis, accounting for the omission notice.
  if (kept.length === 0 && pinned.length > 0) {
    dropped = records.length - 1;
    const notice =
      dropped > 0 ? `\n(${dropped} more memories not shown; use memory_search)` : "";
    const marker = "…";
    const room = Math.max(0, budget - HEADER.length - notice.length - marker.length);
    const truncated = Array.from(pinned[0]!).slice(0, room).join("") + marker;
    return HEADER + truncated + notice;
  }

  if (kept.length === 0) return "";

  // The omission notice counts against the budget too; appending it after the
  // greedy pass can overflow `promptMaxChars`. Evict trailing (lowest-priority,
  // i.e. recent-most) lines until the complete rendered section fits.
  while (kept.length > 0) {
    const tail =
      dropped > 0 ? `\n(${dropped} more memories not shown; use memory_search)` : "";
    const out = HEADER + kept.join("\n") + tail;
    if (out.length <= budget) return out;
    kept.pop();
    dropped++;
  }
  return "";
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
