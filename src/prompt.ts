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
 * Kept side-effect-free so the prompt layer never mutates store state.
 *
 * @param record - the record to test.
 * @param staleAfterDays - configured horizon in days.
 * @param now - epoch ms to compare against (defaults to `Date.now()`).
 */
export function isStale(
  record: Pick<MemoryRecord, "lastConfirmedAt">,
  staleAfterDays: number,
  now: number = Date.now(),
): boolean {
  return record.lastConfirmedAt + staleAfterDays * 86_400_000 < now;
}

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
  const lines: string[] = [];
  let used = HEADER.length;
  let dropped = 0;
  for (const record of records) {
    const line = promptLine(record, config.escapeSequences, config.staleAfterDays);
    if (used + line.length + 1 > config.promptMaxChars) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return "";
  const tail =
    dropped > 0 ? `\n(${dropped} more memories not shown; use memory_search)` : "";
  return HEADER + lines.join("\n") + tail;
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
