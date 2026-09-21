/**
 * Expiry review (R5): `stale` is not a column — it is derived from
 * `lastConfirmedAt + staleAfterDays * 86400000 < now`.
 *
 * @module dsh-ltm/expire
 */

import type { MemoryRecord } from "./contracts.js";

/** Milliseconds in one day. */
export const DAY_MS = 86_400_000;

/** Whether a record counts as stale under the configured horizon. */
export function isStale(
  record: Pick<MemoryRecord, "lastConfirmedAt">,
  staleAfterDays: number,
  now: number = Date.now(),
): boolean {
  return record.lastConfirmedAt + staleAfterDays * DAY_MS < now;
}

/** SQL predicate for stale filtering inside the store's list query. */
export function staleCutoff(staleAfterDays: number, now: number = Date.now()): number {
  return now - staleAfterDays * DAY_MS;
}
