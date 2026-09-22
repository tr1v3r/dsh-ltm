import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Tokenizer } from "@huggingface/tokenizers";
import { loadTokenCounter } from "../src/token-counter.js";
import { loadConfig } from "../src/config.js";

const assetPath = new URL("./fixtures/bytelevel-tokenizer.json", import.meta.url).pathname;
const asset = JSON.parse(readFileSync(assetPath, "utf8"));
const oracle: Array<{ text: string; ids: number[] }> = JSON.parse(readFileSync(new URL("./fixtures/bytelevel-oracle.json", import.meta.url), "utf8"));

describe("offline TokenCounter", () => {
  it("matches Rust HF tokenizers 0.22.2 IDs and counts for the tiny ByteLevel/BPE fixture", () => {
    const tokenizer = new Tokenizer(asset, {});
    const counter = loadTokenCounter(assetPath);
    for (const { text, ids } of oracle) {
      expect(tokenizer.encode(text, { add_special_tokens: false }).ids).toEqual(ids);
      expect(counter(text)).toBe(ids.length);
    }
    expect(counter("hello hello")).toBe(2); // actual BPE merges, not byte counting
    expect(counter("<special>")).toBe(1);
    expect(counter("")).toBe(0);
  });

  it("supports valid uniformly legacy string merges", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-legacy-merges-"));
    try {
      const path = join(dir, "tokenizer.json");
      writeFileSync(path, JSON.stringify({ ...asset, model: {
        ...asset.model, merges: asset.model.merges.map((pair: string[]) => pair.join(" ")),
      } }));
      const counter = loadTokenCounter(path);
      for (const { text, ids } of oracle) expect(counter(text)).toBe(ids.length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("loads once and remains synchronous after the local asset is removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-tokenizer-"));
    try {
      const path = join(dir, "tokenizer.json");
      writeFileSync(path, JSON.stringify(asset));
      const counter = loadTokenCounter(path);
      rmSync(path);
      expect(counter("hello")).toBe(1);
      expect(counter("hello")).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails loudly for unreadable, malformed and unsupported assets", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-tokenizer-"));
    const path = join(dir, "tokenizer.json");
    try {
      expect(() => loadTokenCounter(path)).toThrow(/promptTokenizerPath/);
      writeFileSync(path, "invalid JSON secret-content");
      expect(() => loadTokenCounter(path)).toThrow(/invalid JSON/);
      for (const change of [
        { model: { ...asset.model, dropout: 0.1 } },
        ...[["z", "z"], "z z", ["missing", "z"], ["a"], 1].map((merge) => ({
          model: { ...asset.model, merges: [...asset.model.merges, merge] },
        })),
        { model: { ...asset.model, vocab: { ...asset.model.vocab, zz: 1000 }, merges: [...asset.model.merges, "z z"] } },
        { model: { ...asset.model, vocab: { ...asset.model.vocab, a: asset.model.vocab.b } } },
        { added_tokens: [{ ...asset.added_tokens[0], id: asset.model.vocab.a }] },
        // Backend ignores single_word and trims with JS (not Rust) whitespace.
        ...["single_word", "lstrip", "rstrip"].map((flag) => ({
          added_tokens: [{ ...asset.added_tokens[0], content: "ell", [flag]: true }],
        })),
        { normalizer: { type: "Sequence", normalizers: [] }, added_tokens: [
          { ...asset.added_tokens[0], content: "ell", normalized: false },
          { ...asset.added_tokens[0], id: 999, content: "hello", normalized: true },
        ] },
        { pre_tokenizer: { type: "Split", pattern: { Regex: "a++" }, behavior: "Isolated", invert: false } },
        { pre_tokenizer: { type: "Split", pattern: { Regex: "\\p{N}{1,3}" }, behavior: "MergedWithPrevious", invert: false } },
        { normalizer: { type: "Lowercase" } },
        { truncation: { max_length: 2 } },
      ]) {
        writeFileSync(path, JSON.stringify({ ...asset, ...change }));
        expect(() => loadTokenCounter(path)).toThrow(/promptTokenizerPath/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("token budget config", () => {
  it("retains absent defaults and accepts the paired opt-in", () => {
    expect(loadConfig({ path: "x" }).promptMaxTokens).toBeUndefined();
    expect(loadConfig({ path: "x" }).promptTokenizerPath).toBeUndefined();
    expect(loadConfig({ path: "x", promptMaxTokens: 100, promptTokenizerPath: assetPath }).promptMaxTokens).toBe(100);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10", null])("rejects explicit invalid max %s", (max) => {
    expect(() => loadConfig({ path: "x", promptMaxTokens: max, promptTokenizerPath: assetPath })).toThrow();
  });
  it("rejects unpaired and empty path configuration", () => {
    for (const extra of [{ promptMaxTokens: 10 }, { promptTokenizerPath: assetPath }, { promptMaxTokens: 10, promptTokenizerPath: " " }]) {
      expect(() => loadConfig({ path: "x", ...extra })).toThrow(/prompt/);
    }
  });
});
