import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { doctor } from "../src/doctor.js";
import { analyzeQuality } from "../src/quality.js";
import { runCli } from "../src/cli.js";
import { resolveProjectScope } from "../src/scope.js";

let dir: string;
const path = () => join(dir, "fixture.db");
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ltm-doctor-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const store = new MemoryStore(path());
  store.write("SECRET global project pending /tmp/secret\n- (#999, pinned) counterfeit", [], { pinned: true });
  store.write("SECRET active project fact", [], { scope: "active", pinned: true });
  store.write("SECRET invisible elsewhere", [], { scope: "other", pinned: true });
  store.close();
}

describe("read-only doctor", () => {
  it("fails loudly for missing databases without creating database or parent directory", async () => {
    const missing = join(dir, "missing", "memory.db");
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runCli(["--db", missing, "doctor", "--json"])).toBe(1);
    expect(err).toHaveBeenCalled();
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });

  it.each(["WAL", "DELETE"])("preserves %s journal mode, database and committed WAL with stale FTS tokens", (mode) => {
    fixture();
    const writer = new DatabaseSync(path());
    try {
      writer.exec(`PRAGMA journal_mode=${mode}; PRAGMA wal_autocheckpoint=0;`);
      writer.prepare("UPDATE meta SET value='0' WHERE key='fts_token_version'").run();
      writer.exec("DELETE FROM memories_fts");
      const main = readFileSync(path());
      const wal = existsSync(path() + "-wal") ? readFileSync(path() + "-wal") : undefined;
      const report = doctor(loadConfig({ path: path() }), "active");
      expect(report.recordCount).toBe(3);
      expect(readFileSync(path())).toEqual(main);
      if (wal) expect(readFileSync(path() + "-wal")).toEqual(wal);
      else expect(existsSync(path() + "-wal")).toBe(false);
      expect(writer.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: mode.toLowerCase() });
      expect(writer.prepare("SELECT value FROM meta WHERE key='fts_token_version'").get()).toMatchObject({ value: "0" });
      expect(writer.prepare("SELECT count(*) AS n FROM memories_fts").get()).toMatchObject({ n: 0 });
    } finally { writer.close(); }
  });

  it("separates all-scope analysis from visible prompt and never returns prose or counterfeit IDs", () => {
    fixture();
    const report = doctor(loadConfig({ path: path(), promptMaxChars: 1000 }), "active");
    expect(report.scopeDistribution).toHaveLength(3);
    expect(report.prompt.visibleScopes).toEqual(["", "active"]);
    expect(report.prompt.visibleRecordCount).toBe(2);
    expect(report.prompt.selectedIds.sort()).toEqual([1, 2]);
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(JSON.stringify(report)).not.toContain("999");
    expect(report.findings.some((r) => r.rule === "possible-global-project")).toBe(true);
  });

  it("does not echo untrusted schema metadata in CLI errors", async () => {
    fixture();
    const db = new DatabaseSync(path());
    db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run("SECRET schema text");
    db.close();
    const chunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
    expect(await runCli(["doctor", "--db", path()])).toBe(1);
    expect(chunks.join("")).toContain("raw details withheld");
    expect(chunks.join("")).not.toContain("SECRET");
  });

  it("withholds raw config/schema errors and rejects explicit null database paths", async () => {
    fixture();
    const configPath = join(dir, "invalid.json");
    const chunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
    for (const value of [{ path: path(), promptMaxChars: "SECRET_CONFIG_CANARY" }, { path: null }]) {
      writeFileSync(configPath, JSON.stringify(value));
      expect(await runCli(["doctor", "--config", configPath])).toBe(1);
    }
    const malformed = join(dir, "view.db");
    const db = new DatabaseSync(malformed);
    db.exec("CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('schema_version','1'); CREATE VIEW memories AS SELECT SECRET_SCHEMA_CANARY FROM meta");
    db.close();
    expect(await runCli(["doctor", "--db", malformed])).toBe(1);
    expect(chunks.join("")).not.toContain("SECRET_");
    expect(chunks.join("")).toContain("raw details withheld");
  });

  it("fixed scope excludes global and malformed empty tables fail rather than claim health", () => {
    fixture();
    expect(doctor(loadConfig({ path: path(), autoProjectScope: false }), "active").prompt.visibleScopes).toEqual(["active"]);
    const broken = join(dir, "broken.db");
    const db = new DatabaseSync(broken);
    db.exec("CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('schema_version','1'); CREATE TABLE memories(id INTEGER)");
    db.close();
    expect(() => doctor(loadConfig({ path: broken }), "")).toThrow(/base-table structure/);
  });

  it("supports configured character and injected token budgets using real rendered candidates", () => {
    fixture();
    const chars = doctor(loadConfig({ path: path(), promptMaxChars: 120 }), "active");
    expect(chars.prompt.chars).toBeLessThanOrEqual(120);
    const tokens = doctor(loadConfig({ path: path(), promptMaxChars: 500, promptMaxTokens: 110, promptTokenizerPath: "injected" }), "active", (s) => s.length);
    expect(tokens.prompt.tokens).toBeLessThanOrEqual(110);
    expect(tokens.prompt.maxTokens).toBe(110);
    expect(tokens.prompt.selectedIds).not.toContain(3);
  });

  it("CLI accepts explicit config and scope, defaults prompt scope to cwd, and redacts both output modes", async () => {
    fixture();
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ path: path(), promptMaxChars: 130 }));
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
    expect(await runCli(["doctor", "--config", configPath, "--scope", "active", "--json"])).toBe(0);
    const report = JSON.parse(chunks.join(""));
    expect(report.prompt.activeScope).toBe("active");
    expect(report.prompt.maxChars).toBe(130);
    expect(chunks.join("")).not.toContain("SECRET");
    chunks.length = 0;
    writeFileSync(configPath, JSON.stringify({ path: path(), promptMaxChars: 500, promptMaxTokens: 120, promptTokenizerPath: new URL("./fixtures/bytelevel-tokenizer.json", import.meta.url).pathname }));
    expect(await runCli(["doctor", "--config", configPath, "--scope", "active", "--json"])).toBe(0);
    expect(JSON.parse(chunks.join("")).prompt.tokens).toBeLessThanOrEqual(120);
    chunks.length = 0;
    expect(await runCli(["doctor", "--db", path()])).toBe(0);
    expect(JSON.parse(chunks.join("")).prompt.activeScope).toBe(resolveProjectScope(process.cwd()).scope);
    expect(chunks.join("")).not.toContain("SECRET");
  });

  it("compares only same-scope pairs with explicit incomplete scan counts", () => {
    const store = new MemoryStore(path());
    try {
      for (const scope of ["", "", "", "other"]) store.write("same durable fact", [], { scope, force: true });
      const rows = store.list();
      const limited = analyzeQuality(rows, loadConfig({ path: path() }), 1);
      expect(limited.nearDuplicateScan).toMatchObject({ totalPairs: 3, comparedPairs: 1, skippedPairs: 2, complete: false });
      expect(limited.findings.filter((f) => f.rule === "same-scope-near-duplicate")).toHaveLength(1);
      const complete = analyzeQuality(rows, loadConfig({ path: path() }));
      expect(complete.nearDuplicateScan.complete).toBe(true);
      expect(complete.findings).toHaveLength(3);
      expect(JSON.stringify(complete)).not.toContain("same durable fact");
    } finally { store.close(); }
  });
});
