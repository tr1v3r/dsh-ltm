/** CLI coverage for the repository-only one-shot migration entry point. */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrationCli } from "../scripts/legacy-migration/cli.js";
import { MemoryStore } from "../src/store.js";

const dirs: string[] = [];
const stores: MemoryStore[] = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
let outChunks: string[] = [];
let errChunks: string[] = [];

beforeEach(() => {
  outChunks = [];
  errChunks = [];
  process.stdout.write = ((chunk: unknown) => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function buildLegacyDb(dir: string): string {
  const path = join(dir, "memory.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, content='memories', content_rowid='id');
    PRAGMA user_version = 1;
  `);
  db.prepare(
    "INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("legacy fact", "tag", 1, 1000, 2000);
  db.close();
  return path;
}

describe("legacy migration CLI (repo-only)", () => {
  it("prints usage for --help without touching any file", () => {
    expect(runMigrationCli(["--help"])).toBe(0);
    expect(outChunks.join("")).toContain("usage:");
  });

  it("migrates a legacy source into an explicit destination", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-legacy-cli-"));
    dirs.push(dir);
    const source = buildLegacyDb(dir);
    const target = join(dir, "ltm.db");
    const before = createHash("sha256").update(readFileSync(source)).digest("hex");

    expect(runMigrationCli(["--source", source, "--db", target])).toBe(0);
    const report = JSON.parse(outChunks.join(""));
    expect(report).toMatchObject({ sourceCount: 1, migratedCount: 1, failures: [] });
    expect(createHash("sha256").update(readFileSync(source)).digest("hex")).toBe(before);

    const store = new MemoryStore(target);
    stores.push(store);
    expect(store.list()).toHaveLength(1);
  });

  it("rejects argument mistakes without creating a destination", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-legacy-cli-bad-"));
    dirs.push(dir);
    const target = join(dir, "absent.db");
    for (const argv of [[], ["--source", dir], ["--db", target, "--extra", "x"], ["--source", "--db"]]) {
      outChunks.length = 0;
      errChunks.length = 0;
      expect(runMigrationCli(argv)).toBe(1);
      expect(errChunks.join("")).toContain("legacy-migration:");
      expect(existsSync(target)).toBe(false);
    }
  });

  it("rejects a modern LTM source (including the destination itself) before writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-legacy-cli-modern-"));
    dirs.push(dir);
    const target = join(dir, "ltm.db");
    const store = new MemoryStore(target);
    stores.push(store);
    store.write("private project fact", [], { scope: "project" });
    const before = store.list();
    const bytes = [target, target + "-wal"].map((file) =>
      existsSync(file) ? readFileSync(file).toString("base64") : null);

    expect(runMigrationCli(["--source", target, "--db", target])).toBe(1);
    expect(errChunks.join("")).toContain("unsupported legacy source schema");
    expect(store.list()).toEqual(before);
    expect([target, target + "-wal"].map((file) =>
      existsSync(file) ? readFileSync(file).toString("base64") : null)).toEqual(bytes);
    expect(store.list({ scope: "" })).toEqual([]);
  });
});
