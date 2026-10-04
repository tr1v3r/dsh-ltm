import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { MemoryStore } from "../src/store.js";

let dir: string;
let output: string[];
let errors: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ltm-help-"));
  output = [];
  errors = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { errors.push(String(chunk)); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const commands = ["doctor", "list", "search", "show", "edit", "tag", "pin", "merge", "confirm", "forget", "upgrade-schema", "export", "import", "help"];
describe("CLI subcommand help", () => {
  it.each(commands)("%s --help needs no operation arguments and creates no database", async (command) => {
    const parent = join(dir, "missing");
    expect(await runCli(["--db", join(parent, "ltm.db"), command, "--help"])).toBe(0);
    expect(output.join("")).toContain("usage:");
    expect(errors).toEqual([]);
    expect(existsSync(parent)).toBe(false);
  });

  it.each(commands)("%s --help leaves current-schema database and WAL bytes unchanged", async (command) => {
    const path = join(dir, "ltm.db");
    const writer = new MemoryStore(path);
    try {
      writer.write("preserve help fixture", ["help"]);
      const snapshot = () => Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name))]));
      const before = snapshot();
      expect(await runCli(["--db", path, command, "--help"])).toBe(0);
      expect(snapshot()).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it.each([["edit", "1"], ["tag", "1"], ["confirm"], ["merge", "1", "2", "--expected-revision", "1"]])("help bypasses required operation options: %j", async (...args) => {
    expect(await runCli(["--db", join(dir, "missing.db"), ...args, "--help", "--json"])).toBe(0);
    expect(JSON.parse(output.join("")).usage).toContain("usage:");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("retains retired migrate rejection even with --help", async () => {
    expect(await runCli(["--db", join(dir, "missing.db"), "migrate", "--help"])).toBe(1);
    expect(errors.join("")).toContain("migrate has been retired");
    expect(output).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
