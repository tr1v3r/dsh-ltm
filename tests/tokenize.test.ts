import { describe, expect, it } from "vitest";

import { joinTokens, normalizeTags, tokenize } from "../src/tokenize.js";

describe("tokenize", () => {
  it("keeps Latin runs as whole lowercase words", () => {
    expect(tokenize("Hello WORLD_foo 123")).toEqual(["hello", "world_foo", "123"]);
  });

  it("emits CJK unigrams plus overlapping bigrams", () => {
    expect(tokenize("记忆插件")).toEqual(["记", "忆", "插", "件", "记忆", "忆插", "插件"]);
  });

  it("keeps isolated CJK characters as unigrams", () => {
    expect(tokenize("记")).toEqual(["记"]);
    expect(tokenize("用 记 忆")).toEqual(["用", "记", "忆"]);
  });

  it("handles mixed Chinese/Latin prose (R2)", () => {
    expect(tokenize("dsh 记忆系统")).toEqual([
      "dsh",
      "记",
      "忆",
      "系",
      "统",
      "记忆",
      "忆系",
      "系统",
    ]);
  });

  it("drops punctuation and whitespace without emitting tokens", () => {
    expect(tokenize("  ，。！?!—  ")).toEqual([]);
  });

  it("never emits FTS5 operator strings or quotes", () => {
    for (const token of tokenize('OR "x" -ne NOT *')) {
      expect(token).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("round-trips through joinTokens with a single space separator", () => {
    expect(joinTokens(tokenize("记忆插件 dsh"))).toBe("记 忆 插 件 记忆 忆插 插件 dsh");
  });
});

describe("normalizeTags", () => {
  it("lowercases, dedupes, dashes inner whitespace, space-joins", () => {
    expect(normalizeTags(["Foo", "foo", "Build Tool", " ", ""])).toBe("foo build-tool");
  });

  it("returns an empty string when nothing survives", () => {
    expect(normalizeTags([])).toBe("");
    expect(normalizeTags(["  ", ""])).toBe("");
  });
});
