import { afterEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../src/store.js";

const stores: MemoryStore[] = [];
function open(options?: ConstructorParameters<typeof MemoryStore>[1]): MemoryStore {
  const store = new MemoryStore(":memory:", options);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("MemoryStore basics", () => {
  it("write/count/forget keep base rows and FTS rows in sync", () => {
    const store = open();
    const { record } = store.write("hello world", ["greet"]);
    expect(store.count()).toBe(1);
    expect(record.pinned).toBe(false);
    expect(record.lastConfirmedAt).toBeGreaterThan(0);
    expect(store.search("hello")).toHaveLength(1);
    expect(store.forget(record.id)).toBe(true);
    expect(store.count()).toBe(0);
    expect(store.search("hello")).toHaveLength(0);
  });

  it("close is idempotent", () => {
    const store = open();
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it("rejects blank and oversized text (fail-loud)", () => {
    const store = open({ maxTextChars: 10 });
    expect(() => store.write("   ", [])).toThrow(/blank/);
    expect(() => store.write("x".repeat(11), [])).toThrow(/limit/);
  });

  it("update keeps the id and re-indexes text", () => {
    const store = open();
    const { record } = store.write("alpha note", []);
    const updated = store.update(record.id, { text: "beta note", tags: ["t"] })!;
    expect(updated.id).toBe(record.id);
    expect(updated.text).toBe("beta note");
    expect(store.search("alpha")).toHaveLength(0);
    expect(store.search("beta")).toHaveLength(1);
  });

  it("forPrompt returns pinned first, then recent unpinned", () => {
    const store = open();
    store.write("old unpinned", [], {});
    store.write("pinned fact", [], { pinned: true });
    const records = store.forPrompt(5);
    expect(records[0]!.text).toBe("pinned fact");
    expect(records).toHaveLength(2);
  });

  it("list filters by scope, tags (AND), and pinned", () => {
    const store = open();
    store.write("a", ["x", "y"], { scope: "work" });
    store.write("b", ["x"], { scope: "home" });
    store.write("c", ["y"], { scope: "work" });
    expect(store.list({ scope: "work" }).map((r) => r.text)).toEqual(["c", "a"]);
    expect(store.list({ tags: ["x", "y"] }).map((r) => r.text)).toEqual(["a"]);
    expect(store.list({ tags: ["x"] }).map((r) => r.text).sort()).toEqual(["a", "b"]);
    expect(store.list({ scope: "work", tags: ["y"] })).toHaveLength(2);
  });
});

describe("CJK search (R2)", () => {
  it("pure-Chinese query hits text containing the term", () => {
    const store = open();
    store.write("用户偏好：dsh-ltm 是一个带中文分词的记忆插件", ["zh"]);
    store.write("完全无关的另一条记忆：今天天气不错", []);
    const hits = store.search("记忆插件");
    // OR-matched partial hits are allowed; the full-term record must lead.
    expect(hits[0]!.text).toContain("记忆插件");
    expect(hits.map((h) => h.text)).toContain("完全无关的另一条记忆：今天天气不错");
    expect(hits[0]!.ftsRank).toBeLessThanOrEqual(0); // FTS5 bm25 rank
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("mixed Chinese/Latin query hits both Latin and CJK tokens", () => {
    const store = open();
    store.write("dsh-ltm 提供跨会话记忆", []);
    store.write("无关条目", []);
    const hits = store.search("dsh 记忆");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain("dsh-ltm");
  });

  it("FTS5 operators in the query are matched literally, not executed", () => {
    const store = open();
    store.write("remember OR NOT * stuff", []);
    // treated as the literal tokens "or" "not" "*", no syntax error
    expect(() => store.search("OR NOT *")).not.toThrow();
    expect(store.search('"OR"')).toHaveLength(1);
  });

  it("search can be scoped", () => {
    const store = open();
    store.write("vim keys", [], { scope: "tui" });
    store.write("vim keys", [], { scope: "web" });
    expect(store.search("vim", 10, "web")).toHaveLength(1);
    expect(store.search("vim", 10, "web")[0]!.scope).toBe("web");
  });
});

describe("hybrid rerank (R3 default tier)", () => {
  it("ranks a synonym-rewritten query above a weaker keyword match", () => {
    const store = open();
    store.write("跨会话记忆系统：把对话要点存进长期记忆", []);
    store.write("记忆体硬件参数表", []);
    // keyword-only BM25 prefers neither strongly; cosine with the paraphrase
    // "长久记忆" should put the cross-session memory first.
    const hits = store.search("长久记忆");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.text).toContain("跨会话");
    const scores = hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe("merge (R4/R6)", () => {
  it("absorbs sources, deletes them, and unions tags on the target", () => {
    const store = open({ dedupeThreshold: 1.1 }); // write both without blocking
    const a = store.write("duplicate fact one", ["alpha", "keep"], { force: true }).record;
    const b = store.write("duplicate fact one", ["beta"], { force: true }).record;
    const merged = store.merge({ targetId: a.id, sourceIds: [b.id] })!;
    expect(merged.tags.split(" ").sort()).toEqual(["alpha", "beta", "keep"]);
    expect(store.count()).toBe(1);
    expect(store.search("duplicate fact")).toHaveLength(1);
  });

  it("returns undefined for an unknown target", () => {
    const store = open();
    expect(store.merge({ targetId: 999, sourceIds: [] })).toBeUndefined();
  });
});
