import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runCli } from "../src/cli.js";
import { MemoryStore } from "../src/store.js";

let dir: string;
let chunks: string[];
const realWrite = process.stdout.write.bind(process.stdout);
const realErrWrite = process.stderr.write.bind(process.stderr);
let errChunks: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ltm-cli-"));
  chunks = [];
  errChunks = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = realWrite;
  process.stderr.write = realErrWrite;
  rmSync(dir, { recursive: true, force: true });
});

const db = () => join(dir, "ltm.db");
const stdout = () => chunks.join("");
/** Clear captured output so the next JSON.parse sees only one command's output. */
const resetOut = () => { chunks.length = 0; errChunks.length = 0; };

/** Build a legacy dsh-memory-format database (SCHEMA_VERSION=1). */
function legacyFixture(pinOne = false): string {
  const legacyPath = join(dir, "memory.db");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE memories_fts
      USING fts5(text, tags, content='memories', content_rowid='id');
  `);
  const rows: [string, string, number][] = [
    ["legacy preference: use pnpm", "preference build", pinOne ? 1 : 0],
    ["旧的中文记忆：跨会话记忆很重要", "", 0],
    ["legacy convention: escape {{ before templating", "safety", 0],
  ];
  for (const [text, tags, pinned] of rows) {
    legacy
      .prepare(
        "INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(text, tags, pinned, 1_000, 2_000);
  }
  legacy.exec(
    "INSERT INTO memories_fts (rowid, text, tags) SELECT id, text, tags FROM memories",
  );
  legacy.exec("PRAGMA user_version = 1");
  legacy.close();
  return legacyPath;
}

describe("cli", () => {
  it("usage/help exits 0", async () => {
    expect(await runCli(["help"])).toBe(0);
    expect(stdout()).toContain("usage:");
  });

  it("write-then-search-list-show-edit-tag-pin-confirm lifecycle", async () => {
    expect(
      await runCli(["--db", db(), "search", "nothing", "--json"]),
    ).toBe(0);
    // Write through the engine store so the FTS index stays consistent.
    const writer = new MemoryStore(db());
    const { record: written } = writer.write("cli fact alpha", ["cli"]);
    writer.close();
    const id = written!.id;

    expect(await runCli(["--db", db(), "search", "alpha"])).toBe(0);
    expect(stdout()).toContain("cli fact alpha");

    resetOut();
    expect(await runCli(["--db", db(), "list", "--json"])).toBe(0);
    expect(JSON.parse(stdout())).toHaveProperty("records");

    expect(await runCli(["--db", db(), "show", String(id)])).toBe(0);
    expect(stdout()).toContain("confirmed:");

    expect(
      await runCli(["--db", db(), "edit", String(id), "--text", "revised fact", "--json"]),
    ).toBe(0);
    expect(stdout()).toContain("revised fact");

    expect(
      await runCli(["--db", db(), "tag", String(id), "--tags", "x,y", "--json"]),
    ).toBe(0);
    expect(await runCli(["--db", db(), "pin", String(id)])).toBe(0);
    resetOut();
    expect(await runCli(["--db", db(), "confirm", "--all", "--json"])).toBe(0);
    expect(JSON.parse(stdout()).confirmed).toBe(1);
  });

  it("export/import round-trips", async () => {
    legacyFixture();
    const newDb = join(dir, "roundtrip.db");
    expect(await runCli(["--db", newDb, "migrate", join(dir, "memory.db")])).toBe(0);
    const outFile = join(dir, "export.json");
    expect(await runCli(["--db", newDb, "export", "--out", outFile])).toBe(0);
    const imported = join(dir, "imported.db");
    resetOut();
    expect(await runCli(["--db", imported, "import", outFile, "--json"])).toBe(0);
    expect(JSON.parse(stdout()).imported).toBe(3);
  });

  it("migrate copies the fixture, leaves the source untouched", async () => {
    const legacyPath = legacyFixture(true);
    const before = createHash("sha256").update(readFileSync(legacyPath)).digest("hex");
    resetOut();
    expect(await runCli(["--db", db(), "migrate", legacyPath, "--json"])).toBe(0);
    const report = JSON.parse(stdout());
    expect(report.sourceCount).toBe(3);
    expect(report.migratedCount).toBe(3);
    expect(report.failures).toHaveLength(0);
    const after = createHash("sha256").update(readFileSync(legacyPath)).digest("hex");
    expect(after).toBe(before);

    // Pinned legacy memory survives and is searchable (CJK too).
    expect(await runCli(["--db", db(), "list", "--pinned"])).toBe(0);
    expect(stdout()).toContain("legacy preference: use pnpm");
    expect(await runCli(["--db", db(), "search", "跨会话"])).toBe(0);
    expect(stdout()).toContain("旧的中文记忆");
  });

  it("fails loudly on bad commands and bad config", async () => {
    expect(await runCli(["--db", db(), "nope"])).toBe(1);
    expect(errChunks.join("")).toContain("unknown command");
    expect(
      await runCli(["--db", join(dir, "x.db"), "--json", "list"]),
    ).toBe(0); // fresh db is fine
  });
});

