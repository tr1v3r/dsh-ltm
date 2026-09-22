import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { BM25_WEIGHT, ngramCosine } from "../src/search.js";
import { MemoryStore } from "../src/store.js";

const stores: MemoryStore[] = [];
const dirs: string[] = [];
function open(options?: ConstructorParameters<typeof MemoryStore>[1]): MemoryStore {
  const store = new MemoryStore(":memory:", options);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function versionedDb(value: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ltm-schema-"));
  dirs.push(dir);
  const path = join(dir, "ltm.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(value);
  db.close();
  return path;
}

/**
 * Build a WAL database whose committed frames are still in `-wal` with no live
 * connection: a child process writes with `wal_autocheckpoint` off and then
 * SIGKILLs itself, so no close-time checkpoint can fold the WAL into the main
 * file. This is the only shape that exposes the checkpoint side effect of
 * opening a database read-write.
 */
function uncheckpointedWalDb(schemaVersion: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ltm-wal-"));
  dirs.push(dir);
  const path = join(dir, "ltm.db");
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const path = process.argv[1];
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(process.argv[2]);
    db.exec("CREATE TABLE filler (id INTEGER PRIMARY KEY, blob TEXT)");
    const insert = db.prepare("INSERT INTO filler (blob) VALUES (?)");
    for (let i = 0; i < 400; i++) insert.run("x".repeat(600));
    process.kill(process.pid, "SIGKILL");
  `;
  const child = spawnSync(process.execPath, ["-e", script, path, schemaVersion], {
    stdio: "ignore",
  });
  expect(child.signal).toBe("SIGKILL");
  expect(existsSync(path + "-wal")).toBe(true);
  return path;
}

describe("MemoryStore basics", () => {
  it("write/count/forget keep base rows and FTS rows in sync", () => {
    const store = open();
    const { record } = store.write("hello world", ["greet"]);
    expect(store.count()).toBe(1);
    expect(record.pinned).toBe(false);
    expect(record.lastConfirmedAt).toBeGreaterThan(0);
    expect(store.search("hello")).toHaveLength(1);
    expect(store.forget(record.id)).toBe(true);
    expect(store.count()).toBe(0);
    expect(store.search("hello")).toHaveLength(0);
  });

  it("close is idempotent", () => {
    const store = open();
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it("rejects blank and oversized text (fail-loud)", () => {
    const store = open({ maxTextChars: 10 });
    expect(() => store.write("   ", [])).toThrow(/blank/);
    expect(() => store.write("x".repeat(11), [])).toThrow(/limit/);
  });

  it("rejects a future schema before PRAGMA or DDL can change its bytes", () => {
    const path = versionedDb("2");
    const before = sha256(path);
    expect(() => new MemoryStore(path)).toThrow(/newer than supported 1/);
    expect(sha256(path)).toBe(before);

    const db = new DatabaseSync(path, { readOnly: true });
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
    ).toEqual([{ name: "meta" }]);
    db.close();
  });

  it.each(["1junk", "01", "+1", "1.0", " 1", "9007199254740992"])(
    "rejects non-canonical schema_version %j without modifying the database",
    (version) => {
      const path = versionedDb(version);
      const before = sha256(path);
      expect(() => new MemoryStore(path)).toThrow(/invalid database schema version/);
      expect(sha256(path)).toBe(before);
    },
  );

  it("fails closed for an unsupported older schema", () => {
    const path = versionedDb("0");
    const before = sha256(path);
    expect(() => new MemoryStore(path)).toThrow(/older than supported 1.*no migration path/);
    expect(sha256(path)).toBe(before);
  });

  it("a rejected WAL database keeps its main and -wal bytes (regression: F2)", () => {
    // The read-write preflight used to open the WAL database read-write, and the
    // close that follows the rejection checkpointed the WAL: main grew and
    // `-wal` disappeared even though the database was refused.
    const path = uncheckpointedWalDb("2");
    const mainBefore = sha256(path);
    const walBefore = sha256(path + "-wal");
    expect(() => new MemoryStore(path)).toThrow(/newer than supported 1/);
    expect(sha256(path)).toBe(mainBefore);
    expect(sha256(path + "-wal")).toBe(walBefore);
  });

  it("still adopts a valid WAL database through the read-only preflight", () => {
    const path = uncheckpointedWalDb("1");
    const store = new MemoryStore(path);
    stores.push(store);
    expect(store.count()).toBe(0);
    expect(store.write("wal preflight ok", []).record.id).toBe(1);
  });

  it("refuses a database whose only table is hidden by the LIKE wildcard", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-ltm-sqlite-like-"));
    dirs.push(dir);
    const path = join(dir, "ltm.db");
    const db = new DatabaseSync(path);
    // `sqliteXfoo` is a legal name (only the literal `sqlite_` prefix is
    // reserved), but `NOT LIKE 'sqlite_%'` treats `_` as a wildcard and used to
    // make this unknown database look empty.
    db.exec("CREATE TABLE sqliteXfoo (a TEXT)");
    db.close();
    const before = sha256(path);
    expect(() => new MemoryStore(path)).toThrow(/no schema_version metadata/);
    expect(sha256(path)).toBe(before);
    const check = new DatabaseSync(path, { readOnly: true });
    expect(
      check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
    ).toEqual([{ name: "sqliteXfoo" }]);
    check.close();
  });

  it("refuses an unrecognized meta table with the designed message", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-ltm-meta-shape-"));
    dirs.push(dir);
    const path = join(dir, "ltm.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)");
    db.close();
    expect(() => new MemoryStore(path)).toThrow(/unrecognized `meta` table/);
  });

  it("update keeps the id and re-indexes text", () => {
    const store = open();
    const { record } = store.write("alpha note", []);
    const updated = store.update(record.id, { text: "beta note", tags: ["t"] })!;
    expect(updated.id).toBe(record.id);
    expect(updated.text).toBe("beta note");
    expect(store.search("alpha")).toHaveLength(0);
    expect(store.search("beta")).toHaveLength(1);
  });

  it("forPrompt returns pinned first, then recent unpinned", () => {
    const store = open();
    store.write("old unpinned", [], {});
    store.write("pinned fact", [], { pinned: true });
    const records = store.forPrompt(5);
    expect(records[0]!.text).toBe("pinned fact");
    expect(records).toHaveLength(2);
  });

  it("forPrompt limits recall to global plus the active project", () => {
    const store = open();
    store.write("global pinned", [], { pinned: true });
    store.write("project a pinned", [], { scope: "project-a", pinned: true });
    store.write("project b recent", [], { scope: "project-b" });
    const records = store.forPrompt(5, ["", "project-a"]);
    expect(records.map((record) => record.text)).toEqual([
      "project a pinned",
      "global pinned",
    ]);
  });

  it("list filters by scope, tags (AND), and pinned", () => {
    const store = open();
    store.write("a", ["x", "y"], { scope: "work" });
    store.write("b", ["x"], { scope: "home" });
    store.write("c", ["y"], { scope: "work" });
    expect(store.list({ scope: "work" }).map((r) => r.text)).toEqual(["c", "a"]);
    expect(store.list({ tags: ["x", "y"] }).map((r) => r.text)).toEqual(["a"]);
    expect(store.list({ tags: ["x"] }).map((r) => r.text).sort()).toEqual(["a", "b"]);
    expect(store.list({ scope: "work", tags: ["y"] })).toHaveLength(2);
  });

  it("tag filter treats LIKE wildcards literally (regression: H-2)", () => {
    const store = open();
    // Underscore is a legal tag character AND a SQL LIKE single-char wildcard.
    // The old `LIKE '% tag %'` with no ESCAPE matched `build_tool` against
    // `build-tool` and `buildxtool`, returning unrelated records.
    store.write("exact", ["build_tool"]);
    store.write("dash", ["build-tool"]);
    store.write("letter", ["buildxtool"]);
    const hits = store.list({ tags: ["build_tool"] });
    expect(hits.map((r) => r.text)).toEqual(["exact"]);
    // A `%` in a tag must not act as a multi-char wildcard either.
    store.write("pct", ["a%b"]);
    store.write("pcty", ["axxxb"]);
    expect(store.list({ tags: ["a%b"] }).map((r) => r.text)).toEqual(["pct"]);
  });

  it("validates and caps explicit list limits", () => {
    const store = open({ searchLimitMax: 2 });
    for (const text of ["one", "two", "three"]) store.write(text, [], { force: true });
    expect(() => store.list({ limit: 0 })).toThrow(/integer/);
    expect(() => store.list({ limit: 1.5 })).toThrow(/integer/);
    expect(store.list({ limit: 99 })).toHaveLength(2);
  });
});

describe("cross-connection invariants", () => {
  it("dedupes the same scoped content across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-concurrent-"));
    const path = join(dir, "ltm.db");
    const first = new MemoryStore(path);
    const second = new MemoryStore(path);
    try {
      const written = first.write("same scoped content", [], { scope: "shared" });
      const blocked = second.write("same scoped content", [], { scope: "shared" });
      expect(written.dedupeHits).toHaveLength(0);
      expect(blocked.dedupeHits.length).toBeGreaterThan(0);
      expect(second.list({ scope: "shared" })).toHaveLength(1);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports complete records atomically and defines id conflicts", () => {
    const store = open();
    const record = { id: 42, text: "restored", tags: "a b", scope: "work", pinned: true, createdAt: 10, updatedAt: 20, lastConfirmedAt: 15 };
    expect(store.importRecords([record])).toEqual({ imported: 1, skipped: 0 });
    expect(store.list()[0]).toEqual(record);
    expect(store.importRecords([record])).toEqual({ imported: 0, skipped: 1 });
    expect(() => store.importRecords([{ ...record, text: "conflict" }])).toThrow(/conflicts/);
    expect(store.list()[0]).toEqual(record);
  });

  it("treats an existing record as identical regardless of property order", () => {
    const store = open();
    const record = { id: 7, text: "restored", tags: "a b", scope: "work", pinned: true, createdAt: 10, updatedAt: 20, lastConfirmedAt: 15 };
    expect(store.importRecords([record])).toEqual({ imported: 1, skipped: 0 });
    const reordered = {
      lastConfirmedAt: 15,
      updatedAt: 20,
      createdAt: 10,
      pinned: true,
      scope: "work",
      tags: "a b",
      text: "restored",
      id: 7,
    };
    expect(store.importRecords([reordered])).toEqual({ imported: 0, skipped: 1 });
  });
});

describe("CJK search (R2)", () => {
  it("a single CJK character matches inside a multi-character run", () => {
    const store = open();
    store.write("长期记忆系统", []);
    store.write("完全无关内容", []);
    expect(store.search("忆").map((hit) => hit.text)).toEqual(["长期记忆系统"]);
  });

  it("rebuilds a pre-versioned bigram-only FTS index on open", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-ltm-fts-upgrade-"));
    dirs.push(dir);
    const path = join(dir, "ltm.db");
    const store = new MemoryStore(path);
    store.write("长期记忆系统", []);
    store.close();

    const db = new DatabaseSync(path);
    db.prepare("DELETE FROM meta WHERE key = 'fts_token_version'").run();
    db.prepare("UPDATE memories_fts SET text = ? WHERE rowid = 1").run("长期 期记 记忆 忆系 系统");
    db.close();

    const reopened = new MemoryStore(path);
    stores.push(reopened);
    expect(reopened.search("忆")).toHaveLength(1);
  });

  it("pure-Chinese query hits text containing the term", () => {
    const store = open();
    store.write("用户偏好：dsh-ltm 是一个带中文分词的记忆插件", ["zh"]);
    store.write("完全无关的另一条记忆：今天天气不错", []);
    const hits = store.search("记忆插件");
    // OR-matched partial hits are allowed; the full-term record must lead.
    expect(hits[0]!.text).toContain("记忆插件");
    expect(hits.map((h) => h.text)).toContain("完全无关的另一条记忆：今天天气不错");
    expect(hits[0]!.ftsRank).toBeLessThanOrEqual(0); // FTS5 bm25 rank
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("mixed Chinese/Latin query hits both Latin and CJK tokens", () => {
    const store = open();
    store.write("dsh-ltm 提供跨会话记忆", []);
    store.write("无关条目", []);
    const hits = store.search("dsh 记忆");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain("dsh-ltm");
  });

  it("FTS5 operators in the query are matched literally, not executed", () => {
    const store = open();
    store.write("remember OR NOT * stuff", []);
    // treated as the literal tokens "or" "not" "*", no syntax error
    expect(() => store.search("OR NOT *")).not.toThrow();
    expect(store.search('"OR"')).toHaveLength(1);
  });

  it("search can be limited to one or more scopes", () => {
    const store = open();
    store.write("vim keys", [], { scope: "" });
    store.write("vim keys", [], { scope: "tui" });
    store.write("vim keys", [], { scope: "web" });
    expect(store.search("vim", 10, "web")).toHaveLength(1);
    expect(store.search("vim", 10, "web")[0]!.scope).toBe("web");
    expect(store.search("vim", 10, ["", "web"]).map((hit) => hit.scope).sort())
      .toEqual(["", "web"]);
    expect(store.search("vim", 10, [])).toEqual([]);
  });
});

describe("hybrid rerank (R3 default tier)", () => {
  it("gives a better negative FTS5 rank a larger BM25 component", () => {
    const store = open();
    store.write("alpha alpha alpha focused", [], { force: true });
    store.write("alpha broad note with several unrelated filler words", [], { force: true });
    const hits = store.search("alpha");
    expect(hits).toHaveLength(2);

    const byRank = [...hits].sort((a, b) => a.ftsRank - b.ftsRank);
    expect(byRank[0]!.ftsRank).toBeLessThan(byRank[1]!.ftsRank);
    const bm25Component = (hit: (typeof hits)[number]): number =>
      (hit.score - (1 - BM25_WEIGHT) * ngramCosine("alpha", hit.text)) / BM25_WEIGHT;
    expect(bm25Component(byRank[0]!)).toBeCloseTo(1);
    expect(bm25Component(byRank[1]!)).toBeCloseTo(0);
  });

  it("ranks a synonym-rewritten query above a weaker keyword match", () => {
    const store = open();
    store.write("跨会话记忆系统：把对话要点存进长期记忆", []);
    store.write("记忆体硬件参数表", []);
    // keyword-only BM25 prefers neither strongly; cosine with the paraphrase
    // "长久记忆" should put the cross-session memory first.
    const hits = store.search("长久记忆");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.text).toContain("跨会话");
    const scores = hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe("merge (R4/R6)", () => {
  it("absorbs sources, deletes them, and unions tags on the target", () => {
    const store = open({ dedupeThreshold: 1.1 }); // write both without blocking
    const a = store.write("duplicate fact one", ["alpha", "keep"], { force: true }).record;
    const b = store.write("duplicate fact one", ["beta"], { force: true }).record;
    const merged = store.merge({ targetId: a.id, sourceIds: [b.id] })!;
    expect(merged.tags.split(" ").sort()).toEqual(["alpha", "beta", "keep"]);
    expect(store.count()).toBe(1);
    expect(store.search("duplicate fact")).toHaveLength(1);
  });

  it("rejects invalid replacement text without deleting sources", () => {
    const store = open({ maxTextChars: 10 });
    const target = store.write("target", [], { force: true }).record;
    const source = store.write("source", [], { force: true }).record;
    expect(() => store.merge({ targetId: target.id, sourceIds: [source.id], text: "   " })).toThrow(/blank/);
    expect(() => store.merge({ targetId: target.id, sourceIds: [source.id], text: "x".repeat(11) })).toThrow(/limit/);
    expect(store.list().map((r) => r.id).sort()).toEqual([target.id, source.id].sort());
  });

  it("returns undefined for an unknown target", () => {
    const store = open();
    expect(store.merge({ targetId: 999, sourceIds: [] })).toBeUndefined();
  });
});
