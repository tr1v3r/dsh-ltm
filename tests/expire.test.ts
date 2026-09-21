import { afterEach, describe, expect, it } from "vitest";

import { DAY_MS, isStale, staleCutoff } from "../src/expire.js";
import { MemoryStore } from "../src/store.js";

const stores: MemoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("expiry (R5)", () => {
  it("marks records stale after staleAfterDays and confirm refreshes them", () => {
    let now = 1_000_000_000_000;
    const store = new MemoryStore(":memory:", { staleAfterDays: 30, now: () => now });
    stores.push(store);
    const { record } = store.write("needs periodic review", ["ops"]);
    expect(store.list({ stale: true })).toHaveLength(0);
    expect(store.list({ stale: false })).toHaveLength(1);

    now += 31 * DAY_MS;
    expect(store.list({ stale: true }).map((r) => r.id)).toEqual([record.id]);

    expect(store.confirm(record.id)).toBe(1);
    expect(store.list({ stale: true })).toHaveLength(0);

    now += 31 * DAY_MS;
    expect(store.confirm("*")).toBe(1);
    expect(store.list({ stale: true })).toHaveLength(0);
  });

  it("confirm on a missing id changes nothing", () => {
    const store = new MemoryStore(":memory:");
    stores.push(store);
    expect(store.confirm(424242)).toBe(0);
  });
});

describe("expire helpers", () => {
  it("derives staleness from lastConfirmedAt", () => {
    const now = 5_000_000_000_000;
    expect(isStale({ lastConfirmedAt: now - 91 * DAY_MS }, 90, now)).toBe(true);
    expect(isStale({ lastConfirmedAt: now - 89 * DAY_MS }, 90, now)).toBe(false);
  });

  it("staleCutoff is the inverse boundary", () => {
    const now = 5_000_000_000_000;
    expect(staleCutoff(90, now)).toBe(now - 90 * DAY_MS);
  });
});
