import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord, TokenCounter } from "../src/contracts.js";
import { renderPrompt, promptLine } from "../src/prompt.js";
import { loadTokenCounter } from "../src/token-counter.js";

const config = { promptMaxChars: 2000, escapeSequences: ["{{"], staleAfterDays: 90 };
const header = "Memories you previously stored (use memory_search for anything not listed):\n";
function record(id: number, text: string, pinned = false): MemoryRecord {
  return { id, text, pinned, tags: "tag", scope: "scope", createdAt: Date.now(), updatedAt: Date.now(), lastConfirmedAt: Date.now() };
}
const counter = loadTokenCounter(new URL("./fixtures/bytelevel-tokenizer.json", import.meta.url).pathname);

describe("dual-budget prompt", () => {
  it("does not call the counter or alter frozen char-only output when disabled", () => {
    const ignored = vi.fn(() => { throw new Error("must not load or count"); });
    const records = [record(1, "hello", true), record(2, "recent")];
    expect(renderPrompt(records, config, ignored)).toBe(renderPrompt(records, config));
    expect(ignored).not.toHaveBeenCalled();
  });

  it("validates explicit token mode even for an empty store", () => {
    expect(() => renderPrompt([], { ...config, promptMaxTokens: 10 })).toThrow(/TokenCounter/);
    for (const promptMaxTokens of [0, -1, NaN, Infinity, 1.1]) {
      expect(() => renderPrompt([], { ...config, promptMaxTokens }, counter)).toThrow(/promptMaxTokens/);
    }
    for (const invalid of [NaN, -1, 1.2, Infinity]) {
      expect(() => renderPrompt([record(1, "x")], { ...config, promptMaxTokens: 100 }, () => invalid)).toThrow(/TokenCounter/);
    }
  });

  it("counts complete escaped sections, headers, separators and omission notices", () => {
    const records = [record(1, "{{hello}}😀", true), record(2, "x".repeat(200))];
    const seen: string[] = [];
    const count: TokenCounter = (text) => { seen.push(text); return counter(text); };
    const result = renderPrompt(records, { ...config, promptMaxTokens: 175 }, count);
    expect(result).toContain("{\u200b{");
    expect(result).toContain("more memories not shown");
    expect(counter(result)).toBeLessThanOrEqual(175);
    expect(seen).toContain(result);
    expect(seen.every((text) => text.startsWith(header))).toBe(true);
  });

  it("does not add individual token counts and accepts a nonmonotone complete candidate", () => {
    const records = [record(1, "a"), record(2, "b")];
    const final = header + records.map((r) => promptLine(r, [], 90)).join("\n");
    const count = (text: string) => text === final ? 1 : 2;
    expect(renderPrompt(records, { ...config, promptMaxTokens: 2 }, count)).toBe(final);
  });

  it("keeps pinned priority, never evicting pinned to fit a notice", () => {
    const pin = record(1, "hello", true);
    const body = header + promptLine(pin, [], 90);
    const max = counter(body);
    const result = renderPrompt([record(2, "recent"), pin, record(3, "x".repeat(300))], { ...config, promptMaxTokens: max }, counter);
    expect(result).toBe(body);
    expect(result).not.toContain("more memories");
  });

  it("does not keep recent lines when any pinned line was omitted", () => {
    const result = renderPrompt([record(1, "x".repeat(1000), true), record(2, "hello", true), record(3, "recent")], { ...config, promptMaxTokens: 160 }, counter);
    expect(result).toContain("#2");
    expect(result).not.toContain("#3");
    expect(counter(result)).toBeLessThanOrEqual(160);
  });

  it("truncates emoji on code-point boundaries and respects both hard caps", () => {
    for (let max = 95; max < 150; max++) {
      const result = renderPrompt([record(1, "😀".repeat(200), true), record(2, "recent")], { ...config, promptMaxChars: 140, promptMaxTokens: max }, counter);
      expect(result).not.toMatch(/\p{Surrogate}/u);
      expect(result.length).toBeLessThanOrEqual(140);
      expect(counter(result)).toBeLessThanOrEqual(max);
      expect(result).not.toContain("#2");
      if (result) expect(result).toContain("…");
    }
  });

  it("does not binary-search nonmonotone truncation counts", () => {
    const pin = record(1, "😀abcdefgh", true);
    const target = header + promptLine(pin, [], 90).slice(0, -3) + "…";
    const result = renderPrompt([pin], { ...config, promptMaxTokens: 1 }, (text) => text === target ? 1 : 100);
    expect(result).toBe(target);
  });

  it("returns no section when header plus identifiable pinned prefix cannot fit", () => {
    expect(renderPrompt([record(1, "😀", true)], { ...config, promptMaxTokens: 1 }, counter)).toBe("");
  });
});
