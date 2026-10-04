import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runCli } from "../src/cli.js";
import { MemoryStore } from "../src/store.js";

let dir: string;
let output: string[];
let errors: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ltm-cli-path-"));
  output = [];
  errors = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { errors.push(String(chunk)); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(relativePath = false) {
  const real = join(dir, "real");
  mkdirSync(join(real, "child"), { recursive: true });
  mkdirSync(join(real, "nested"));
  symlinkSync(join(real, "child"), join(dir, "link"), "dir");
  const database = join(real, "nested", "ltm.db");
  const store = new MemoryStore(database);
  try { store.write("filesystem identity fixture", []); } finally { store.close(); }
  const prefix = relativePath ? relative(process.cwd(), dir) : dir;
  // The real parent exists, but lexical normalization points to absent dir/nested.
  const raw = `${prefix}/link/../nested/ltm.db`;
  expect(existsSync(join(dir, "nested"))).toBe(false);
  return { database, raw };
}

describe("CLI filesystem database identity", () => {
  it.each([false, true])("exports through symlink/.. with a missing lexical parent (relative=%s)", async (relativePath) => {
    const { database, raw } = fixture(relativePath);
    const before = readFileSync(database);
    const file = join(dir, "export.json");
    expect(await runCli(["--db", raw, "export", "--out", file])).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).records[0].text).toBe("filesystem identity fixture");
    expect(readFileSync(database)).toEqual(before);
    expect(existsSync(join(dir, "nested"))).toBe(false);
  });

  it.each([false, true])("doctor reports the actual database identity (relative=%s)", async (relativePath) => {
    const { database, raw } = fixture(relativePath);
    const before = readFileSync(database);
    expect(await runCli(["--db", raw, "doctor", "--json"])).toBe(0);
    expect(JSON.parse(output.join("")).databasePath).toBe(realpathSync.native(database));
    expect(readFileSync(database)).toEqual(before);
    expect(existsSync(join(dir, "nested"))).toBe(false);
  });

  it("protects database aliases and both real/alias sidecar names after traversal", async () => {
    const { database, raw } = fixture();
    const alias = join(dir, "real", "nested", "alias.db");
    const hardlink = join(dir, "hardlink.db");
    symlinkSync(database, alias);
    linkSync(database, hardlink);
    const rawAlias = raw.replace(/ltm\.db$/, "alias.db");
    const before = readFileSync(database);
    for (const target of [database, raw, alias, hardlink]) {
      errors.length = 0;
      expect(await runCli(["--db", rawAlias, "export", "--out", target])).toBe(1);
      expect(errors.join("")).toMatch(/database|already exists/);
      expect(errors.join("")).not.toContain("ENOENT");
      expect(readFileSync(database)).toEqual(before);
    }
    for (const base of [database, raw, alias, rawAlias]) {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        errors.length = 0;
        const target = base + suffix;
        expect(await runCli(["--db", rawAlias, "export", "--out", target])).toBe(1);
        expect(errors.join("")).toContain("SQLite sidecars");
        expect(existsSync(target)).toBe(false);
        expect(readFileSync(database)).toEqual(before);
      }
    }
    output.length = 0;
    expect(await runCli(["--db", rawAlias, "doctor", "--json"])).toBe(0);
    expect(JSON.parse(output.join("")).databasePath).toBe(realpathSync.native(database));
  });
});
