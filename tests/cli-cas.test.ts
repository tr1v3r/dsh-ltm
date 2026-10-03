import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runCli } from "../src/cli.js";
import { MemoryStore } from "../src/store.js";

let dir: string;
let chunks: string[];
let errChunks: string[];
const realWrite = process.stdout.write.bind(process.stdout);
const realErrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ltm-cli-cas-"));
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
const stderr = () => errChunks.join("");
const resetOut = () => { chunks.length = 0; errChunks.length = 0; };
const json = () => JSON.parse(stdout());

/** Old-format export payload (dsh-ltm-export/1, no revision field). */
function legacyExport(id: number): string {
  return JSON.stringify({
    format: "dsh-ltm-export/1",
    records: [{
      id, text: `legacy export fact ${id}`, tags: "legacy", scope: "", pinned: false,
      createdAt: 10, updatedAt: 20, lastConfirmedAt: 15,
    }],
  });
}

describe("cli CAS flags", () => {
  it("edit/tag/pin/confirm/forget accept --expected-revision and report revisions", async () => {
    const writer = new MemoryStore(db());
    const { record } = writer.write("cli cas fact", ["x"]);
    writer.close();
    const id = String(record!.id);

    expect(await runCli(["--db", db(), "edit", id, "--text", "cli cas v2", "--expected-revision", "1", "--json"])).toBe(0);
    expect(json()).toMatchObject({ record: { revision: 2, text: "cli cas v2" } });

    resetOut();
    expect(await runCli(["--db", db(), "tag", id, "--tags", "y", "--expected-revision", "2", "--json"])).toBe(0);
    expect(json().record.revision).toBe(3);

    resetOut();
    expect(await runCli(["--db", db(), "pin", id, "--expected-revision", "3", "--json"])).toBe(0);
    expect(json().record.revision).toBe(4);

    resetOut();
    expect(await runCli(["--db", db(), "confirm", id, "--expected-revision", "4", "--json"])).toBe(0);
    expect(json()).toEqual({ confirmed: 1, revision: 5 });

    resetOut();
    expect(await runCli(["--db", db(), "forget", id, "--expected-revision", "5", "--json"])).toBe(0);
    expect(json()).toEqual({ deleted: true, deletedRevision: 5 });

    resetOut();
    expect(await runCli(["--db", db(), "show", "1"])).toBe(1); // already deleted
  });

  it("a stale revision exits 1 with the structured error detail and no content leak", async () => {
    const writer = new MemoryStore(db());
    const { record } = writer.write("cli conflict fact", []);
    writer.close();
    const writer2 = new MemoryStore(db());
    writer2.update(record!.id, { text: "cli conflict fact v2" });
    writer2.close();
    resetOut();
    expect(await runCli(["--db", db(), "edit", "1", "--text", "sneaky stale", "--expected-revision", "1", "--json"])).toBe(1);
    expect(json()).toEqual({
      error: {
        code: "MEMORY_REVISION_CONFLICT",
        operation: "memory_update",
        id: 1,
        expectedRevision: 1,
        currentRevision: 2,
      },
    });
    // Human mode prints only metadata and a re-read hint.
    resetOut();
    expect(await runCli(["--db", db(), "edit", "1", "--text", "sneaky stale", "--expected-revision", "1"])).toBe(1);
    expect(stdout()).toContain("revision conflict");
    expect(stdout()).toContain("current 2");
    expect(stdout()).not.toContain("sneaky stale");
    // Nothing was written.
    const check = new MemoryStore(db());
    expect(check.list()[0]!.text).toBe("cli conflict fact v2");
    check.close();
  });

  it("rejects malformed --expected-revision before opening (or creating) the database", async () => {
    for (const bad of ["0", "-1", "abc", "1.5", ""]) {
      const fresh = join(dir, `fresh-${bad || "empty"}.db`);
      expect(await runCli(["--db", fresh, "edit", "1", "--text", "x", "--expected-revision", bad])).toBe(1);
      expect(stderr()).toContain("--expected-revision");
      expect(existsSync(fresh)).toBe(false);
      resetOut();
    }
  });

  it("rejects unknown or inapplicable CAS flags loudly", async () => {
    expect(await runCli(["--db", db(), "list", "--expected-revision", "1"])).toBe(1);
    expect(stderr()).toContain("unknown flag --expected-revision");
    resetOut();
    expect(await runCli(["--db", db(), "confirm", "--all", "--expected-revision", "1"])).toBe(1);
    expect(stderr()).toContain("--all and --expected-revision are mutually exclusive");
    resetOut();
    expect(await runCli(["--db", db(), "show", "1", "--expected-revision", "1"])).toBe(1);
    expect(stderr()).toContain("unknown flag");
  });

  it("confirm --all works without a version and reports counts only", async () => {
    const writer = new MemoryStore(db());
    writer.write("all confirm fact", []);
    writer.write("all confirm fact two", [], { force: true });
    writer.close();
    expect(await runCli(["--db", db(), "confirm", "--all", "--json"])).toBe(0);
    expect(json()).toEqual({ confirmed: 2 });
    expect(await runCli(["--db", db(), "confirm", "--all"])).toBe(0);
    expect(stdout()).toContain("confirmed 2");
  });

  it("forget without a version keeps the legacy behavior", async () => {
    const writer = new MemoryStore(db());
    const { record } = writer.write("cli forget legacy fact", []);
    writer.close();
    resetOut();
    expect(await runCli(["--db", db(), "forget", String(record!.id), "--json"])).toBe(0);
    expect(json()).toEqual({ deleted: true, deletedRevision: 1 });
    resetOut();
    expect(await runCli(["--db", db(), "forget", "999", "--json"])).toBe(1);
    expect(json()).toEqual({ deleted: false });
  });

  it("human outputs surface revisions in show/list/search/merge", async () => {
    const writer = new MemoryStore(db());
    const a = writer.write("rev visibility fact", ["v"]).record;
    const b = writer.write("rev visibility fact two", ["v"], { force: true }).record;
    writer.close();
    expect(await runCli(["--db", db(), "show", String(a.id)])).toBe(0);
    expect(stdout()).toContain("revision: 1");
    resetOut();
    expect(await runCli(["--db", db(), "list"])).toBe(0);
    expect(stdout()).toMatch(/#1 \(rev 1\)/);
    expect(stdout()).toMatch(/#2 \(rev 1\)/);
    resetOut();
    expect(await runCli(["--db", db(), "search", "visibility"])).toBe(0);
    expect(stdout()).toMatch(/rev 1/);
    resetOut();
    expect(await runCli(["--db", db(), "merge", String(a.id), String(b.id)])).toBe(0);
    expect(stdout()).toContain("rev 2");
  });
});

describe("cli strict merge flags", () => {
  async function seeded(): Promise<{ a: number; b: number }> {
    const writer = new MemoryStore(db());
    const a = writer.write("merge cli target", ["m"], { force: true }).record;
    const b = writer.write("merge cli source", ["m"], { force: true }).record;
    writer.close();
    return { a: a.id, b: b.id };
  }

  it("merges with a complete declaration and bumps the target once", async () => {
    const { a, b } = await seeded();
    expect(await runCli([
      "--db", db(), "merge", String(a), String(b),
      "--expected-revision", "1", "--expected-source-revisions", `${b}:1`, "--json",
    ])).toBe(0);
    expect(json().record.revision).toBe(2);
    const check = new MemoryStore(db());
    expect(check.count()).toBe(1);
    check.close();
  });

  it.each([
    ["missing source declaration", ["--expected-revision", "1"]],
    ["missing target declaration", ["--expected-source-revisions", "5:1"]],
    ["duplicate source entry", ["--expected-revision", "1", "--expected-source-revisions", "5:1,5:1"]],
    ["extra source entry", ["--expected-revision", "1", "--expected-source-revisions", "5:1,99:1"]],
    ["only target declared", ["--expected-revision", "1", "--expected-source-revisions", "4:1"]],
    ["empty declaration", ["--expected-revision", "1", "--expected-source-revisions", ""]],
    ["malformed pair", ["--expected-revision", "1", "--expected-source-revisions", "5"]],
    ["zero revision", ["--expected-revision", "1", "--expected-source-revisions", "5:0"]],
  ])("rejects %s before touching the database", async (_label, flags) => {
    const { a, b } = await seeded();
    const before = readFileSync(db());
    expect(await runCli(["--db", db(), "merge", String(a), String(b), ...flags])).toBe(1);
    expect(stderr().length).toBeGreaterThan(0);
    expect(readFileSync(db())).toEqual(before);
    resetOut();
  });

  it("exits 1 with the structured conflict detail on a stale participant", async () => {
    const { a, b } = await seeded();
    const writer = new MemoryStore(db());
    writer.update(b, { tags: ["moved"] });
    writer.close();
    resetOut();
    expect(await runCli([
      "--db", db(), "merge", String(a), String(b),
      "--expected-revision", "1", "--expected-source-revisions", `${b}:1`, "--json",
    ])).toBe(1);
    expect(json()).toEqual({
      error: {
        code: "MEMORY_REVISION_CONFLICT",
        operation: "memory_merge",
        id: b,
        expectedRevision: 1,
        currentRevision: 2,
      },
    });
    const check = new MemoryStore(db());
    expect(check.count()).toBe(2);
    check.close();
  });
});

describe("cli export/import versioning", () => {
  it("export writes dsh-ltm-export/2 with revisions; import round-trips them", async () => {
    const source = new MemoryStore(db());
    const first = source.write("export two fact", ["e"]).record;
    source.update(first.id, { text: "export two fact v2" }); // revision 2
    source.close();
    const out = join(dir, "v2.json");
    expect(await runCli(["--db", db(), "export", "--out", out])).toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.format).toBe("dsh-ltm-export/2");
    expect(payload.records[0].revision).toBe(2);

    const target = join(dir, "target.db");
    resetOut();
    expect(await runCli(["--db", target, "import", out, "--json"])).toBe(0);
    expect(json()).toEqual({ imported: 1, skipped: 0 });
    const restored = new MemoryStore(target);
    expect(restored.list()[0]!.revision).toBe(2);
    restored.close();
    // Idempotent re-import with the same revision; conflict on a different one.
    resetOut();
    expect(await runCli(["--db", target, "import", out, "--json"])).toBe(0);
    expect(json()).toEqual({ imported: 0, skipped: 1 });
    payload.records[0].revision = 1;
    writeFileSync(out, JSON.stringify(payload));
    expect(await runCli(["--db", target, "import", out, "--json"])).toBe(1);
  });

  it("imports legacy /1 exports at revision 1 but validates a provided revision", async () => {
    const legacy = join(dir, "v1.json");
    writeFileSync(legacy, legacyExport(7));
    expect(await runCli(["--db", db(), "import", legacy, "--json"])).toBe(0);
    expect(json()).toEqual({ imported: 1, skipped: 0 });
    const store = new MemoryStore(db());
    expect(store.list()[0]!.revision).toBe(1);
    store.close();

    const withRevision = join(dir, "v1-rev.json");
    writeFileSync(withRevision, JSON.stringify({
      format: "dsh-ltm-export/1",
      records: [{ id: 8, text: "legacy with revision", tags: "", scope: "", pinned: false, createdAt: 1, updatedAt: 2, lastConfirmedAt: 1, revision: 5 }],
    }));
    resetOut();
    expect(await runCli(["--db", db(), "import", withRevision, "--json"])).toBe(0);
    const store2 = new MemoryStore(db());
    expect(store2.list().find((r) => r.id === 8)!.revision).toBe(5);
    store2.close();

    const badRevision = join(dir, "v1-bad.json");
    writeFileSync(badRevision, JSON.stringify({
      format: "dsh-ltm-export/1",
      records: [{ id: 9, text: "legacy bad revision", tags: "", scope: "", pinned: false, createdAt: 1, updatedAt: 2, lastConfirmedAt: 1, revision: 0 }],
    }));
    resetOut();
    expect(await runCli(["--db", db(), "import", badRevision, "--json"])).toBe(1);
    expect(stderr()).toContain("revision");
  });

  it("rejects /2 exports missing a revision", async () => {
    const bad = join(dir, "v2-missing.json");
    writeFileSync(bad, JSON.stringify({
      format: "dsh-ltm-export/2",
      records: [{ id: 1, text: "no revision", tags: "", scope: "", pinned: false, createdAt: 1, updatedAt: 2, lastConfirmedAt: 1 }],
    }));
    expect(await runCli(["--db", db(), "import", bad])).toBe(1);
    expect(stderr()).toContain("missing revision");
  });

  it("a same-id different-revision import rolls the whole batch back", async () => {
    const writer = new MemoryStore(db());
    const existing = writer.write("rollback import fact", []).record;
    writer.close();
    const file = join(dir, "conflict.json");
    writeFileSync(file, JSON.stringify({
      format: "dsh-ltm-export/2",
      records: [
        { id: 50, text: "would import", tags: "", scope: "", pinned: false, createdAt: 1, updatedAt: 2, lastConfirmedAt: 1, revision: 1 },
        { id: existing.id, text: "rollback import fact", tags: "", scope: "", pinned: false, createdAt: existing.createdAt, updatedAt: existing.updatedAt, lastConfirmedAt: existing.lastConfirmedAt, revision: 9 },
      ],
    }));
    expect(await runCli(["--db", db(), "import", file, "--json"])).toBe(1);
    const check = new MemoryStore(db());
    expect(check.count()).toBe(1);
    expect(check.list()[0]!.revision).toBe(1);
    check.close();
  });
});

describe("cli upgrade-schema", () => {
  const V1_DDL = `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_confirmed_at INTEGER NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');`;

  function v1Db(): string {
    const path = join(dir, "v1.db");
    const d = new DatabaseSync(path);
    d.exec(V1_DDL);
    d.prepare("INSERT INTO memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at) VALUES (?, '', '', 0, 1, 2, 3)").run("cli upgrade fact");
    d.close();
    return path;
  }

  it("upgrades a v1 database through the CLI and creates the documented backup", async () => {
    const path = v1Db();
    const backup = join(dir, "cli-backup.db");
    expect(await runCli(["--db", path, "upgrade-schema", "--backup", backup, "--json"])).toBe(0);
    expect(json()).toMatchObject({ upgraded: true, schemaVersion: 2, recordCount: 1, backupPath: backup });
    expect(existsSync(backup)).toBe(true);
    // The upgraded database is usable by the normal store.
    const store = new MemoryStore(path);
    expect(store.list()[0]!.revision).toBe(1);
    store.close();
    // Second run is a metadata-only no-op (both output modes).
    resetOut();
    expect(await runCli(["--db", path, "upgrade-schema", "--json"])).toBe(0);
    expect(json()).toMatchObject({ upgraded: false, schemaVersion: 2 });
    resetOut();
    expect(await runCli(["--db", path, "upgrade-schema"])).toBe(0);
    expect(stdout()).toContain("already at schema v2");
  });

  it("refuses a missing database without creating it", async () => {
    const missing = join(dir, "nope", "v1.db");
    expect(await runCli(["--db", missing, "upgrade-schema"])).toBe(1);
    expect(stderr()).toContain("requires an existing database file");
    expect(existsSync(join(dir, "nope"))).toBe(false);
  });

  it("refuses a --backup target over the database or an existing file", async () => {
    const path = v1Db();
    expect(await runCli(["--db", path, "upgrade-schema", "--backup", path])).toBe(1);
    expect(stderr()).toContain("must not target the database");
    resetOut();
    const taken = join(dir, "taken.bak");
    writeFileSync(taken, "x");
    expect(await runCli(["--db", path, "upgrade-schema", "--backup", taken])).toBe(1);
    expect(stderr()).toContain("already exists");
    expect(readFileSync(taken, "utf8")).toBe("x");
    // The refused database is still v1.
    const probe = new DatabaseSync(path, { readOnly: true });
    expect(probe.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "1" });
    probe.close();
  });

  it("default backup name is documented and lands beside the database", async () => {
    const path = v1Db();
    expect(await runCli(["--db", path, "upgrade-schema"])).toBe(0);
    expect(stdout()).toMatch(/backup at .+\.pre-v2-backup-\d{8}T\d{6}/);
    const parent = path.slice(0, path.lastIndexOf("/"));
    expect(readdirSync(parent).some((name) => name.includes("pre-v2-backup-"))).toBe(true);
  });
});

describe("cli help mentions the new surface", () => {
  it("usage covers upgrade-schema, forget, and the CAS flags", async () => {
    expect(await runCli(["help"])).toBe(0);
    const usage = stdout();
    expect(usage).toContain("upgrade-schema");
    expect(usage).toContain("forget <id>");
    expect(usage).toContain("--expected-revision");
    expect(usage).toContain("--expected-source-revisions");
    expect(usage).not.toContain("migrate ");
  });
});
