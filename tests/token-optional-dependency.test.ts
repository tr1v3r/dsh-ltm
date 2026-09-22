import type { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";

const resolveBackend = vi.hoisted(() => vi.fn(() => {
  throw new Error("optional dependency intentionally absent");
}));
vi.mock("node:module", () => ({ createRequire: () => resolveBackend }));

import { apply } from "../src/index.js";

it("never resolves the optional backend by default, but configured mode fails loudly if omitted", () => {
  let dispose = () => {};
  const ctx = {
    effect: (effect: () => () => void) => { dispose = effect(); },
    tools: { register() {} },
    systemPrompt: { section() {} },
  } as unknown as Context;
  try {
    apply(ctx, { path: ":memory:" });
    expect(resolveBackend).not.toHaveBeenCalled();
    expect(() => apply(ctx, {
      path: ":memory:", promptMaxTokens: 100,
      promptTokenizerPath: new URL("./fixtures/bytelevel-tokenizer.json", import.meta.url).pathname,
    })).toThrow(/requires optional @huggingface\/tokenizers@0\.2\.0/);
    expect(resolveBackend).toHaveBeenCalledExactlyOnceWith("@huggingface/tokenizers");
  } finally { dispose(); }
});
