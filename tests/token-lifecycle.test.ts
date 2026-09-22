import type { Context } from "@deepseek-ai/cordis";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { apply } from "../src/index.js";
import { loadTokenCounter } from "../src/token-counter.js";

/** Small surface harness; real Cordis registration remains covered by boot-probe. */
function context() {
  let dispose = () => {};
  let render = () => "";
  const effect = vi.fn((callback: () => () => void) => { dispose = callback(); });
  const register = vi.fn();
  return {
    ctx: { effect, tools: { register }, systemPrompt: { section: (section: { text: () => string }) => { render = section.text; } } } as unknown as Context,
    effect, register, dispose: () => dispose(), render: () => render(),
  };
}

describe("token budget startup lifecycle", () => {
  it("rejects an unreadable configured asset before any DB effect or tool registration", () => {
    const harness = context();
    expect(() => apply(harness.ctx, { path: ":memory:", promptMaxTokens: 100, promptTokenizerPath: "missing-tokenizer.json" })).toThrow(/promptTokenizerPath/);
    expect(harness.effect).not.toHaveBeenCalled();
    expect(harness.register).not.toHaveBeenCalled();
  });

  it("loads the configured file once before registering a synchronous callback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-lifecycle-"));
    const harness = context();
    try {
      const path = join(dir, "tokenizer.json");
      writeFileSync(path, readFileSync(new URL("./fixtures/bytelevel-tokenizer.json", import.meta.url)));
      apply(harness.ctx, { path: ":memory:", promptMaxChars: 120, promptMaxTokens: 110, promptTokenizerPath: path });
      rmSync(path);
      expect(harness.register).toHaveBeenCalledTimes(7);
      const write = harness.register.mock.calls.find(([tool]) => tool.name === "memory_write")![0];
      await write.execute({ text: "😀".repeat(100), pinned: true });
      const rendered = harness.render();
      expect(rendered).toContain("#1");
      expect(rendered).toContain("…");
      expect(rendered.length).toBeLessThanOrEqual(120);
      const count = loadTokenCounter(new URL("./fixtures/bytelevel-tokenizer.json", import.meta.url).pathname);
      expect(count(rendered)).toBeLessThanOrEqual(110);
      harness.dispose();
      expect(() => harness.render()).toThrow(/store is not open/);
    } finally {
      harness.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
