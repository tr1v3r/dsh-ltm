import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createToolSet,
  memoryRecordOutputSchema,
  memorySearchResultOutputSchema,
  memoryWriteOutputSchema,
  serializers,
} from "../src/tools.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/store.js";

let dir: string;
let store: MemoryStore;
const config = loadConfig({ path: ":memory:" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ltm-tools-"));
  store = new MemoryStore(join(dir, "ltm.db"), {
    staleAfterDays: config.staleAfterDays,
    dedupeThreshold: config.dedupeThreshold,
    dedupeCosineThreshold: config.dedupeCosineThreshold,
    maxTextChars: config.maxTextChars,
    searchLimitMax: config.searchLimitMax,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("tool set (surface over real engine)", () => {
  it("memory_write stores and searches (CJK)", () => {
    const tools = createToolSet(store, config);
    const { record, dedupeHits } = tools.memory_write({
      text: "用户偏好：dsh 插件的记忆要跨会话",
      tags: ["preference"],
    });
    expect(dedupeHits).toHaveLength(0);
    expect(record?.text).toContain("跨会话");
    const { results } = tools.memory_search({ query: "跨会话 记忆" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe(record.id);
  });

  it("memory_write dedupes near-identical text unless forced", () => {
    const tools = createToolSet(store, config);
    tools.memory_write({ text: "the project uses pnpm with workspace protocol" });
    const blocked = tools.memory_write({
      text: "the project uses pnpm with workspace protocols",
    });
    // Blocked: `record` echoes the closest existing entry, not a new write.
    expect(blocked.record?.id).toBeDefined();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.text).toBe(
      "the project uses pnpm with workspace protocol",
    );
    expect(blocked.dedupeHits.length).toBeGreaterThan(0);
    const forced = tools.memory_write({
      text: "the project uses pnpm with workspace protocols",
      force: true,
    });
    expect(forced.record?.id).toBeDefined();
    expect(store.count()).toBe(2);
  });

  it("rejects blank and oversized text", () => {
    const tools = createToolSet(store, config);
    expect(() => tools.memory_write({ text: "   " })).toThrow(/blank/);
    expect(() =>
      tools.memory_write({ text: "x".repeat(config.maxTextChars + 1) }),
    ).toThrow(/limit/);
  });

  it("clamps search limit and rejects bad ones", () => {
    const tools = createToolSet(store, config);
    tools.memory_write({ text: "alpha fact" });
    expect(() => tools.memory_search({ query: "alpha", limit: 0 })).toThrow();
    expect(() => tools.memory_search({ query: "alpha", limit: 1.5 })).toThrow();
    const { results } = tools.memory_search({
      query: "alpha",
      limit: 9999,
    });
    expect(results).toHaveLength(1);
  });

  it("memory_forget / memory_update keep legacy semantics", () => {
    const tools = createToolSet(store, config);
    const { record } = tools.memory_write({ text: "temporary fact" });
    const updated = tools.memory_update({
      id: record.id,
      text: "revised fact",
      tags: ["edit"],
      pinned: true,
    });
    expect(updated.record?.text).toBe("revised fact");
    expect(updated.record?.id).toBe(record.id);
    const { deleted } = tools.memory_forget({ id: record.id });
    expect(deleted).toBe(true);
    expect(tools.memory_forget({ id: record.id }).deleted).toBe(false);
  });

  it("memory_confirm refreshes and supports *", () => {
    const tools = createToolSet(store, config);
    tools.memory_write({ text: "fact one" });
    tools.memory_write({ text: "fact two" });
    expect(tools.memory_confirm({ id: "*" }).confirmed).toBe(2);
  });

  it("memory_list validates and hard-caps limits", () => {
    const limitedConfig = { ...config, searchLimitMax: 2 };
    const tools = createToolSet(store, limitedConfig);
    for (const text of ["one", "two", "three"]) tools.memory_write({ text, force: true });
    expect(() => tools.memory_list({ limit: 0 })).toThrow(/memory_list/);
    expect(() => tools.memory_list({ limit: 1.5 })).toThrow(/memory_list/);
    expect(tools.memory_list({ limit: 999 }).records).toHaveLength(2);
  });

  it("memory_list without a limit returns every record (R6)", () => {
    const tools = createToolSet(store, { ...config, searchLimitDefault: 2 });
    for (const text of ["one", "two", "three", "four"]) {
      tools.memory_write({ text, force: true });
    }
    expect(tools.memory_list({}).records).toHaveLength(4);
    expect(tools.memory_list({ limit: 2 }).records).toHaveLength(2);
  });

  it("memory_list filters by tags (AND) and scope", () => {
    const tools = createToolSet(store, config);
    tools.memory_write({ text: "a", tags: ["x", "y"] });
    tools.memory_write({ text: "b", tags: ["x"] });
    expect(tools.memory_list({ tags: ["x"] }).records).toHaveLength(2);
    expect(tools.memory_list({ tags: ["x", "y"] }).records).toHaveLength(1);
  });

  it("memory_merge absorbs sources and unions tags", () => {
    const tools = createToolSet(store, config);
    const a = tools.memory_write({ text: "fact alpha one", tags: ["a"] });
    const b = tools.memory_write({ text: "fact alpha two", tags: ["b"], force: true });
    const merged = tools.memory_merge({
      targetId: a.record!.id,
      sourceIds: [b.record!.id],
    });
    expect(merged.record?.tags.split(" ").sort()).toEqual(["a", "b"]);
    expect(store.list()).toHaveLength(1);
  });

  it("atomically isolates agent tools to global plus the active project", () => {
    store.close();
    let now = 1_000;
    store = new MemoryStore(join(dir, "scoped.db"), {
      staleAfterDays: config.staleAfterDays,
      dedupeThreshold: config.dedupeThreshold,
      dedupeCosineThreshold: config.dedupeCosineThreshold,
      maxTextChars: config.maxTextChars,
      searchLimitMax: config.searchLimitMax,
      now: () => now,
    });
    const global = store.write("shared build convention", [], { scope: "" }).record;
    const other = store.write("other project build convention", [], {
      scope: "project-b",
    }).record;
    const tools = createToolSet(store, config, {
      activeScope: "project-a",
      includeGlobal: true,
    });
    const local = tools.memory_write({ text: "local build convention", force: true }).record;

    expect(local.scope).toBe("project-a");
    expect(tools.memory_search({ query: "build convention" }).results.map((r) => r.id).sort())
      .toEqual([global.id, local.id].sort());
    expect(tools.memory_update({ id: other.id, text: "leak" }).record).toBeUndefined();
    expect(tools.memory_forget({ id: other.id }).deleted).toBe(false);
    now = 2_000;
    expect(tools.memory_confirm({ id: "*" }).confirmed).toBe(2);
    expect(() =>
      tools.memory_merge({ targetId: global.id, sourceIds: [local.id] }),
    ).toThrow(/different scopes/);
    const records = store.list();
    expect(records.find((record) => record.id === other.id)).toMatchObject({
      text: "other project build convention",
      lastConfirmedAt: 1_000,
    });
    expect(records.find((record) => record.id === global.id)?.lastConfirmedAt).toBe(2_000);
    expect(records.find((record) => record.id === local.id)?.lastConfirmedAt).toBe(2_000);
  });

  it("keeps fixed-scope mode separate from global memories", () => {
    const global = store.write("global setting", [], { scope: "" }).record;
    const fixed = store.write("fixed setting", [], { scope: "fixed" }).record;
    const tools = createToolSet(store, { ...config, defaultScope: "fixed" }, {
      activeScope: "fixed",
      includeGlobal: false,
    });

    expect(tools.memory_search({ query: "setting" }).results.map((r) => r.id))
      .toEqual([fixed.id]);
    expect(tools.memory_forget({ id: global.id }).deleted).toBe(false);
  });
});

describe("memory_write output schema (F2)", () => {
  it("serializers.write output validates against the registered schema in both branches", async () => {
    const { validateJsonSchemaValue, valueSchemaSpecToJsonSchema } = await import(
      "@deepseek-ai/dsh-tools",
    );
    const schema = valueSchemaSpecToJsonSchema(memoryWriteOutputSchema);
    const tools = createToolSet(store, config);
    const written = serializers.write(
      tools.memory_write({ text: "schema alignment fact" }),
    );
    expect(() => validateJsonSchemaValue(schema, written)).not.toThrow();
    expect(written.written).toBe(true);
    expect(written.record).toMatchObject({ text: "schema alignment fact" });

    const blocked = serializers.write(
      tools.memory_write({ text: "schema alignment facts" }),
    );
    expect(blocked.written).toBe(false);
    expect(blocked.record).toBeUndefined();
    expect(typeof blocked.hint).toBe("string");
    expect(() =>
      validateJsonSchemaValue(schema, blocked),
    ).not.toThrow();
  });
});

describe("search / list output schemas (regression: M-6)", () => {
  it("serializers.search output validates against the full search-result schema", async () => {
    const { validateJsonSchemaValue, valueSchemaSpecToJsonSchema } = await import(
      "@deepseek-ai/dsh-tools",
    );
    const schema = valueSchemaSpecToJsonSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        results: { type: "array", required: true, items: memorySearchResultOutputSchema },
      },
    });
    const tools = createToolSet(store, config);
    tools.memory_write({ text: "schema search alpha", tags: ["s"] });
    const value = serializers.search(tools.memory_search({ query: "alpha" }));
    // Previously the registered schema declared only 4 of the 9 serialized
    // fields; the serializer emits scope/createdAt/updatedAt/lastConfirmedAt/score.
    expect(() => validateJsonSchemaValue(schema, value)).not.toThrow();
    expect(value.results[0]).toHaveProperty("lastConfirmedAt");
    expect(value.results[0]).toHaveProperty("score");
  });

  it("serializers.record output validates against the full record schema", async () => {
    const { validateJsonSchemaValue, valueSchemaSpecToJsonSchema } = await import(
      "@deepseek-ai/dsh-tools",
    );
    const schema = valueSchemaSpecToJsonSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        records: { type: "array", required: true, items: memoryRecordOutputSchema },
      },
    });
    const tools = createToolSet(store, config);
    tools.memory_write({ text: "schema list beta", tags: ["l"] });
    const value = {
      records: tools.memory_list({}).records.map((r) => serializers.record(r)!),
    };
    expect(() => validateJsonSchemaValue(schema, value)).not.toThrow();
    expect(value.records[0]).toHaveProperty("lastConfirmedAt");
  });

  it("search hits carry the real lastConfirmedAt, not a stale 0 (regression: M-2)", () => {
    const tools = createToolSet(store, config);
    const { record } = tools.memory_write({ text: "freshness fact", tags: ["m"] });
    const hit = serializers.search(tools.memory_search({ query: "freshness" }))
      .results[0]!;
    // The render path used to inject lastConfirmedAt: 0, which is older than any
    // stale horizon, so every recalled memory rendered as "stale".
    expect(hit.lastConfirmedAt).toBeGreaterThan(0);
    expect(hit.lastConfirmedAt).toBe(record.lastConfirmedAt);
  });
});

describe("error message attribution (regression: L-10)", () => {
  it("memory_update reports its own name, not memory_write, on bad text", () => {
    const tools = createToolSet(store, config);
    const { record } = tools.memory_write({ text: "editable fact" });
    expect(() => tools.memory_update({ id: record.id, text: "   " })).toThrow(
      /^memory_update:/,
    );
    expect(() =>
      tools.memory_update({ id: record.id, text: "x".repeat(config.maxTextChars + 1) }),
    ).toThrow(/^memory_update:/);
  });
});
