import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  it("help subcommand and --help both exit 0", async () => {
    expect(await runCli(["help"])).toBe(0);
    expect(stdout()).toContain("usage:");
    resetOut();
    expect(await runCli(["--help"])).toBe(0);
    expect(stdout()).toContain("usage:");
  });

  it("--help after a subcommand also exits 0", async () => {
    expect(await runCli(["--db", db(), "list", "--help"])).toBe(0);
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

  it("export/import preserves complete record state and id conflict semantics", async () => {
    const newDb = join(dir, "roundtrip.db");
    const source = new MemoryStore(newDb, { now: () => 1_000 });
    const original = source.write("round trip", ["Mixed", "tag"], { scope: "work", pinned: true }).record;
    source.confirm(original.id);
    source.close();
    const outFile = join(dir, "export.json");
    expect(await runCli(["--db", newDb, "export", "--out", outFile])).toBe(0);
    const imported = join(dir, "imported.db");
    resetOut();
    expect(await runCli(["--db", imported, "import", outFile, "--json"])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ imported: 1, skipped: 0 });
    const restored = new MemoryStore(imported);
    expect(restored.list()[0]).toEqual(original);
    restored.close();
    resetOut();
    expect(await runCli(["--db", imported, "import", outFile, "--json"])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ imported: 0, skipped: 1 });
    const payload = JSON.parse(readFileSync(outFile, "utf8"));
    payload.records[0].text = "conflicting text";
    writeFileSync(outFile, JSON.stringify(payload));
    expect(await runCli(["--db", imported, "import", outFile])).toBe(1);
    const unchanged = new MemoryStore(imported);
    expect(unchanged.list()[0]).toEqual(original);
    unchanged.close();
  });

  it("rejects exports over the database and its file aliases without changing bytes", async () => {
    const writer = new MemoryStore(db());
    const original = writer.write("keep this memory", [], { pinned: true }).record;
    writer.close();
    const before = readFileSync(db());
    const symlink = join(dir, "db-symlink.json");
    const hardlink = join(dir, "db-hardlink.json");
    symlinkSync(db(), symlink);
    linkSync(db(), hardlink);
    for (const output of [db(), symlink, hardlink]) {
      resetOut();
      expect(await runCli(["--db", db(), "export", "--out", output])).toBe(1);
      expect(stdout()).toBe("");
      expect(errChunks.join("")).toMatch(/database|already exists/);
      expect(readFileSync(db())).toEqual(before);
    }
    const reopened = new MemoryStore(db());
    try { expect(reopened.list()).toEqual([original]); }
    finally { reopened.close(); }
  });

  it("preserves live WAL and SHM files when export targets them or their aliases", async () => {
    const writer = new MemoryStore(db());
    try {
      writer.write("committed WAL memory", []);
      const files = [db(), db() + "-wal", db() + "-shm"];
      for (const file of files.slice(1)) {
        const alias = file + ".json";
        symlinkSync(file, alias);
        for (const output of [file, alias]) {
          const before = files.map((path) => readFileSync(path));
          expect(await runCli(["--db", db(), "export", "--out", output])).toBe(1);
          // SQLite read locks may update SHM; committed main/WAL bytes must not change.
          expect(readFileSync(files[0]!)).toEqual(before[0]);
          expect(readFileSync(files[1]!)).toEqual(before[1]);
          expect(readFileSync(file).subarray(0, 1).toString()).not.toBe("{");
        }
      }
      expect(writer.search("committed")).toHaveLength(1);
    } finally { writer.close(); }
  });

  it("reserves absent SQLite sidecars through directory and database symlinks", async () => {
    const writer = new MemoryStore(db());
    writer.close();
    const directoryAlias = join(dir, "alias");
    symlinkSync(dir, directoryAlias, "dir");
    const databaseAlias = join(dir, "database-alias.db");
    symlinkSync(db(), databaseAlias);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      // An idle SQLite connection may create WAL/SHM while export runs, but the
      // nonexistent journal path and both canonical/alias sidecar names are reserved.
      for (const output of [db() + suffix, join(directoryAlias, "ltm.db" + suffix), databaseAlias + suffix]) {
        expect(await runCli(["--db", databaseAlias, "export", "--out", output])).toBe(1);
        expect(errChunks.join("")).toContain("SQLite sidecars");
        expect(existsSync(output)).toBe(false);
      }
    }
  });

  it("reserves absent sidecars reached through symlink/.. or case variants", async () => {
    const writer = new MemoryStore(db());
    writer.close();
    mkdirSync(join(dir, "child"));
    mkdirSync(join(dir, "safe"));
    symlinkSync(join(dir, "child"), join(dir, "safe", "link"), "dir");
    // Do not use path.join here: it would collapse the symlink/.. pair.
    const viaParent = `${dir}/safe/link/../ltm.db-journal`;
    for (const output of [viaParent, join(dir, "LTM.DB-JOURNAL")]) {
      resetOut();
      expect(await runCli(["--db", db(), "export", "--out", output])).toBe(1);
      expect(errChunks.join("")).toContain("SQLite sidecars");
      expect(existsSync(output)).toBe(false);
      expect(existsSync(db() + "-journal")).toBe(false);
    }
  });

  it("reserves Unicode-normalization aliases of absent sidecar names", async () => {
    const database = join(dir, "caf\u00e9.db");
    const output = join(dir, "cafe\u0301.db-journal");
    const writer = new MemoryStore(database);
    writer.close();
    expect(await runCli(["--db", database, "export", "--out", output])).toBe(1);
    expect(errChunks.join("")).toContain("SQLite sidecars");
    expect(existsSync(output)).toBe(false);
    expect(existsSync(database + "-journal")).toBe(false);
  });

  it("does not overwrite existing exports or follow dangling output symlinks", async () => {
    const output = join(dir, "existing.json");
    writeFileSync(output, "previous backup");
    expect(await runCli(["--db", db(), "export", "--out", output])).toBe(1);
    expect(readFileSync(output, "utf8")).toBe("previous backup");
    const target = join(dir, "must-not-create.json");
    const alias = join(dir, "dangling.json");
    symlinkSync(target, alias);
    expect(await runCli(["--db", db(), "export", "--out", alias])).toBe(1);
    expect(existsSync(target)).toBe(false);
  });

  it("rejects malformed and unsupported import payloads", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ format: "other", records: [] }));
    expect(await runCli(["--db", db(), "import", file])).toBe(1);
    writeFileSync(file, JSON.stringify({ format: "dsh-ltm-export/1", records: [{ id: 1, text: "x", tags: ["bad"] }] }));
    expect(await runCli(["--db", db(), "import", file])).toBe(1);
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

  it("rejects unknown, mutually exclusive, and surplus arguments", async () => {
    expect(await runCli(["--db", db(), "list", "--wat"])).toBe(1);
    expect(errChunks.join("")).toContain("unknown flag --wat");
    resetOut();
    expect(await runCli(["--db", db(), "list", "--stale", "--fresh"])).toBe(1);
    expect(errChunks.join("")).toContain("mutually exclusive");
    resetOut();
    expect(await runCli(["--db", db(), "show", "1", "extra"])).toBe(1);
    expect(errChunks.join("")).toContain("unexpected argument");
    resetOut();
    expect(await runCli(["--db", db(), "confirm", "1", "--all"])).toBe(1);
    expect(errChunks.join("")).toContain("mutually exclusive");
  });

  it("fails loudly on bad commands and bad config", async () => {
    expect(await runCli(["--db", db(), "nope"])).toBe(1);
    expect(errChunks.join("")).toContain("unknown command");
    expect(
      await runCli(["--db", join(dir, "x.db"), "--json", "list"]),
    ).toBe(0); // fresh db is fine
  });

  it("accepts the --flag=value form for --db (regression: H-5)", async () => {
    // `--db=PATH` previously fell through to the default database silently,
    // so writes/reads hit the wrong file. The inline form must target PATH.
    const target = join(dir, "inline.db");
    const writer = new MemoryStore(target);
    writer.write("inline-db fact", ["cli"]);
    writer.close();
    expect(await runCli([`--db=${target}`, "search", "inline-db"])).toBe(0);
    expect(stdout()).toContain("inline-db fact");
  });

  it("rejects a value flag that swallows the next option (regression: M-7)", async () => {
    // `edit <id> --text --json` must not treat `--json` as the new text; a
    // value flag followed by another option is a missing value, exit 1.
    const writer = new MemoryStore(db());
    const { record } = writer.write("original", ["cli"]);
    writer.close();
    expect(
      await runCli(["--db", db(), "edit", String(record!.id), "--text", "--json"]),
    ).toBe(1);
    expect(errChunks.join("")).toMatch(/missing value/i);
  });

  it("rejects --db with no following value (regression: M-7)", async () => {
    expect(await runCli(["--db", "--json", "list"])).toBe(1);
    expect(errChunks.join("")).toMatch(/missing value/i);
  });
});

