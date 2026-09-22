import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureSchema } from "../src/schema.js";
import { MemoryStore } from "../src/store.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ltm-locking-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "ltm.db");
}

function raw(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  cleanup.push(() => db.close());
  return db;
}

function store(path: string): MemoryStore {
  const db = new MemoryStore(path);
  cleanup.push(() => db.close());
  return db;
}

// Only tests shorten the existing timeout. No elapsed-time assertions or sleeps:
// real competing connections keep their locks until the operation has returned.
function noBusyWait() {
  const exec = DatabaseSync.prototype.exec;
  return vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
    return exec.call(this, sql === "PRAGMA busy_timeout = 5000" ? "PRAGMA busy_timeout = 0" : sql);
  });
}

function thrown(fn: () => unknown): Error & { code?: string; errcode?: number } {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error & { code?: string; errcode?: number };
  }
  throw new Error("Expected an error");
}

function expectBusy(error: ReturnType<typeof thrown>): void {
  expect(error.message).toMatch(/SQLITE_BUSY.*retry.*later/i);
  expect(error.cause).toBeInstanceOf(Error);
  expect(error.cause).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 5 });
  expect(error.code).toBe("ERR_SQLITE_ERROR");
  expect(error.errcode).toBe(5);
}

describe("store lock handling", () => {
  it("opens an initialized WAL store without DDL while another connection holds the writer lock", () => {
    const path = databasePath();
    store(path).write("committed memory", []);
    const writer = raw(path);
    writer.exec("BEGIN IMMEDIATE");
    const exec = noBusyWait();
    const reader = store(path);
    expect(reader.search("committed")).toHaveLength(1);
    expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(false);
    writer.exec("ROLLBACK");
  });

  it("reports fresh initialization lock contention with the original SQLite cause", () => {
    const path = databasePath();
    const writer = raw(path);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("BEGIN IMMEDIATE");
    const exec = noBusyWait();
    expectBusy(thrown(() => new MemoryStore(path)));
    expect(exec.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);
    writer.exec("ROLLBACK");
    expect(store(path).count()).toBe(0);
  });

  it("reports write and confirm contention without rolling back a failed BEGIN", () => {
    const path = databasePath();
    noBusyWait();
    const target = store(path);
    const writer = raw(path);
    writer.exec("BEGIN IMMEDIATE");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    exec.mockClear();
    expectBusy(thrown(() => target.write("contended", [])));
    expectBusy(thrown(() => target.confirm("*")));
    expect(exec.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);
    writer.exec("ROLLBACK");
    expect(target.count()).toBe(0);
    target.write("successful retry", []);
    expect(target.search("successful")).toHaveLength(1);
  });

  it.each(["COMMIT", "DELETE FROM memories_fts"])(
    "rolls back and preserves busy cause on %s failure",
    (statement) => {
      const target = store(":memory:");
      const cause = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      const exec = DatabaseSync.prototype.exec;
      const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
        if (sql === statement) throw cause;
        return exec.call(this, sql);
      });
      // COMMIT exercises rollback after the base and FTS writes. The callback
      // branch uses constructor FTS rebuild to exercise an exec inside a write.
      const error = thrown(() => statement === "COMMIT"
        ? target.write("rolled back", [])
        : new MemoryStore(":memory:"));
      expectBusy(error);
      expect(error.cause).toBe(cause);
      expect(spy.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
      spy.mockRestore();
      expect(target.count()).toBe(0);
      expect(target.search("rolled")).toHaveLength(0);
      target.write("still usable", []);
    },
  );

  it("preserves nonbusy ERR_SQLITE_ERROR identity and rolls back", () => {
    const target = store(":memory:");
    const cause = Object.assign(new Error("SQL logic error"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === "COMMIT") throw cause;
      return exec.call(this, sql);
    });
    expect(thrown(() => target.write("not committed", []))).toBe(cause);
    expect(thrown(() => new MemoryStore(":memory:"))).toBe(cause);
    spy.mockRestore();
    expect(target.count()).toBe(0);
  });
});

describe("schema initialization lock boundary", () => {
  it.each(["table memories_fts", "index memories_recent", "index memories_scope"])(
    "still restores a missing required %s",
    (object) => {
      const db = raw(":memory:");
      ensureSchema(db);
      db.exec(`DROP ${object}`);
      ensureSchema(db);
      expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(object.split(" ")[1]!)).toBeDefined();
    },
  );

  it.each(["1", "2"])("rechecks a concurrent initializer's version %s after acquiring the lock", (version) => {
    const path = databasePath();
    const db = raw(path);
    const other = raw(path);
    const exec = DatabaseSync.prototype.exec;
    let interleaved = false;
    vi.spyOn(db, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === "BEGIN IMMEDIATE" && !interleaved) {
        interleaved = true;
        // Deterministic interleaving: another initializer commits after our
        // unlocked preflight, immediately before our BEGIN acquires the lock.
        ensureSchema(other);
        other.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(version);
      }
      return exec.call(this, sql);
    });
    if (version === "2") {
      expect(() => ensureSchema(db)).toThrow(/newer than supported/);
    } else {
      ensureSchema(db);
    }
    expect(interleaved).toBe(true);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: version });
    expect(db.isTransaction).toBe(false);
  });

  it("rolls back fresh DDL and version stamp together on commit failure", () => {
    const db = raw(":memory:");
    const cause = new Error("commit failed");
    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(db, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === "COMMIT") throw cause;
      return exec.call(this, sql);
    });
    expect(thrown(() => ensureSchema(db))).toBe(cause);
    expect(db.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
    spy.mockRestore();
    ensureSchema(db);
  });
});
