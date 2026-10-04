import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { MemoryStore } from "../src/store.js";

let dir: string;
let errors: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ltm-command-preflight-"));
  errors = [];
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const unknownCommands = ["typo", "constructor", "toString", "__proto__"];
describe("CLI command preflight", () => {
  it.each(unknownCommands)("rejects %s without creating a database or parent", async (command) => {
    const parent = join(dir, "missing");
    expect(await runCli(["--db", join(parent, "ltm.db"), command])).toBe(1);
    expect(errors.join("")).toContain(`unknown command ${JSON.stringify(command)}`);
    expect(existsSync(parent)).toBe(false);
  });

  it.each(unknownCommands)("rejects %s without touching a healthy current-schema database", async (command) => {
    const path = join(dir, "ltm.db");
    const writer = new MemoryStore(path);
    try {
      writer.write("preserve committed memory", ["preflight"]);
      const snapshot = () => Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name))]));
      const before = snapshot();
      expect(await runCli(["--db", path, command])).toBe(1);
      expect(errors.join("")).toContain(`unknown command ${JSON.stringify(command)}`);
      expect(snapshot()).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("does not let --help bypass unknown-command rejection", async () => {
    expect(await runCli(["--db", join(dir, "missing.db"), "typo", "--help"])).toBe(1);
    expect(errors.join("")).toContain('unknown command "typo"');
    expect(readdirSync(dir)).toEqual([]);
  });
});
