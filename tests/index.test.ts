import type { Context } from "@deepseek-ai/cordis";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { apply } from "../src/index.js";

// Capture actual registered definitions, not a parallel serializer/renderer.
// The real registry and Cordis lifecycle are also exercised by boot-probe.
function harness(escapeSequences: string[] = []) {
  let dispose = () => {};
  const register = vi.fn();
  const ctx = {
    effect(callback: () => () => void) { dispose = callback(); },
    tools: { register },
    systemPrompt: { section() {} },
  } as unknown as Context;
  apply(ctx, { path: ":memory:", autoProjectScope: false, defaultScope: "test<scope>", escapeSequences });
  return {
    dispose: () => dispose(),
    async call(name: string, args: object) {
      const tool = register.mock.calls.find(([item]) => item.name === name)![0];
      const value = await tool.execute(args);
      validateJsonSchemaValue(tool.output.schema, value);
      const content = tool.output.render(args, value);
      return { value, text: content.map((block: { text: string }) => block.text).join("\n") };
    },
  };
}

describe("registered memory_write output", () => {
  it("renders every hit with actionable revision, content and similarity evidence", async () => {
    const tools = harness(["<fact>", "<tag>", "<scope>"]);
    try {
      const text = "Durable <fact>: use squash merges for releases.";
      const first = await tools.call("memory_write", { text, tags: ["<tag>"] });
      const second = await tools.call("memory_write", { text, force: true });
      expect(first.text).toBe("Stored memory #1.");
      expect(second.value.written).toBe(true);
      await tools.call("memory_update", { id: 1, tags: ["<tag>"], expectedRevision: 1 });
      const blocked = await tools.call("memory_write", { text });
      expect(blocked.value.written).toBe(false);
      expect(blocked.value.dedupeHits).toHaveLength(2);
      expect(blocked.text).toContain("Not stored — 2 near-duplicate(s) found.");
      expect(blocked.text).toContain("similarity is not a contradiction verdict");
      for (const hit of blocked.value.dedupeHits) {
        expect(blocked.text).toContain(`(#${hit.id}, rev ${hit.revision}, similarity ${hit.similarity}, measure ${hit.measure})`);
        expect(blocked.text).toContain(hit.text.replaceAll("<", "<\u200b"));
        expect(hit.text).toBe(text);
        expect(hit.scope).toBe("test<scope>");
      }
      expect(blocked.text).toContain("[<\u200btag>]");
      expect(blocked.text).toContain("{test<\u200bscope>}");
      expect(blocked.text).not.toContain("<fact>");
      const match = blocked.text.match(/\(#1, rev (\d+),/)!;
      const update = await tools.call("memory_update", { id: 1, expectedRevision: Number(match[1]), text: "Updated durable fact" });
      expect(update.value.updated).toBe(true);
      expect(update.value.revision).toBe(3);
    } finally {
      tools.dispose();
    }
  });

  it("preserves default memory text without truncation or escaping", async () => {
    const tools = harness();
    try {
      const text = "Use <release> branch convention for durable deployments.";
      await tools.call("memory_write", { text });
      const blocked = await tools.call("memory_write", { text });
      expect(blocked.text).toContain(text);
      expect(blocked.text).toContain("measure jaccard");
    } finally {
      tools.dispose();
    }
  });
});
