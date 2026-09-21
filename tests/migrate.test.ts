import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { migrateLegacy } from "../src/migrate.js";
import { MemoryStore } from "../src/store.js";

const dirs: string[] = [];
const stores: MemoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a legacy dsh-memory@0.1.0 database: plain memories table plus an
 * external-content FTS index maintained by triggers, and SCHEMA_VERSION=1
 * recorded via PRAGMA user_version.
 */
function buildLegacyDb(dir: string): string {
  const path = join(dir, "memory.db");
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, content='memories', content_rowid='id');
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END;
    PRAGMA user_version = 1;
  `);
  const insert = db.prepare(
    "INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("用户是 go-gorm 组织的维护者，对 gorm 有 admin 权限", "identity gorm", 1, 1000, 2000);
  insert.run("本机 npm registry 指向内网源，发布时须显式官方源", "npm publish", 0, 3000, 4000);
  insert.run("dsh-ltm 使用 CJK 二元分词做中文检索", "search zh", 0, 5000, 6000);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return path;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("migrateLegacy (R8)", () => {
  it("copies every row, preserves the source file byte-for-byte, and keeps pinned searchable", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-ltm-legacy-"));
    dirs.push(dir);
    const source = buildLegacyDb(dir);
    const before = sha256(source);

    const targetDir = mkdtempSync(join(tmpdir(), "dsh-ltm-target-"));
    dirs.push(targetDir);
    const store = new MemoryStore(join(targetDir, "ltm.db"));
    stores.push(store);

    const report = migrateLegacy(source, store);

    expect(report.sourcePath).toBe(source);
    expect(report.sourceCount).toBe(3);
    expect(report.migratedCount).toBe(3);
    expect(report.dedupedCount).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.endedAt).toBeGreaterThanOrEqual(report.startedAt);
    expect(store.count()).toBe(3);
    expect(sha256(source)).toBe(before); // original untouched

    // pinned identity memory migrated and searchable via CJK bigrams
    const hits = store.search("gorm 维护者");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.pinned).toBe(true);
    expect(hits[0]!.scope).toBe("");
    expect(hits[0]!.lastConfirmedAt).toBe(2000); // = legacy updated_at
    expect(store.search("中文检索")).toHaveLength(1);
  });

  it("counts near-duplicates among legacy rows as deduped, not migrated", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-ltm-legacy-"));
    dirs.push(dir);
    const source = buildLegacyDb(dir);
    const db = new DatabaseSync(source);
    db.prepare(
      "INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("dsh-ltm 使用 CJK 二元分词做中文检索", "search zh dup", 0, 7000, 8000);
    db.close();

    const store = new MemoryStore(":memory:");
    stores.push(store);
    const report = migrateLegacy(source, store);
    expect(report.sourceCount).toBe(4);
    expect(report.migratedCount).toBe(3);
    expect(report.dedupedCount).toBe(1);
    expect(store.count()).toBe(3);
  });

  it("records blank-text rows as failures instead of aborting", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-ltm-legacy-"));
    dirs.push(dir);
    const source = buildLegacyDb(dir);
    const db = new DatabaseSync(source);
    db.prepare(
      "INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("   ", "blank", 0, 9000, 9500);
    db.close();

    const store = new MemoryStore(":memory:");
    stores.push(store);
    const report = migrateLegacy(source, store);
    expect(report.sourceCount).toBe(4);
    expect(report.migratedCount).toBe(3);
    expect(report.failures).toEqual([
      { legacyId: 4, reason: "text is blank or not a string" },
    ]);
  });

  it("works against a real WAL database with an unchecked-in -wal file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-ltm-legacy-"));
    dirs.push(dir);
    const source = buildLegacyDb(dir);
    // leave rows in the WAL (no checkpoint) to prove sidecar copying
    const db = new DatabaseSync(source);
    db.prepare(
      "INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("wal-only row", "", 0, 10_000, 11_000);
    const before = sha256(source);

    const store = new MemoryStore(":memory:");
    stores.push(store);
    const report = migrateLegacy(source, store);
    expect(report.sourceCount).toBe(4);
    expect(report.migratedCount).toBe(4);
    expect(report.failures).toEqual([]);
    expect(sha256(source)).toBe(before);
    // sidecar may have been checkpointed by the OS on the *copy* only; the
    // source file itself must not change. (A changed -wal is tolerated: the
    // source db bytes are the rollback anchor.)
    expect(store.search("wal-only")).toHaveLength(1);
  });
});
