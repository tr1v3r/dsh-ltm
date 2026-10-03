import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { MEMORY_REVISION_MAX, MemoryMutationError } from "../src/errors.js";
import { MemoryStore } from "../src/store.js";

const MAX = MEMORY_REVISION_MAX;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

type StoreOptions = ConstructorParameters<typeof MemoryStore>[1];
function fileStore(options?: StoreOptions): { store: MemoryStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ltm-cas-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ltm.db");
  const store = new MemoryStore(path, options);
  cleanup.push(() => store.close());
  return { store, path };
}

function expectMutationError(
  fn: () => unknown,
  detail: Partial<{
    code: string;
    operation: string;
    id: number;
    expectedRevision: number;
    currentRevision?: number;
  }>,
): MemoryMutationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryMutationError);
    const typed = error as MemoryMutationError;
    expect({ ...typed.detail }).toMatchObject(detail);
    return typed;
  }
  throw new Error("expected a MemoryMutationError");
}

describe("revision basics (issue #32 phase 1)", () => {
  it("new writes start at revision 1 and reads/searches carry it", () => {
    const { store } = fileStore();
    const { record, dedupeHits } = store.write("revision start fact", ["cas"]);
    expect(record.revision).toBe(1);
    expect(dedupeHits).toHaveLength(0);
    expect(store.list()[0]!.revision).toBe(1);
    expect(store.search("revision")[0]!.revision).toBe(1);
    expect(store.forPrompt(5)[0]!.revision).toBe(1);
  });

  it("a dedupe hit returns the existing revision without modifying the record", () => {
    const { store } = fileStore();
    const first = store.write("identical durable fact", []);
    const blocked = store.write("identical durable fact", []);
    expect(blocked.dedupeHits.length).toBeGreaterThan(0);
    expect(blocked.record.id).toBe(first.record.id);
    expect(blocked.record.revision).toBe(1);
    const row = store.list()[0]!;
    expect(row.revision).toBe(1);
    expect(row.updatedAt).toBe(first.record.updatedAt);
  });

  it("update increments once per successful call, including empty and same-value patches", () => {
    const { store } = fileStore();
    const { record } = store.write("revision counter fact", []);
    const id = record.id;
    expect(store.update(id, {})!.revision).toBe(2);
    expect(store.update(id, { text: "revision counter fact" })!.revision).toBe(3);
    expect(store.update(id, { tags: [] })!.revision).toBe(4);
    expect(store.update(id, { pinned: false })!.revision).toBe(5);
  });

  it("update keeps lastConfirmedAt and confirm keeps text/updatedAt while bumping revision", () => {
    let now = 1_000;
    const { store } = fileStore({ now: () => now });
    const { record } = store.write("lifecycle fact", ["x"]);
    now = 2_000;
    const updated = store.update(record.id, { text: "lifecycle fact revised" })!;
    expect(updated.lastConfirmedAt).toBe(record.lastConfirmedAt);
    now = 3_000;
    const confirmed = store.confirmVersioned(record.id);
    expect(confirmed).toEqual({ confirmed: 1, revision: 3 });
    const after = store.list()[0]!;
    expect(after.text).toBe("lifecycle fact revised");
    expect(after.updatedAt).toBe(2_000);
    expect(after.lastConfirmedAt).toBe(3_000);
    expect(after.revision).toBe(3);
  });

  it("same-millisecond writes stay distinguishable through the revision counter", () => {
    let now = 5_000;
    const { store } = fileStore({ now: () => now });
    const { record } = store.write("frozen clock fact", []);
    const a = store.update(record.id, { text: "frozen clock fact v2" })!;
    const b = store.update(record.id, { text: "frozen clock fact v3" })!;
    const c = store.confirmVersioned(record.id);
    const d = store.merge({ targetId: record.id, sourceIds: [] })!;
    expect([a.updatedAt, b.updatedAt, d.updatedAt]).toEqual([now, now, now]);
    expect([a.revision, b.revision, c.revision, d.revision]).toEqual([2, 3, 4, 5]);
  });

  it("confirm('*') increments every visible record in one transaction, scoped", () => {
    const { store } = fileStore();
    store.write("global fact", [], { force: true });
    store.write("project fact", [], { scope: "proj", force: true });
    const confirmed = store.confirmVersioned("*");
    expect(confirmed).toEqual({ confirmed: 2 });
    expect(store.list().map((r) => r.revision).sort()).toEqual([2, 2]);
    const scoped = store.confirmVersioned("*", ["proj"]);
    expect(scoped).toEqual({ confirmed: 1 });
    const byScope = new Map(store.list().map((r) => [r.scope, r.revision]));
    expect(byScope.get("")).toBe(2);
    expect(byScope.get("proj")).toBe(3);
  });

  it("merge increments the target once, deletes sources, and creates no source versions", () => {
    const { store } = fileStore({ dedupeThreshold: 1.1, dedupeCosineThreshold: 1.1 });
    const a = store.write("merge target fact", ["t"], { force: true }).record;
    const b = store.write("merge source fact", ["s"], { force: true }).record;
    const merged = store.merge({ targetId: a.id, sourceIds: [b.id] })!;
    expect(merged.revision).toBe(2);
    expect(merged.lastConfirmedAt).toBe(a.lastConfirmedAt);
    expect(store.count()).toBe(1);
    expect(store.list()[0]!.id).toBe(a.id);
  });

  it("read-only paths never increment: list/search/export-shape/FTS rebuild", () => {
    const { store, path } = fileStore();
    const { record } = store.write("stable revision fact", []);
    store.list();
    store.search("stable");
    store.forPrompt(5);
    store.count();
    expect(store.list()[0]!.revision).toBe(1);
    // FTS token-version repair rebuilds the index without bumping revisions.
    const db = new DatabaseSync(path);
    db.prepare("DELETE FROM meta WHERE key = 'fts_token_version'").run();
    db.close();
    const reopened = new MemoryStore(path);
    cleanup.push(() => reopened.close());
    expect(reopened.search("stable")).toHaveLength(1);
    expect(reopened.list()[0]!.revision).toBe(1);
  });
});

describe("CAS update across two connections", () => {
  it("a stale expectedRevision is rejected and the winner's state is fully preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-cas-two-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "ltm.db");
    const a = new MemoryStore(path);
    const b = new MemoryStore(path);
    cleanup.push(() => a.close(), () => b.close());
    const { record } = a.write("two connection fact", ["shared"]);
    const observed = b.list()[0]!;
    expect(observed.revision).toBe(record.revision);
    const winner = a.update(record.id, { text: "two connection fact v2" })!;
    expect(winner.revision).toBe(2);
    const error = expectMutationError(
      () => b.update(record.id, { text: "stale writer text" }, undefined, { expectedRevision: 1 }),
      { code: "MEMORY_REVISION_CONFLICT", id: record.id, expectedRevision: 1, currentRevision: 2 },
    );
    // Metadata-only: no prose in the error.
    expect(error.message).not.toContain("stale writer text");
    const current = b.list()[0]!;
    expect(current.text).toBe("two connection fact v2");
    expect(current.revision).toBe(2);
    expect(current.updatedAt).toBe(winner.updatedAt);
    expect(current.lastConfirmedAt).toBe(winner.lastConfirmedAt);
    expect(b.search("v2")).toHaveLength(1);
    expect(b.search("stale writer")).toHaveLength(0);
    // The stale writer retries with the fresh revision and wins.
    expect(b.update(record.id, { text: "third write" }, undefined, { expectedRevision: 2 })!.revision).toBe(3);
  });

  it("CAS treats unknown, deleted, and foreign-scope ids identically as NOT_FOUND", () => {
    const { store } = fileStore();
    const foreign = store.write("foreign scope fact", [], { scope: "other" }).record;
    const deleted = store.write("soon deleted fact", [], { force: true }).record;
    const visible = store.write("visible scoped fact", [], { force: true }).record;
    store.forget(deleted.id);
    expect(store.count()).toBe(2);
    for (const id of [999999, deleted.id, foreign.id]) {
      const updateError = expectMutationError(
        () => store.update(id, { text: "x" }, [""], { expectedRevision: 1 }),
        { code: "MEMORY_NOT_FOUND", id },
      );
      expect(updateError.detail.currentRevision).toBeUndefined();
      const confirmError = expectMutationError(
        () => store.confirm(id, [""], { expectedRevision: 1 }),
        { code: "MEMORY_NOT_FOUND", id },
      );
      expect(confirmError.detail.currentRevision).toBeUndefined();
      const forgetError = expectMutationError(
        () => store.forget(id, [""], { expectedRevision: 1 }),
        { code: "MEMORY_NOT_FOUND", id },
      );
      expect(forgetError.detail.currentRevision).toBeUndefined();
      const mergeError = expectMutationError(
        () => store.merge({ targetId: id, sourceIds: [], expectedRevision: 1, expectedSourceRevisions: [] }, [""]),
        { code: "MEMORY_NOT_FOUND", id },
      );
      expect(mergeError.detail.currentRevision).toBeUndefined();
      const foreignSourceError = expectMutationError(
        () => store.merge({
          targetId: visible.id,
          sourceIds: [foreign.id],
          expectedRevision: 1,
          expectedSourceRevisions: [{ id: foreign.id, revision: 1 }],
        }, [""]),
        { code: "MEMORY_NOT_FOUND", id: foreign.id },
      );
      expect(foreignSourceError.detail.currentRevision).toBeUndefined();
    }
  });

  it("legacy shapes stay intact without a version: undefined / 0 / false", () => {
    const { store } = fileStore();
    const foreign = store.write("legacy foreign fact", [], { scope: "other" }).record;
    expect(store.update(999999, { text: "x" })).toBeUndefined();
    expect(store.update(foreign.id, { text: "x" }, [""])).toBeUndefined();
    expect(store.confirm(foreign.id, [""])).toBe(0);
    expect(store.confirm(999999)).toBe(0);
    expect(store.forget(foreign.id, [""])).toBe(false);
    expect(store.forget(999999)).toBe(false);
    expect(store.merge({ targetId: 999999, sourceIds: [] }, [""])).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it("CAS with empty allowed scopes is NOT_FOUND; legacy keeps old behavior", () => {
    const { store } = fileStore();
    const { record } = store.write("empty scopes fact", []);
    expect(store.update(record.id, { text: "x" }, [])).toBeUndefined();
    expect(store.confirm(record.id, [])).toBe(0);
    expect(store.forget(record.id, [])).toBe(false);
    expectMutationError(() => store.update(record.id, { text: "x" }, [], { expectedRevision: 1 }), {
      code: "MEMORY_NOT_FOUND",
      id: record.id,
    });
    expectMutationError(() => store.confirm(record.id, [], { expectedRevision: 1 }), {
      code: "MEMORY_NOT_FOUND",
      id: record.id,
    });
    expectMutationError(() => store.forget(record.id, [], { expectedRevision: 1 }), {
      code: "MEMORY_NOT_FOUND",
      id: record.id,
    });
  });
});

describe("stale confirm / forget protect the newer content", () => {
  it("an old revision cannot confirm the newer content", () => {
    let now = 1_000;
    const { store } = fileStore({ now: () => now });
    const { record } = store.write("confirm guard fact", []);
    now = 2_000;
    store.update(record.id, { text: "confirm guard fact v2" });
    now = 3_000;
    expectMutationError(
      () => store.confirm(record.id, undefined, { expectedRevision: 1 }),
      { code: "MEMORY_REVISION_CONFLICT", id: record.id, expectedRevision: 1, currentRevision: 2 },
    );
    const row = store.list()[0]!;
    expect(row.lastConfirmedAt).toBe(1_000);
    expect(row.revision).toBe(2);
    // Fresh revision confirms and reports the post-write revision.
    expect(store.confirmVersioned(record.id, undefined, { expectedRevision: 2 })).toEqual({
      confirmed: 1,
      revision: 3,
    });
    expect(store.list()[0]!.lastConfirmedAt).toBe(3_000);
  });

  it("an old revision cannot delete the newer content", () => {
    const { store } = fileStore();
    const { record } = store.write("forget guard fact", []);
    store.update(record.id, { text: "forget guard fact v2" });
    expectMutationError(
      () => store.forget(record.id, undefined, { expectedRevision: 1 }),
      { code: "MEMORY_REVISION_CONFLICT", id: record.id, expectedRevision: 1, currentRevision: 2 },
    );
    expect(store.count()).toBe(1);
    expect(store.search("forget guard")).toHaveLength(1);
    const removed = store.forgetVersioned(record.id, undefined, { expectedRevision: 2 });
    expect(removed).toEqual({ deleted: true, deletedRevision: 2 });
    expect(store.count()).toBe(0);
    expect(store.search("forget guard")).toHaveLength(0);
  });

  it("confirm('*') never accepts a revision, even with zero visible rows", () => {
    const { store } = fileStore();
    expectMutationError(() => store.confirm("*", undefined, { expectedRevision: 1 }), {
      code: "MEMORY_INVALID_ARGUMENT",
      operation: "memory_confirm",
    });
  });
});

describe("revision ceiling", () => {
  function maxedStore(): { store: MemoryStore; id: number } {
    const { store } = fileStore();
    const { record } = store.write("ceiling fact", [], { scope: "maxed" });
    store.forget(record.id);
    // Restore the same row at the ceiling through the versioned import path.
    store.importRecords([{ ...record, revision: MAX }]);
    return { store, id: record.id };
  }

  it("update, confirm, and a merge target at MAX are rejected with no writes", () => {
    const { store, id } = maxedStore();
    expectMutationError(() => store.update(id, { text: "over" }), {
      code: "MEMORY_REVISION_OVERFLOW",
      id,
    });
    expectMutationError(() => store.update(id, {}, undefined, { expectedRevision: MAX }), {
      code: "MEMORY_REVISION_OVERFLOW",
      id,
    });
    expectMutationError(() => store.confirm(id), { code: "MEMORY_REVISION_OVERFLOW", id });
    expectMutationError(() => store.confirm(id, undefined, { expectedRevision: MAX }), {
      code: "MEMORY_REVISION_OVERFLOW",
      id,
    });
    const row = store.list()[0]!;
    expect(row.revision).toBe(MAX);
    expect(row.text).toBe("ceiling fact");
  });

  it("confirm('*') fails atomically when one visible row is at MAX", () => {
    const { store, id } = maxedStore();
    const other = store.write("healthy sibling fact", [], { force: true }).record;
    expectMutationError(() => store.confirm("*"), { code: "MEMORY_REVISION_OVERFLOW", id });
    const byId = new Map(store.list().map((r) => [r.id, r.revision]));
    expect(byId.get(id)).toBe(MAX);
    expect(byId.get(other.id)).toBe(1);
    // Scoped '*' that excludes the maxed row still works.
    expect(store.confirm("*", [""])).toBe(1);
    expect(store.list().find((r) => r.id === other.id)!.revision).toBe(2);
    expect(store.list().find((r) => r.id === id)!.revision).toBe(MAX);
  });

  it("a MAX row can still be forgotten with its matching revision; MAX sources merge away", () => {
    const { store, id } = maxedStore();
    const target = store.write("merge ceiling target", [], { force: true }).record;
    expect(store.forgetVersioned(id, undefined, { expectedRevision: MAX })).toEqual({
      deleted: true,
      deletedRevision: MAX,
    });
    const healthy = store.write("max merge healthy source", [], { force: true }).record;
    store.importRecords([{
      id: 900, text: "max source fact", tags: "", scope: "", pinned: false,
      createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, revision: MAX,
    }]);
    // A ceiling SOURCE is deletable; the target keeps incrementing normally.
    const merged = store.merge(
      { targetId: target.id, sourceIds: [900], expectedRevision: 1, expectedSourceRevisions: [{ id: 900, revision: MAX }] },
    )!;
    expect(merged.revision).toBe(2);
    expect(store.count()).toBe(2);
    // A ceiling TARGET is rejected: nothing changes even with matching versions.
    store.importRecords([{
      id: 901, text: "max target fact", tags: "", scope: "", pinned: false,
      createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, revision: MAX,
    }]);
    expectMutationError(
      () => store.merge({
        targetId: 901,
        sourceIds: [healthy.id],
        expectedRevision: MAX,
        expectedSourceRevisions: [{ id: healthy.id, revision: 1 }],
      }),
      { code: "MEMORY_REVISION_OVERFLOW", id: 901 },
    );
    expect(store.count()).toBe(3);
    expect(store.list().find((r) => r.id === healthy.id)).toBeDefined();
  });
});

describe("malformed CAS inputs are rejected, never downgraded", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null])(
    "update rejects expectedRevision %p as MEMORY_INVALID_ARGUMENT",
    (value) => {
      const { store } = fileStore();
      const { record } = store.write("shape guard fact", []);
      expectMutationError(
        () => store.update(record.id, {}, undefined, { expectedRevision: value as number }),
        { code: "MEMORY_INVALID_ARGUMENT", operation: "memory_update", id: record.id },
      );
      expect(store.list()[0]!.revision).toBe(1);
    },
  );

  it.each([0, -1, 2.5, Number.NaN, "2", null])(
    "confirm and forget reject expectedRevision %p as MEMORY_INVALID_ARGUMENT",
    (value) => {
      const { store } = fileStore();
      const { record } = store.write("shape guard fact two", []);
      expectMutationError(
        () => store.confirm(record.id, undefined, { expectedRevision: value as number }),
        { code: "MEMORY_INVALID_ARGUMENT", operation: "memory_confirm" },
      );
      expectMutationError(
        () => store.forget(record.id, undefined, { expectedRevision: value as number }),
        { code: "MEMORY_INVALID_ARGUMENT", operation: "memory_forget" },
      );
      expect(store.list()[0]!.revision).toBe(1);
    },
  );

  it("rejects revision above the safe-integer range", () => {
    const { store } = fileStore();
    const { record } = store.write("range guard fact", []);
    expectMutationError(
      () => store.update(record.id, {}, undefined, { expectedRevision: MAX + 1 }),
      { code: "MEMORY_INVALID_ARGUMENT", operation: "memory_update", id: record.id },
    );
  });
});

describe("strict merge", () => {
  function fixture() {
    const store = new MemoryStore(":memory:", { dedupeThreshold: 1.1, dedupeCosineThreshold: 1.1 });
    cleanup.push(() => store.close());
    const target = store.write("merge strict target", ["t"], { force: true }).record;
    const s1 = store.write("merge strict source one", ["a"], { force: true }).record;
    const s2 = store.write("merge strict source two", ["b"], { force: true }).record;
    return { store, target, s1, s2 };
  }

  it("succeeds once when the full declaration matches; target +1, sources gone", () => {
    const { store, target, s1, s2 } = fixture();
    const merged = store.merge({
      targetId: target.id,
      sourceIds: [s1.id, s2.id, s1.id, target.id], // duplicates + target tolerated
      expectedRevision: 1,
      expectedSourceRevisions: [
        { id: s2.id, revision: 1 },
        { id: s1.id, revision: 1 },
      ],
    })!;
    expect(merged.revision).toBe(2);
    expect(store.count()).toBe(1);
    expect(merged.tags.split(" ").sort()).toEqual(["a", "b", "t"]);
  });

  it("a stale target version changes nothing at all", () => {
    const { store, target, s1 } = fixture();
    store.update(target.id, { text: "merge strict target v2" });
    expectMutationError(
      () => store.merge({
        targetId: target.id,
        sourceIds: [s1.id],
        expectedRevision: 1,
        expectedSourceRevisions: [{ id: s1.id, revision: 1 }],
      }),
      { code: "MEMORY_REVISION_CONFLICT", id: target.id, expectedRevision: 1, currentRevision: 2 },
    );
    expect(store.count()).toBe(3);
    expect(store.list().find((r) => r.id === s1.id)!.revision).toBe(1);
  });

  it("a stale source version changes nothing at all (stable first report)", () => {
    const { store, target, s1, s2 } = fixture();
    store.confirm(s1.id);
    expectMutationError(
      () => store.merge({
        targetId: target.id,
        sourceIds: [s1.id, s2.id],
        expectedRevision: 1,
        expectedSourceRevisions: [
          { id: s1.id, revision: 1 },
          { id: s2.id, revision: 1 },
        ],
      }),
      { code: "MEMORY_REVISION_CONFLICT", id: s1.id, expectedRevision: 1, currentRevision: 2 },
    );
    expect(store.count()).toBe(3);
    expect(store.list().map((r) => r.id).sort()).toEqual([s1.id, s2.id, target.id].sort());
    expect(store.search("merge strict")).toHaveLength(3);
  });

  it("a missing or foreign source is NOT_FOUND and a cross-scope source is SCOPE_MISMATCH", () => {
    const { store, target, s1 } = fixture();
    expectMutationError(
      () => store.merge({
        targetId: target.id,
        sourceIds: [999999],
        expectedRevision: 1,
        expectedSourceRevisions: [{ id: 999999, revision: 1 }],
      }),
      { code: "MEMORY_NOT_FOUND", id: 999999, operation: "memory_merge" },
    );
    const foreign = store.write("foreign strict source", [], { scope: "elsewhere", force: true }).record;
    // Visible cross-scope source (no scope filter): SCOPE_MISMATCH, metadata only.
    expectMutationError(
      () => store.merge({
        targetId: target.id,
        sourceIds: [foreign.id],
        expectedRevision: 1,
        expectedSourceRevisions: [{ id: foreign.id, revision: 1 }],
      }),
      { code: "MEMORY_SCOPE_MISMATCH", id: foreign.id },
    );
    expect(store.count()).toBe(4);
    const scoped = store.write("scoped strict target", [], { scope: "proj", force: true }).record;
    const scopedOther = store.write("scoped other", [], { scope: "other", force: true }).record;
    expectMutationError(
      () => store.merge({
        targetId: scoped.id,
        sourceIds: [scopedOther.id],
        expectedRevision: 1,
        expectedSourceRevisions: [{ id: scopedOther.id, revision: 1 }],
      }),
      { code: "MEMORY_SCOPE_MISMATCH", id: scopedOther.id },
    );
    expect(store.count()).toBe(6);
    expect(store.list().find((r) => r.id === s1.id)).toBeDefined();
  });

  it.each([
    { label: "missing expectedRevision", input: { expectedSourceRevisions: [{ id: 2, revision: 1 }] } },
    { label: "missing source declaration", input: { expectedRevision: 1 } },
    { label: "partial declaration", sourceIds: [2, 3], input: { expectedRevision: 1, expectedSourceRevisions: [{ id: 2, revision: 1 }] } },
    { label: "duplicate declaration", input: { expectedRevision: 1, expectedSourceRevisions: [{ id: 2, revision: 1 }, { id: 2, revision: 1 }] } },
    { label: "extra unknown id", input: { expectedRevision: 1, expectedSourceRevisions: [{ id: 2, revision: 1 }, { id: 55, revision: 1 }] } },
    { label: "target declared as source", input: { expectedRevision: 1, expectedSourceRevisions: [{ id: 1, revision: 1 }] } },
    { label: "empty source list", input: { expectedRevision: 1, expectedSourceRevisions: [] } },
    { label: "null entries", input: { expectedRevision: 1, expectedSourceRevisions: [null] } },
    { label: "malformed entry shape", input: { expectedRevision: 1, expectedSourceRevisions: [{ id: 2 }] } },
    { label: "zero revision entry", input: { expectedRevision: 1, expectedSourceRevisions: [{ id: 2, revision: 0 }] } },
    { label: "malformed target", input: { expectedRevision: 0, expectedSourceRevisions: [{ id: 2, revision: 1 }] } },
  ])("rejects $label with MEMORY_INVALID_ARGUMENT and no writes", ({ input, sourceIds: caseSources }) => {
    const { store, target, s1 } = fixture();
    expectMutationError(
      () => store.merge({
        targetId: target.id,
        sourceIds: caseSources ?? [s1.id],
        ...(input as { expectedRevision?: number; expectedSourceRevisions?: Array<{ id: number; revision: number }> }),
      }),
      { code: "MEMORY_INVALID_ARGUMENT", operation: "memory_merge", id: target.id },
    );
    expect(store.count()).toBe(3);
    expect(store.list().map((r) => r.revision)).toEqual([1, 1, 1]);
  });

  it("a non-array expectedSourceRevisions is rejected", () => {
    const { store, target, s1 } = fixture();
    expectMutationError(
      () => store.merge({
        targetId: target.id,
        sourceIds: [s1.id],
        expectedRevision: 1,
        expectedSourceRevisions: { [s1.id]: 1 } as never,
      }),
      { code: "MEMORY_INVALID_ARGUMENT" },
    );
    expect(store.count()).toBe(3);
  });
});

describe("versioned import", () => {
  function record(overrides: Partial<Parameters<MemoryStore["importRecords"]>[0][number]> = {}) {
    return {
      id: 7, text: "imported fact", tags: "x", scope: "work", pinned: false,
      createdAt: 10, updatedAt: 20, lastConfirmedAt: 15, ...overrides,
    };
  }

  it("preserves explicitly versioned records and validates them", () => {
    const { store } = fileStore();
    expect(store.importRecords([record({ revision: 9 })])).toEqual({ imported: 1, skipped: 0 });
    expect(store.list()[0]!.revision).toBe(9);
    expect(store.importRecords([record({ revision: 9 })])).toEqual({ imported: 0, skipped: 1 });
    expect(() => store.importRecords([record({ revision: 8 })])).toThrow(/conflicts/);
    expect(() => store.importRecords([record({ id: 8, revision: 0 })])).toThrow(/invalid revision/);
    expect(() => store.importRecords([record({ id: 8, revision: 1.5 })])).toThrow(/invalid revision/);
    expect(store.count()).toBe(1);
  });

  it("rolls back the whole batch when a later record conflicts", () => {
    const { store } = fileStore();
    expect(store.importRecords([record()])).toEqual({ imported: 1, skipped: 0 });
    expect(() =>
      store.importRecords([record({ id: 9, text: "new import", revision: 3 }), record({ text: "conflict" })]),
    ).toThrow(/conflicts/);
    expect(store.count()).toBe(1);
    expect(store.list()[0]!.revision).toBe(1);
  });
});

describe("prompt rendering of revisions", () => {
  it("promptLine renders rev only for records that carry one", async () => {
    const { promptLine } = await import("../src/prompt.js");
    const fresh = Date.now();
    const base = {
      id: 3, text: "prompt rev fact", tags: "t", scope: "", pinned: false,
      createdAt: fresh, updatedAt: fresh, lastConfirmedAt: fresh,
    };
    expect(promptLine(base, [], 90)).toBe("- (#3) [t] prompt rev fact");
    expect(promptLine({ ...base, revision: 4 }, [], 90)).toBe("- (#3, rev 4) [t] prompt rev fact");
  });
});
