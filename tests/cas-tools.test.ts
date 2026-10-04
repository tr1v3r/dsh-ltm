import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createToolSet,
  memoryConfirmOutputSchema,
  memoryForgetOutputSchema,
  memoryMergeOutputSchema,
  memoryRecordOutputSchema,
  memorySearchResultOutputSchema,
  memoryUpdateOutputSchema,
  memoryWriteOutputSchema,
  serializers,
} from "../src/tools.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/store.js";

let dir: string;
let store: MemoryStore;
const config = loadConfig({ path: ":memory:" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ltm-cas-tools-"));
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

/** The exact registered output schema shape, validated like the registry does. */
async function validate(schema: object, value: unknown): Promise<void> {
  const { validateJsonSchemaValue, valueSchemaSpecToJsonSchema } = await import("@deepseek-ai/dsh-tools");
  validateJsonSchemaValue(valueSchemaSpecToJsonSchema(schema as never), value);
}

describe("tool-level CAS (opt-in, structured errors)", () => {
  it("memory_update succeeds with a fresh revision and reports it", async () => {
    const tools = createToolSet(store, config);
    const { record } = tools.memory_write({ text: "tool cas fact", tags: ["cas"] });
    const ok = tools.memory_update({ id: record.id, text: "tool cas fact v2", expectedRevision: 1 });
    expect(ok.record?.revision).toBe(2);
    expect(ok.error).toBeUndefined();
    // The registered-tool execute shape (index.ts) carries the same revision.
    await validate(memoryUpdateOutputSchema, { updated: true, id: record.id, revision: 2 });
  });

  it("memory_update surfaces conflicts as structured errors, never as 'no memory'", async () => {
    const tools = createToolSet(store, config);
    const { record } = tools.memory_write({ text: "conflict tool fact" });
    tools.memory_update({ id: record.id, tags: ["bumped"] });
    const failed = tools.memory_update({ id: record.id, text: "stale", expectedRevision: 1 });
    expect(failed.record).toBeUndefined();
    expect(failed.error).toEqual({
      code: "MEMORY_REVISION_CONFLICT",
      operation: "memory_update",
      id: record.id,
      expectedRevision: 1,
      currentRevision: 2,
    });
    await validate(memoryUpdateOutputSchema, { updated: false, id: record.id, error: failed.error });
    // Nothing was written and no budget feedback ran.
    expect(store.list()[0]!.text).toBe("conflict tool fact");
    expect(failed.budget).toBeUndefined();
    // Error text never embeds the attempted content.
    expect(JSON.stringify(failed.error)).not.toContain("stale");
  });

  it("a malformed expectedRevision stays an error, not a silent non-CAS write", () => {
    const tools = createToolSet(store, config);
    const { record } = tools.memory_write({ text: "shape tool fact" });
    const failed = tools.memory_update({
      id: record.id,
      text: "sneaky",
      expectedRevision: 0 as unknown as number,
    });
    expect(failed.error).toMatchObject({ code: "MEMORY_INVALID_ARGUMENT", operation: "memory_update", id: record.id });
    expect(store.list()[0]!.text).toBe("shape tool fact");
    expect(store.list()[0]!.revision).toBe(1);
    const nullFailed = tools.memory_update({ id: record.id, expectedRevision: null as unknown as number });
    expect(nullFailed.error).toMatchObject({ code: "MEMORY_INVALID_ARGUMENT" });
  });

  it("memory_confirm returns single-id revision and rejects '*' with a version", async () => {
    const tools = createToolSet(store, config);
    const { record } = tools.memory_write({ text: "confirm tool fact" });
    const ok = tools.memory_confirm({ id: record.id, expectedRevision: 1 });
    expect(ok).toEqual({ confirmed: 1, revision: 2 });
    await validate(memoryConfirmOutputSchema, { confirmed: 1, revision: 2 });
    const all = tools.memory_confirm({ id: "*", expectedRevision: 1 });
    expect(all.confirmed).toBe(0);
    expect(all.error).toMatchObject({ code: "MEMORY_INVALID_ARGUMENT", operation: "memory_confirm" });
    await validate(memoryConfirmOutputSchema, { confirmed: 0, error: all.error });
    // '*' without a version still works and reports no pseudo-revision.
    const plain = tools.memory_confirm({ id: "*" });
    expect(plain.confirmed).toBe(1);
    expect(plain.revision).toBeUndefined();
  });

  it("memory_forget attaches the deleted revision and structured NOT_FOUND", async () => {
    const tools = createToolSet(store, config);
    const { record } = tools.memory_write({ text: "forget tool fact" });
    const ok = tools.memory_forget({ id: record.id, expectedRevision: 1 });
    expect(ok).toEqual({ deleted: true, deletedRevision: 1 });
    await validate(memoryForgetOutputSchema, { id: record.id, deleted: true, deletedRevision: 1 });
    // Deleted: NOT_FOUND, and no currentRevision is disclosed.
    const stale = tools.memory_forget({ id: record.id, expectedRevision: 1 });
    expect(stale.deleted).toBe(false);
    expect(stale.error).toMatchObject({ code: "MEMORY_NOT_FOUND", id: record.id });
    expect(stale.error?.currentRevision).toBeUndefined();
    // A stale version cannot delete newer content; the fresh one can.
    const again = tools.memory_write({ text: "forget tool fact", force: true }).record;
    tools.memory_update({ id: again.id, tags: ["moved"] });
    const late = tools.memory_forget({ id: again.id, expectedRevision: 1 });
    expect(late.error).toMatchObject({
      code: "MEMORY_REVISION_CONFLICT",
      id: again.id,
      expectedRevision: 1,
      currentRevision: 2,
    });
    const legacy = tools.memory_forget({ id: again.id });
    expect(legacy).toEqual({ deleted: true, deletedRevision: 2 });
  });

  it("memory_merge validates the strict declaration and reports target/source conflicts", async () => {
    const tools = createToolSet(store, config);
    const target = tools.memory_write({ text: "merge tool target", tags: ["t"], force: true }).record;
    const source = tools.memory_write({ text: "merge tool source", tags: ["s"], force: true }).record;

    const ok = tools.memory_merge({
      targetId: target.id,
      sourceIds: [source.id],
      expectedRevision: 1,
      expectedSourceRevisions: [{ id: source.id, revision: 1 }],
    });
    expect(ok.record?.revision).toBe(2);
    expect(ok.error).toBeUndefined();
    await validate(memoryMergeOutputSchema, { merged: true, targetId: target.id, revision: 2 });

    const nextTarget = tools.memory_write({ text: "merge tool target two", force: true }).record;
    const nextSource = tools.memory_write({ text: "merge tool source two", force: true }).record;
    const conflict = tools.memory_merge({
      targetId: nextTarget.id,
      sourceIds: [nextSource.id],
      expectedRevision: 1,
      expectedSourceRevisions: [{ id: nextSource.id, revision: 2 }],
    });
    expect(conflict.error).toMatchObject({
      code: "MEMORY_REVISION_CONFLICT",
      id: nextSource.id,
      expectedRevision: 2,
      currentRevision: 1,
    });
    expect(store.count()).toBe(3);
    await validate(memoryMergeOutputSchema, { merged: false, targetId: nextTarget.id, error: conflict.error });

    const malformed = tools.memory_merge({
      targetId: nextTarget.id,
      sourceIds: [nextSource.id],
      expectedRevision: 1,
      expectedSourceRevisions: [],
    });
    expect(malformed.error).toMatchObject({ code: "MEMORY_INVALID_ARGUMENT", operation: "memory_merge" });
    expect(store.count()).toBe(3);
  });

  it("records and search results carry revision through every serializer", async () => {
    const tools = createToolSet(store, config);
    const { record } = tools.memory_write({ text: "serializer revision fact" });
    const listValue = { records: tools.memory_list({}).records.map((r) => serializers.record(r)!) };
    expect(listValue.records[0]!.revision).toBe(record.revision);
    await validate(
      { type: "object", additionalProperties: false, properties: { records: { type: "array", required: true, items: memoryRecordOutputSchema } } },
      listValue,
    );
    const searchValue = serializers.search(tools.memory_search({ query: "serializer" }));
    expect(searchValue.results[0]!.revision).toBe(record.revision);
    await validate(
      { type: "object", additionalProperties: false, properties: { results: { type: "array", required: true, items: memorySearchResultOutputSchema } } },
      searchValue,
    );
    const writeValue = serializers.write(tools.memory_write({ text: "serializer revision facts" }));
    expect(writeValue.written).toBe(false);
    expect(writeValue.dedupeHits[0]!.revision).toBe(record.revision);
    await validate(memoryWriteOutputSchema, writeValue);
  });

  it("foreign-scope isolation keeps CAS failures metadata-only across agents", () => {
    const global = store.write("global cas fact", [], { scope: "" }).record;
    store.write("other project cas fact", [], { scope: "project-b" }).record;
    const tools = createToolSet(store, config, { activeScope: "project-a", includeGlobal: true });
    const denied = tools.memory_update({ id: 2, text: "leak", expectedRevision: 1 });
    expect(denied.error).toMatchObject({ code: "MEMORY_NOT_FOUND", operation: "memory_update", id: 2 });
    expect(denied.error?.currentRevision).toBeUndefined();
    expect(tools.memory_confirm({ id: 2, expectedRevision: 1 }).error).toMatchObject({ code: "MEMORY_NOT_FOUND" });
    expect(tools.memory_forget({ id: 2, expectedRevision: 1 }).error).toMatchObject({ code: "MEMORY_NOT_FOUND" });
    const mergeDenied = tools.memory_merge({
      targetId: 2,
      sourceIds: [],
      expectedRevision: 1,
      expectedSourceRevisions: [],
    });
    expect(mergeDenied.error).toMatchObject({ code: "MEMORY_NOT_FOUND", operation: "memory_merge", id: 2 });
    // The global record stays CAS-able from this agent.
    expect(tools.memory_update({ id: global.id, tags: ["ok"], expectedRevision: 1 }).record?.revision).toBe(2);
    expect(store.list().find((r) => r.id === 2)?.revision).toBe(1);
  });
});
