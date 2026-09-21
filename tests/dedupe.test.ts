import { afterEach, describe, expect, it } from "vitest";

import { jaccard } from "../src/dedupe.js";
import { MemoryStore } from "../src/store.js";

const stores: MemoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("dedupe on write (R4)", () => {
  it("blocks a near-duplicate, returns hits, and force writes", () => {
    const store = new MemoryStore(":memory:", { dedupeThreshold: 0.6 });
    stores.push(store);
    const first = store.write("用户喜欢在编辑器里用 vim 按键", ["preference"]).record;
    const blocked = store.write("用户喜欢在编辑器里用 vim 键位", ["preference"]);
    expect(blocked.dedupeHits.length).toBeGreaterThan(0);
    expect(blocked.dedupeHits[0]!.record.id).toBe(first.id);
    expect(blocked.dedupeHits[0]!.measure).toBe("jaccard");
    expect(blocked.dedupeHits[0]!.similarity).toBeGreaterThanOrEqual(0.6);
    expect(store.count()).toBe(1); // not written

    const forced = store.write("用户喜欢在编辑器里用 vim 键位", ["preference"], { force: true });
    expect(forced.dedupeHits).toHaveLength(0);
    expect(store.count()).toBe(2);
  });

  it("only compares within the same scope", () => {
    const store = new MemoryStore(":memory:", { dedupeThreshold: 0.6 });
    stores.push(store);
    store.write("完全相同的一条文本", [], { scope: "a" });
    const other = store.write("完全相同的一条文本", [], { scope: "b" });
    expect(other.dedupeHits).toHaveLength(0);
    expect(store.count()).toBe(2);
  });

  it("honors a configurable cosine threshold", () => {
    const store = new MemoryStore(":memory:", {
      dedupeThreshold: 0.99, // jaccard off for near-miss token sets
      dedupeCosineThreshold: 0.5,
    });
    stores.push(store);
    store.write("系统架构采用分层设计与模块化拆分", []);
    const hit = store.write("系统架构使用分层设计和模块化拆解", []);
    expect(hit.dedupeHits.length).toBeGreaterThan(0);
    expect(hit.dedupeHits[0]!.measure).toBe("cosine");
    expect(store.count()).toBe(1);
  });
});

describe("jaccard", () => {
  it("is 1 for identical sets and 0 for disjoint or empty ones", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard(["a"], ["b"])).toBe(0);
    expect(jaccard([], ["b"])).toBe(0);
  });
});
