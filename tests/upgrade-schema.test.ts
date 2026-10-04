import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertUpgradeableV1, REVISION_COLUMN_DDL, SCHEMA_VERSION } from "../src/schema.js";
import { joinTokens, tokenize } from "../src/tokenize.js";
import { MemoryStore } from "../src/store.js";
import { upgradeSchema } from "../src/upgrade.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "ltm-upgrade-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The exact v1 DDL this package shipped before the revision column. */
const V1_DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    text              TEXT    NOT NULL,
    tags              TEXT    NOT NULL DEFAULT '',
    scope             TEXT    NOT NULL DEFAULT '',
    pinned            INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    last_confirmed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memories_recent ON memories (updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope);
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    text, tags, scope,
    tokenize = 'unicode61'
  );
  INSERT INTO meta (key, value) VALUES ('schema_version', '1');
  INSERT INTO meta (key, value) VALUES ('fts_token_version', '2');
`;

interface V1Row {
  text: string;
  tags: string;
  scope: string;
  pinned: number;
  created_at: number;
  updated_at: number;
  last_confirmed_at: number;
}

function seedV1(db: DatabaseSync): void {
  db.exec(V1_DDL);
  const rows: V1Row[] = [
    { text: "v1 global fact", tags: "legacy", scope: "", pinned: 1, created_at: 100, updated_at: 200, last_confirmed_at: 150 },
    { text: "v1 project fact 数据库迁移", tags: "legacy proj", scope: "git:abc", pinned: 0, created_at: 110, updated_at: 210, last_confirmed_at: 160 },
  ];
  const fts = db.prepare("INSERT INTO memories_fts (rowid, text, tags, scope) VALUES (?, ?, ?, ?)");
  const ftsValue = (text: string): string => joinTokens(tokenize(text));
  for (const [index, row] of rows.entries()) {
    const id = index + 1;
    db.prepare(
      `INSERT INTO memories (id, text, tags, scope, pinned, created_at, updated_at, last_confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, row.text, row.tags, row.scope, row.pinned, row.created_at, row.updated_at, row.last_confirmed_at);
    fts.run(id, ftsValue(row.text), ftsValue(row.tags), ftsValue(row.scope));
  }
}

function v1Database(): string {
  const root = dir();
  const path = join(root, "ltm.db");
  const db = new DatabaseSync(path);
  seedV1(db);
  db.close();
  return path;
}

/** Run `preWal` then WAL-only `postWal` SQL and SIGKILL: committed frames stay in -wal. */
function uncheckpointedDatabase(preWal: string, postWal: string): string {
  const root = dir();
  const path = join(root, "ltm.db");
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec(${JSON.stringify(preWal)});
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.exec(${JSON.stringify(postWal)});
    process.kill(process.pid, "SIGKILL");
  `;
  const child = spawnSync(process.execPath, ["-e", script, path], { stdio: ["ignore", "ignore", "pipe"] });
  if (child.signal !== "SIGKILL") {
    throw new Error(`wal child failed: ${String(child.status)} ${String(child.stderr)}`);
  }
  expect(existsSync(path + "-wal")).toBe(true);
  return path;
}

/** A v1 database whose committed WAL frames only exist in the -wal file. */
function uncheckpointedV1Database(): string {
  const root = dir();
  const path = join(root, "ltm.db");
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec(${JSON.stringify(V1_DDL)});
    db.prepare("INSERT INTO memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("committed wal v1 fact", "x", "", 0, 1, 2, 3);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.prepare("INSERT INTO memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("second wal v1 fact", "y", "", 0, 4, 5, 6);
    process.kill(process.pid, "SIGKILL");
  `;
  const child = spawnSync(process.execPath, ["-e", script, path], { stdio: ["ignore", "ignore", "pipe"] });
  if (child.signal !== "SIGKILL") {
    throw new Error(`wal child failed: ${String(child.status)} ${String(child.stderr)}`);
  }
  expect(existsSync(path + "-wal")).toBe(true);
  return path;
}

function versionedMeta(value: string, extraSql = ""): string {
  const root = dir();
  const path = join(root, "ltm.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);${extraSql}`);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(value);
  db.close();
  return path;
}

describe("metadata and non-reusable identity preflight", () => {
  const malformed: Array<[string, (ddl: string) => string]> = [
    ["non-primary meta key", (ddl) => ddl.replace("key   TEXT PRIMARY KEY", "key TEXT")],
    ["unique but non-primary meta key", (ddl) => ddl.replace("key   TEXT PRIMARY KEY", "key TEXT UNIQUE")],
    ["wrong meta key type", (ddl) => ddl.replace("key   TEXT PRIMARY KEY", "key BLOB PRIMARY KEY")],
    ["wrong meta value type", (ddl) => ddl.replace("value TEXT NOT NULL", "value BLOB NOT NULL")],
    ["nullable meta value", (ddl) => ddl.replace("value TEXT NOT NULL", "value TEXT")],
    ["composite meta primary key", (ddl) => ddl.replace("key   TEXT PRIMARY KEY", "key TEXT").replace("value TEXT NOT NULL", "value TEXT NOT NULL, PRIMARY KEY(key, value)")],
    ["ambiguous duplicate versions", (ddl) => ddl.replace("key   TEXT PRIMARY KEY", "key TEXT") + "INSERT INTO meta VALUES ('schema_version', '99');"],
    ["missing AUTOINCREMENT", (ddl) => ddl.replace("PRIMARY KEY AUTOINCREMENT", "PRIMARY KEY")],
    ["comment-only AUTOINCREMENT", (ddl) => ddl.replace("PRIMARY KEY AUTOINCREMENT", "PRIMARY KEY /* AUTOINCREMENT */")],
    ["string-only AUTOINCREMENT", (ddl) => ddl.replace("PRIMARY KEY AUTOINCREMENT", "PRIMARY KEY").replace("DEFAULT ''", "DEFAULT 'AUTOINCREMENT'")],
    ["other table owns sqlite_sequence", (ddl) => ddl.replace("PRIMARY KEY AUTOINCREMENT", "PRIMARY KEY") + "CREATE TABLE other (id INTEGER PRIMARY KEY AUTOINCREMENT);"],
    ["descending reusable primary key", (ddl) => ddl.replace("PRIMARY KEY AUTOINCREMENT", "PRIMARY KEY DESC")],
  ];

  it.each(malformed)("refuses %s in v1 and v2 without changing main/WAL", (_label, modify) => {
    for (const [version, inWal] of [[1, false], [1, true], [2, false], [2, true]] as const) {
      let ddl = modify(V1_DDL);
      if (version === 2) ddl += `ALTER TABLE memories ADD COLUMN ${REVISION_COLUMN_DDL}; UPDATE meta SET value = '2' WHERE key = 'schema_version';`;
      const path = inWal ? uncheckpointedDatabase("", ddl) : join(dir(), "main.db");
      if (!inWal) {
        const fixture = new DatabaseSync(path);
        try { fixture.exec(ddl); } finally { fixture.close(); }
      }
      const hashes = (): string[] => [sha256(path), ...(inWal ? [sha256(path + "-wal")] : [])];
      const before = hashes();
      const backup = join(dir(), "refused.bak");
      expect(() => upgradeSchema(path, { backupPath: backup })).toThrow(/meta|memories/);
      expect(() => new MemoryStore(path)).toThrow(/meta|memories|older than supported/);
      if (version === 1) {
        const probe = new DatabaseSync(path, { readOnly: true });
        try { expect(() => assertUpgradeableV1(probe)).toThrow(/meta|structure/); }
        finally { probe.close(); }
      }
      expect(existsSync(backup)).toBe(false);
      expect(hashes()).toEqual(before);
    }
  });

  it.each(["id INTEGER PRIMARY KEY AUTOINCREMENT", '"id" "INTEGER" PRIMARY /* gap */ KEY -- gap\n AUTOINCREMENT', '[id] INTEGER PRIMARY KEY AUTOINCREMENT', '`id` INTEGER PRIMARY KEY AUTOINCREMENT'])(
    "accepts %s and never reuses deleted identity", (idDdl) => {
      const path = uncheckpointedDatabase("", V1_DDL.replace("id                INTEGER PRIMARY KEY AUTOINCREMENT", idDdl));
      upgradeSchema(path);
      const store = new MemoryStore(path);
      try {
        const first = store.write("first identity", []).record;
        expect(store.forget(first.id)).toBe(true);
        const second = store.write("second identity", []).record;
        expect(second.id).toBeGreaterThan(first.id);
        expect(second.revision).toBe(1);
        expect(() => store.update(first.id, { text: "stale overwrite" }, undefined, { expectedRevision: first.revision! })).toThrow(/no such memory/);
        expect(store.list().find((record) => record.id === second.id)?.text).toBe("second identity");
      } finally { store.close(); }
    },
  );
});

describe("upgradeSchema classification and refusals", () => {
  it("never creates a missing database", () => {
    const path = join(dir(), "absent.db");
    expect(() => upgradeSchema(path)).toThrow(/requires an existing database file/);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses an empty database without upgrading it", () => {
    const path = join(dir(), "empty.db");
    new DatabaseSync(path).close();
    const before = sha256(path);
    expect(() => upgradeSchema(path)).toThrow(/empty; nothing to upgrade/);
    expect(sha256(path)).toBe(before);
  });

  it("reports an already-current v2 database as a metadata-only no-op", () => {
    const root = dir();
    const path = join(root, "ltm.db");
    const store = new MemoryStore(path);
    store.write("current schema fact", []);
    store.close();
    const before = sha256(path);
    const report = upgradeSchema(path);
    expect(report).toEqual({ upgraded: false, schemaVersion: SCHEMA_VERSION, recordCount: 0 });
    expect(sha256(path)).toBe(before);
  });

  it.each([
    ["unknown no-meta database", () => { const p = join(dir(), "u.db"); const db = new DatabaseSync(p); db.exec("CREATE TABLE other (a TEXT)"); db.close(); return p; }],
    ["malformed version string", () => versionedMeta("01")],
    ["schema 0", () => versionedMeta("0")],
    ["newer schema", () => versionedMeta("3")],
    ["fake v1 with a revision column", () => versionedMeta("1", `CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_confirmed_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1)`)],
    ["v1 with unexpected extra column", () => versionedMeta("1", `CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_confirmed_at INTEGER NOT NULL, extra TEXT)`)],
  ])("refuses %s without changing main or committed WAL bytes", (_label, build) => {
    const path = build();
    const mainBefore = sha256(path);
    const walPath = path + "-wal";
    const walBefore = existsSync(walPath) ? sha256(walPath) : undefined;
    expect(() => upgradeSchema(path)).toThrow(/dsh-ltm:/);
    expect(sha256(path)).toBe(mainBefore);
    if (walBefore !== undefined) expect(sha256(walPath)).toBe(walBefore);
  });
});

describe("upgradeSchema v1 → v2", () => {
  it("upgrades in place, initializing revisions at 1 and preserving everything else", () => {
    const path = v1Database();
    const report = upgradeSchema(path);
    expect(report.upgraded).toBe(true);
    expect(report.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.recordCount).toBe(2);
    expect(existsSync(report.backupPath!)).toBe(true);

    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: String(SCHEMA_VERSION) });
    const rows = db.prepare("SELECT * FROM memories ORDER BY id").all() as unknown as Array<Record<string, unknown>>;
    expect(rows.map((row) => [row.text, row.tags, row.scope, row.pinned, row.revision])).toEqual([
      ["v1 global fact", "legacy", "", 1, 1],
      ["v1 project fact 数据库迁移", "legacy proj", "git:abc", 0, 1],
    ]);
    expect(rows[0]).toMatchObject({ created_at: 100, updated_at: 200, last_confirmed_at: 150 });
    db.close();

    // The upgraded store is fully live: FTS still finds CJK and ids persist.
    const store = new MemoryStore(path);
    cleanup.push(() => store.close());
    expect(store.search("数据库")).toHaveLength(1);
    expect(store.list()[0]!.id).toBe(1);
    expect(store.update(1, { text: "v1 global fact revised" })!.revision).toBe(2);
  });

  it("upgrades a v1 database whose committed frames are still in the -wal file", () => {
    const path = uncheckpointedV1Database();
    const report = upgradeSchema(path);
    expect(report.upgraded).toBe(true);
    expect(report.recordCount).toBe(2);
    const store = new MemoryStore(path);
    cleanup.push(() => store.close());
    expect(store.list().map((r) => r.text).sort()).toEqual(["committed wal v1 fact", "second wal v1 fact"]);
    expect(store.list().every((r) => r.revision === 1)).toBe(true);
  });

  it("the normal store open still refuses v1 and leaves bytes untouched", () => {
    const path = v1Database();
    const before = sha256(path);
    expect(() => new MemoryStore(path)).toThrow(/older than supported 2.*upgrade-schema/s);
    expect(sha256(path)).toBe(before);
  });

  it("the backup is a valid v1 SQLite snapshot containing committed WAL data", () => {
    const path = uncheckpointedV1Database();
    const report = upgradeSchema(path, { backupPath: join(dir(), "explicit.bak") });
    expect(report.backupPath).toContain("explicit.bak");
    const backup = new DatabaseSync(report.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "1" });
    const rows = backup.prepare("SELECT text FROM memories ORDER BY id").all() as unknown as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.text).sort()).toEqual(["committed wal v1 fact", "second wal v1 fact"]);
    // The snapshot is the pre-upgrade shape: no revision column yet.
    expect("revision" in (rows[0] ?? {})).toBe(false);
    backup.close();
  });

  it("the default backup lands beside the database and an explicit reuse is refused", () => {
    const path = v1Database();
    const first = upgradeSchema(path);
    expect(first.backupPath).toMatch(/\.pre-v2-backup-/);
    // Already current: metadata-only no-op, no second backup, old one survives.
    const second = upgradeSchema(path);
    expect(second.upgraded).toBe(false);
    expect(second.backupPath).toBeUndefined();
    expect(existsSync(first.backupPath!)).toBe(true);
    // A fresh v1 database cannot reuse the taken backup path.
    expect(() => upgradeSchema(v1Database(), { backupPath: first.backupPath! }))
      .toThrow(/already exists/);
  });

  it("rejects a --backup target that exists or collides with the database/sidecars", () => {
    for (const build of [
      () => { const p = v1Database(); return { path: p, target: p }; }, // the database itself
      () => { const p = v1Database(); return { path: p, target: p + "-wal" }; },
      () => { const p = v1Database(); return { path: p, target: p + "-shm" }; },
      () => {
        const p = v1Database();
        const target = join(dir(), "taken.bak");
        new DatabaseSync(target).close();
        return { path: p, target };
      },
    ]) {
      const { path, target } = build();
      const mainBefore = sha256(path);
      expect(() => upgradeSchema(path, { backupPath: target })).toThrow(
        /must not target the database|already exists|never overwritten|SQLite sidecars/,
      );
      expect(sha256(path)).toBe(mainBefore);
      // Nothing was upgraded.
      const probe = new DatabaseSync(path, { readOnly: true });
      expect(probe.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
        .toEqual({ value: "1" });
      probe.close();
    }
  });

  it("keeps fts_token_version untouched by the upgrade", () => {
    const path = v1Database();
    upgradeSchema(path);
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'fts_token_version'").get())
      .toEqual({ value: "2" });
    db.close();
  });

  it("reports a readable private backup and preserves cause after a real lock timeout", () => {
    const path = v1Database();
    const backup = join(dir(), "locked.bak");
    const writer = new DatabaseSync(path);
    writer.exec("BEGIN IMMEDIATE");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    let failure: unknown;
    let attemptedRollback = false;
    try { upgradeSchema(path, { backupPath: backup }); }
    catch (error) { failure = error; }
    finally {
      attemptedRollback = exec.mock.calls.some(([sql]) => sql === "ROLLBACK");
      exec.mockRestore();
      try { writer.exec("ROLLBACK"); } finally { writer.close(); }
    }
    // The upgrader never acquired a transaction, so must not roll it back.
    expect(attemptedRollback).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("database is locked");
    expect((failure as Error).message).toContain(`backup kept at ${backup}`);
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toContain("database is locked");
    const snapshot = new DatabaseSync(backup, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "1" });
      expect(snapshot.prepare("SELECT count(*) AS n FROM memories").get()).toEqual({ n: 2 });
    } finally { snapshot.close(); }
    // The failed upgrader closed its handle; a later normal upgrade succeeds.
    expect(upgradeSchema(path).upgraded).toBe(true);
  }, 15000);

  it("rolls back the column and version stamp when the ALTER or COMMIT fails, and keeps the backup", () => {
    for (const statement of ["ALTER TABLE memories ADD COLUMN", "COMMIT"]) {
      const path = v1Database();
      const backup = join(dir(), `guard-${statement.includes("ALTER") ? "ddl" : "commit"}.bak`);
      const exec = DatabaseSync.prototype.exec;
      const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql.startsWith(statement)) throw new Error("forced failure");
        return exec.call(this, sql);
      });
      expect(() => upgradeSchema(path, { backupPath: backup })).toThrow(/forced failure/);
      spy.mockRestore();
      // No half-upgraded state: still a readable v1 with the old column set.
      const probe = new DatabaseSync(path, { readOnly: true });
      expect(probe.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
        .toEqual({ value: "1" });
      const columns = probe.prepare("PRAGMA table_info(memories)").all() as unknown as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "revision")).toBe(false);
      probe.close();
      expect(existsSync(backup)).toBe(true);
    }
  });

  it("re-verifies under the write lock and treats a concurrent upgrade as already-current", () => {
    const path = v1Database();
    const exec = DatabaseSync.prototype.exec;
    let interleaved = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && !interleaved) {
        interleaved = true;
        // Another writer upgrades between our preflight and our lock.
        upgradeSchema(path);
      }
      return exec.call(this, sql);
    });
    // Explicit backup path: the nested racer takes the default name in the
    // same second, and defaults never overwrite an existing file.
    const outerBackup = join(dir(), "outer.bak");
    const report = upgradeSchema(path, { backupPath: outerBackup });
    expect(interleaved).toBe(true);
    expect(report.upgraded).toBe(false);
    // The no-op race branch keeps and REPORTS this run's backup instead of
    // leaving an unannounced sensitive snapshot behind.
    expect(report.backupPath).toBe(outerBackup);
    expect(existsSync(outerBackup)).toBe(true);
    expect(report.note).toContain("concurrent upgrade");
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "2" });
    db.close();
  });

  it("fails loudly when the database structure changes between preflight and lock", () => {
    const path = v1Database();
    const exec = DatabaseSync.prototype.exec;
    let interleaved = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && !interleaved) {
        interleaved = true;
        const racer = new DatabaseSync(path);
        racer.exec("ALTER TABLE memories ADD COLUMN intruder TEXT");
        racer.close();
      }
      return exec.call(this, sql);
    });
    expect(() => upgradeSchema(path)).toThrow(/changed while the upgrade was starting|unexpected columns/);
  });
});

describe("preflight integrity: FTS shape and base rows (repair round 2)", () => {
  const MALFORMED_FTS: Array<[string, string]> = [
    ["plain table shadow", "CREATE TABLE memories_fts (a TEXT)"],
    ["fts5 with a foreign tokenizer", "CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, scope, tokenize = 'porter')"],
    ["external-content fts5", "CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, scope, content='memories', content_rowid='id')"],
    ["fts5 with wrong columns", "CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags)"],
    ["unindexed text column", "CREATE VIRTUAL TABLE memories_fts USING fts5(text UNINDEXED, tags, scope, tokenize = 'unicode61')"],
    ["unindexed scope column", "CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, scope unindexed, tokenize = 'unicode61')"],
    ["detail layout option", "CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, scope, tokenize = 'unicode61', detail='none')"],
    ["prefix layout option", "CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, scope, tokenize = 'unicode61', prefix='2')"],
    ["tokenizer with arguments", "CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, scope, tokenize = 'unicode61 remove_diacritics 2')"],
    ["option hidden behind a comment", "CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, scope /* sneaky */, tokenize = 'unicode61', prefix='2')"],
    ["column typed with a string literal", "CREATE VIRTUAL TABLE memories_fts USING fts5('text', tags, scope, tokenize = 'unicode61')"],
  ];

  /**
   * A seeded v1 database plus one extra statement, optionally committed into
   * -wal only. `replaceFts` drops the stock FTS table so the extra statement
   * can install a malformed replacement instead of colliding with it.
   */
  function v1With(statement: string, inWal: boolean, replaceFts = false): string {
    const ddl = replaceFts ? V1_DDL.replace(/CREATE VIRTUAL TABLE[^;]*;/, "") : V1_DDL;
    const seed = "INSERT INTO memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at) VALUES ('v1 global fact', 'legacy', '', 1, 100, 200, 150)";
    const preWal = `${ddl};${seed};${inWal ? "" : statement}`;
    const postWal = inWal ? statement : "CREATE TABLE IF NOT EXISTS filler (a TEXT)";
    return uncheckpointedDatabase(preWal, postWal);
  }

  it.each(MALFORMED_FTS.map(([label]) => label))(
    "refuses a v1 database with %s before any rw handle, backup, or ALTER",
    (label) => {
      const [_, statement] = MALFORMED_FTS.find(([l]) => l === label)!;
      for (const inWal of [false, true]) {
        const path = v1With(statement, inWal, true);
        const mainBefore = sha256(path);
        const walBefore = sha256(path + "-wal");
        const backup = join(dir(), `refused-${inWal ? "wal" : "main"}.bak`);
        expect(() => upgradeSchema(path, { backupPath: backup })).toThrow(/memories_fts/);
        // Refusal happened read-only: no backup, no revision column, and the
        // main + committed WAL bytes are untouched.
        expect(existsSync(backup)).toBe(false);
        expect(sha256(path)).toBe(mainBefore);
        expect(sha256(path + "-wal")).toBe(walBefore);
        const probe = new DatabaseSync(path, { readOnly: true });
        expect(probe.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
          .toEqual({ value: "1" });
        const columns = probe.prepare("PRAGMA table_info(memories)").all() as unknown as Array<{ name: string }>;
        expect(columns.some((column) => column.name === "revision")).toBe(false);
        probe.close();
      }
    },
  );

  const BAD_ROWS: Array<[string, string]> = [
    ["id zero", "INSERT INTO memories (id, text, tags, scope, pinned, created_at, updated_at, last_confirmed_at) VALUES (0, 'x', '', '', 0, 1, 1, 1)"],
    ["id above the safe range", "INSERT INTO memories (id, text, tags, scope, pinned, created_at, updated_at, last_confirmed_at) VALUES (9007199254740992, 'x', '', '', 0, 1, 1, 1)"],
    ["text stored as a blob", "UPDATE memories SET text = x'00' WHERE id = 1"],
    ["tags stored as a blob", "UPDATE memories SET tags = x'00' WHERE id = 1"],
    ["scope stored as a blob", "UPDATE memories SET scope = x'00' WHERE id = 1"],
    ["pinned outside 0/1", "UPDATE memories SET pinned = 2 WHERE id = 1"],
    ["negative created_at", "UPDATE memories SET created_at = -1 WHERE id = 1"],
    ["fractional updated_at", "UPDATE memories SET updated_at = 1.5 WHERE id = 1"],
    ["last_confirmed_at above the safe range", "UPDATE memories SET last_confirmed_at = 9007199254740992 WHERE id = 1"],
  ];

  it.each(BAD_ROWS.map(([label]) => label))(
    "refuses a v1 database with a %s row and never upgrades or backs it up",
    (label) => {
      const [_, statement] = BAD_ROWS.find(([l]) => l === label)!;
      for (const inWal of [false, true]) {
        const path = v1With(statement, inWal);
        const mainBefore = sha256(path);
        const walBefore = sha256(path + "-wal");
        const backup = join(dir(), `refused-row-${inWal ? "wal" : "main"}.bak`);
        let message = "";
        try {
          upgradeSchema(path, { backupPath: backup });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toMatch(/malformed memories row/);
        // Metadata-only: no stored prose or raw values in the error.
        expect(message).not.toContain("v1 global fact");
        expect(existsSync(backup)).toBe(false);
        expect(sha256(path)).toBe(mainBefore);
        expect(sha256(path + "-wal")).toBe(walBefore);
        const probe = new DatabaseSync(path, { readOnly: true });
        expect(probe.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
          .toEqual({ value: "1" });
        probe.close();
      }
    },
  );

  const LEGAL_FTS: Array<[string, string]> = [
    ["quoted identifiers", `CREATE VIRTUAL TABLE memories_fts USING fts5("text", [tags], \`scope\`, tokenize = 'unicode61')`],
    ["comments and extra whitespace", "CREATE VIRTUAL TABLE memories_fts -- object comment\n USING fts5(\n  text, /* col */ tags, scope,\n  -- option comment\n  tokenize = 'unicode61' /* tail */\n)"],
    ["schema-qualified name", "CREATE VIRTUAL TABLE main.memories_fts USING fts5(text, tags, scope, tokenize='unicode61')"],
    ["option-like comment next to a clean layout", "CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, scope, -- content='memories'\n tokenize = 'unicode61')"],
  ];

  it.each(LEGAL_FTS.map(([label]) => label))(
    "accepts the standard definition with %s and upgrades normally",
    (label) => {
      const [_, statement] = LEGAL_FTS.find(([l]) => l === label)!;
      const path = v1With(statement, false, true);
      const report = upgradeSchema(path);
      expect(report.upgraded).toBe(true);
      expect(report.recordCount).toBe(1);
      // The variant FTS is accepted (a malformed one would have refused the
      // upgrade); the store opens and reads the base rows through it.
      const store = new MemoryStore(path);
      cleanup.push(() => store.close());
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]!.revision).toBe(1);
    },
  );

  it("a v1 database whose FTS and rows are healthy still upgrades through the WAL path", () => {
    const path = uncheckpointedV1Database();
    const report = upgradeSchema(path);
    expect(report.upgraded).toBe(true);
    expect(report.recordCount).toBe(2);
  });
});
