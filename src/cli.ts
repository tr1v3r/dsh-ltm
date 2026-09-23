/**
 * CLI (P1' surface): `dsh-ltm [--db PATH] [--json] <command> ...`
 *
 * Commands: list / search / show / edit / tag / pin / merge / confirm /
 * export / import / migrate (R7). Every command prints JSON with `--json` and
 * a human-readable summary otherwise. The CLI never logs config values or
 * anything beyond the memory records the operator explicitly asked for.
 *
 * @module dsh-ltm/cli
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { MemoryStore } from "./store.js";
import { migrateLegacy } from "./migrate.js";
import { isStale } from "./prompt.js";
import type { Config, MemoryRecord } from "./contracts.js";
import { normalizeTags } from "./tokenize.js";
import { doctor } from "./doctor.js";
import { resolveProjectScope } from "./scope.js";
import { loadTokenCounter } from "./token-counter.js";

/** Long options that take a value. */
const VALUE_FLAGS = new Set([
  "--scope",
  "--config",
  "--max-pairs",
  "--tags",
  "--text",
  "--limit",
  "--file",
  "--source",
  "--out",
]);

/** Usage text shown for `help` or a parse error. */
const USAGE = `usage: dsh-ltm [--db PATH] [--json] <command> [args]

commands:
  doctor [--scope S] [--config FILE] [--max-pairs N] (read-only, no memory text)
  list [--scope S] [--tags a,b] [--stale|--fresh] [--pinned] [--limit N]
  search <query> [--limit N]
  show <id>
  edit <id> --text <text>
  tag <id> --tags a,b            (replaces the tag set)
  pin <id> [--off]
  merge <targetId> <sourceId>... [--text <text>] [--tags a,b]
  confirm <id>|--all
  export [--out <file>]          (JSON to stdout or a new file; never overwrites)
  import <file>                  (JSON produced by export)
  migrate <legacyDbPath>         (legacy dsh-memory db, read-only)
  help

global:
  --db PATH   database file (default $DSH_HOME/memory/ltm.db)
  --json      machine-readable output`;

/** Parsed argv model. */
interface ParsedArgs {
  db?: string;
  json: boolean;
  command?: string;
  positionals: string[];
  flags: Record<string, string>;
  boolFlags: Set<string>;
}

/** Control-flow exception carrying the exit code. */
class ProcessExit extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

function fail(message: string): never {
  process.stderr.write(`dsh-ltm: ${message}\n`);
  throw new ProcessExit(1);
}

const COMMAND_FLAGS: Record<string, { values?: readonly string[]; bools?: readonly string[]; min: number; max?: number }> = {
  doctor: { values: ["scope", "config", "max-pairs"], min: 0, max: 0 },
  list: { values: ["scope", "tags", "limit"], bools: ["stale", "fresh", "pinned"], min: 0, max: 0 },
  search: { values: ["limit"], min: 1 },
  show: { min: 1, max: 1 },
  edit: { values: ["text"], min: 1, max: 1 },
  tag: { values: ["tags"], min: 1, max: 1 },
  pin: { bools: ["off"], min: 1, max: 1 },
  merge: { values: ["text", "tags"], min: 2 },
  confirm: { bools: ["all"], min: 0, max: 1 },
  export: { values: ["out"], min: 0, max: 0 },
  import: { min: 1, max: 1 },
  migrate: { values: ["source"], min: 0, max: 1 },
  help: { min: 0, max: 0 },
};

function parseArgv(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    positionals: [],
    flags: {},
    boolFlags: new Set(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    // Support the `--flag=value` form uniformly (e.g. `--db=/tmp/x.db`). The
    // previous parser only matched the space-separated `--db <path>` token, so
    // `--db=/tmp/x.db` fell through to the bare-flag branch and was silently
    // ignored — the CLI then read/wrote the DEFAULT database with no warning.
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (name === "--json") {
      if (inlineValue !== undefined) fail("--json takes no value");
      parsed.json = true;
    } else if (name === "--db") {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[++i];
        if (next === undefined || next.startsWith("--")) fail("missing value for --db");
        value = next;
      }
      parsed.db = value;
    } else if (VALUE_FLAGS.has(name)) {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[++i];
        // A bare value flag greedily consumed the next token even when it was
        // another option, so `edit 1 --text --json` stored the literal "--json"
        // and silently dropped JSON mode. Reject a following option; a value
        // that must start with `--` can be given as `--flag=--value`.
        if (next === undefined || next.startsWith("--")) fail(`missing value for ${name}`);
        value = next;
      }
      parsed.flags[name.slice(2)] = value;
    } else if (arg.startsWith("--")) {
      if (inlineValue !== undefined) fail(`unknown flag ${name}`);
      parsed.boolFlags.add(arg.slice(2));
    } else if (parsed.command === undefined) {
      parsed.command = arg;
    } else {
      parsed.positionals.push(arg);
    }
  }
  if (parsed.command !== undefined) {
    const spec = COMMAND_FLAGS[parsed.command];
    if (spec !== undefined) {
      const allowedValues = new Set(spec.values ?? []);
      const allowedBools = new Set(spec.bools ?? []);
      for (const flag of Object.keys(parsed.flags)) {
        if (!allowedValues.has(flag)) fail(`${parsed.command}: unknown flag --${flag}`);
      }
      for (const flag of parsed.boolFlags) {
        // `--help` is accepted on every command; runCli prints usage and exits 0.
        if (flag === "help") continue;
        if (!allowedBools.has(flag)) fail(`${parsed.command}: unknown flag --${flag}`);
      }
      if (parsed.positionals.length < spec.min) fail(`${parsed.command}: missing argument`);
      if (spec.max !== undefined && parsed.positionals.length > spec.max) {
        fail(`${parsed.command}: unexpected argument ${JSON.stringify(parsed.positionals[spec.max])}`);
      }
      if (parsed.command === "list" && parsed.boolFlags.has("stale") && parsed.boolFlags.has("fresh")) {
        fail("list: --stale and --fresh are mutually exclusive");
      }
      if (parsed.command === "confirm" && parsed.boolFlags.has("all") && parsed.positionals.length > 0) {
        fail("confirm: <id> and --all are mutually exclusive");
      }
      if (parsed.command === "migrate" && parsed.flags.source !== undefined && parsed.positionals.length > 0) {
        fail("migrate: <legacyDbPath> and --source are mutually exclusive");
      }
    }
  }
  return parsed;
}

function defaultDbPath(): string {
  const home = process.env.DSH_HOME ?? resolve(homedir(), ".config/dsh");
  return resolve(home, "memory/ltm.db");
}

function splitTags(value: string | undefined): string[] | undefined {
  return value === undefined
    ? undefined
    : value.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}

function toInt(value: string | undefined, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${what} must be an integer >= 1`);
  return n;
}

function toId(value: string | undefined): number {
  if (value === undefined) fail("missing <id>");
  return toInt(value, "id");
}

function parseImportPayload(value: unknown): MemoryRecord[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("import: not an export file");
  const payload = value as Record<string, unknown>;
  if (payload.format !== "dsh-ltm-export/1" || !Array.isArray(payload.records)) {
    fail("import: unsupported or invalid export format");
  }
  const seen = new Set<number>();
  return payload.records.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`import: invalid record at index ${index}`);
    const record = raw as Record<string, unknown>;
    const integer = (key: string, positive = false): number => {
      const item = record[key];
      if (!Number.isSafeInteger(item) || (positive && (item as number) < 1) || (!positive && (item as number) < 0)) {
        fail(`import: record ${index} has invalid ${key}`);
      }
      return item as number;
    };
    const id = integer("id", true);
    if (seen.has(id)) fail(`import: duplicate id #${id} in export`);
    seen.add(id);
    if (typeof record.text !== "string" || record.text.trim().length === 0) fail(`import: record ${index} has invalid text`);
    if (typeof record.tags !== "string" || normalizeTags(record.tags.split(" ")) !== record.tags) fail(`import: record ${index} has invalid tags`);
    if (typeof record.scope !== "string") fail(`import: record ${index} has invalid scope`);
    if (typeof record.pinned !== "boolean") fail(`import: record ${index} has invalid pinned`);
    const createdAt = integer("createdAt");
    const updatedAt = integer("updatedAt");
    const lastConfirmedAt = integer("lastConfirmedAt");
    if (updatedAt < createdAt) fail(`import: record ${index} has updatedAt before createdAt`);
    return { id, text: record.text, tags: record.tags, scope: record.scope, pinned: record.pinned, createdAt, updatedAt, lastConfirmedAt };
  });
}

/** Human one-liner for a record. */
function humanLine(
  record: {
    id: number;
    text: string;
    tags: string;
    pinned: boolean;
    lastConfirmedAt: number;
  },
  staleAfterDays: number,
): string {
  const flags = [
    record.pinned ? "pinned" : "",
    isStale(record, staleAfterDays) ? "stale" : "",
  ].filter(Boolean).join(",");
  const tag = record.tags ? ` [${record.tags}]` : "";
  return `#${record.id}${flags ? ` (${flags})` : ""}${tag} ${record.text}`;
}

function out(json: boolean, data: unknown, human: string): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else if (human.trim().length > 0) {
    process.stdout.write(human + "\n");
  }
}

/** Never truncate an existing file (including hardlinks/symlinks to SQLite).
 * Reserve absent SQLite sidecars too: creating JSON at a future WAL/journal path
 * would break the next database writer. Canonicalize parent-directory aliases.
 */
function writeExportFile(file: string, payload: string, dbPath: string): void {
  // Resolve the raw parent through the filesystem before normalizing: lexical
  // resolve() would collapse a symlink/.. pair to the wrong directory.
  const output = join(realpathSync.native(dirname(file)), basename(file));
  const databasePaths = [resolve(dbPath), realpathSync.native(dbPath)];
  const filenameKey = (path: string) => path.normalize("NFC").toLowerCase();
  for (const database of databasePaths) {
    const canonical = join(realpathSync(dirname(database)), basename(database));
    // Reserve case/Unicode-normalization variants conservatively even on
    // case-sensitive hosts, covering absent filename aliases on macOS too.
    if (["", "-wal", "-shm", "-journal"].some((suffix) => filenameKey(output) === filenameKey(canonical + suffix))) {
      fail("export: --out must not target the database or its SQLite sidecars");
    }
  }
  try {
    // Exclusive creation also closes the check-then-truncate race and rejects
    // dangling symlinks without following them.
    writeFileSync(output, payload, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("export: --out already exists; choose a new file (existing files are never overwritten)");
    }
    throw error;
  }
}

function openStore(config: Config): MemoryStore {
  return new MemoryStore(config.path, {
    staleAfterDays: config.staleAfterDays,
    dedupeThreshold: config.dedupeThreshold,
    dedupeCosineThreshold: config.dedupeCosineThreshold,
    maxTextChars: config.maxTextChars,
    searchLimitMax: config.searchLimitMax,
  });
}

/**
 * Run the CLI. Returns the process exit code; expected failures are printed
 * and reported as code 1 rather than thrown.
 *
 * @param argv - arguments after the bin name.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  let doctorMode = false;
  try {
    const parsed = parseArgv(argv);
    const { command, positionals, flags, boolFlags, json } = parsed;
    doctorMode = command === "doctor";
    const helpRequested = command === "help" || boolFlags.has("help");
    if (command === undefined || helpRequested) {
      out(json, { usage: USAGE }, USAGE);
      return helpRequested ? 0 : 1;
    }

    let overrides: Record<string, unknown> = {};
    if (command === "doctor" && flags.config !== undefined) {
      let value: unknown;
      try { value = JSON.parse(readFileSync(resolve(flags.config), "utf8")); }
      catch { fail("doctor: cannot read --config JSON file"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("doctor: --config must contain a config object");
      overrides = value as Record<string, unknown>;
    }
    const config = loadConfig({
      ...overrides,
      path: parsed.db !== undefined ? resolve(parsed.db) : Object.hasOwn(overrides, "path") ? overrides.path : defaultDbPath(),
    });

    if (command === "doctor") {
      const activeScope = flags.scope ?? (config.autoProjectScope
        ? resolveProjectScope(process.cwd(), config.defaultScope).scope : config.defaultScope);
      const counter = config.promptTokenizerPath === undefined ? undefined : loadTokenCounter(config.promptTokenizerPath);
      const maxPairs = flags["max-pairs"] === undefined ? undefined : toInt(flags["max-pairs"], "--max-pairs");
      const report = {
        ...doctor(config, activeScope, counter, maxPairs),
        configuration: { source: flags.config === undefined ? "CLI defaults" : "explicit JSON", file: flags.config === undefined ? null : resolve(flags.config), profileLoaded: false },
      };
      out(json, report, JSON.stringify(report, null, 2));
      return 0;
    }

    if (command === "migrate") {
      const source = positionals[0] ?? flags.source;
      if (source === undefined) fail("migrate: missing <legacyDbPath>");
      const store = openStore(config);
      try {
        const report = migrateLegacy(resolve(source), store);
        out(
          json,
          report,
          `migrated ${report.migratedCount}/${report.sourceCount} from ${report.sourcePath}` +
            (report.dedupedCount > 0 ? ` (${report.dedupedCount} deduped)` : "") +
            (report.failures.length > 0 ? `, ${report.failures.length} failed` : ""),
        );
        return report.failures.length > 0 ? 1 : 0;
      } finally {
        store.close();
      }
    }

    const store = openStore(config);
    try {
      switch (command) {
        case "list": {
          const stale = boolFlags.has("stale")
            ? true
            : boolFlags.has("fresh")
              ? false
              : undefined;
          const listFilter: {
            scope?: string;
            tags?: string[];
            stale?: boolean;
            pinned?: boolean;
            limit?: number;
          } = {};
          if (flags.scope !== undefined) listFilter.scope = flags.scope;
          const tags = splitTags(flags.tags);
          if (tags !== undefined) listFilter.tags = tags;
          if (stale !== undefined) listFilter.stale = stale;
          if (boolFlags.has("pinned")) listFilter.pinned = true;
          if (flags.limit !== undefined) listFilter.limit = toInt(flags.limit, "--limit");
          const records = store.list(listFilter);
          out(
            json,
            { records },
            records.length === 0
              ? "no memories match"
              : records.map((r) => humanLine(r, config.staleAfterDays)).join("\n"),
          );
          return 0;
        }
        case "search": {
          const query = positionals.join(" ");
          if (query.length === 0) fail("search: missing <query>");
          const limit =
            flags.limit === undefined ? undefined : toInt(flags.limit, "--limit");
          const results = store.search(query, limit);
          out(
            json,
            { results },
            results.length === 0
              ? `no memories match ${JSON.stringify(query)}`
              : results.map((r) => humanLine(r, config.staleAfterDays)).join("\n"),
          );
          return 0;
        }
        case "show": {
          const id = toId(positionals[0]);
          const record = store.list().find((r) => r.id === id);
          if (record === undefined) {
            out(json, { error: `no memory #${id}` }, `no memory #${id}`);
            return 1;
          }
          out(json, { record }, [
            humanLine(record, config.staleAfterDays),
            `  scope: ${record.scope || "(global)"}`,
            `  created: ${new Date(record.createdAt).toISOString()}`,
            `  updated: ${new Date(record.updatedAt).toISOString()}`,
            `  confirmed: ${new Date(record.lastConfirmedAt).toISOString()}`,
          ].join("\n"));
          return 0;
        }
        case "edit": {
          const id = toId(positionals[0]);
          const text = flags.text;
          if (text === undefined) fail("edit: missing --text");
          const record = store.update(id, { text });
          if (record === undefined) {
            out(json, { error: `no memory #${id}` }, `no memory #${id}`);
            return 1;
          }
          out(json, { record }, `updated #${id}`);
          return 0;
        }
        case "tag": {
          const id = toId(positionals[0]);
          const tags = splitTags(flags.tags);
          if (tags === undefined) fail("tag: missing --tags");
          const record = store.update(id, { tags });
          if (record === undefined) {
            out(json, { error: `no memory #${id}` }, `no memory #${id}`);
            return 1;
          }
          out(json, { record }, `#${id} tags: ${record.tags || "(none)"}`);
          return 0;
        }
        case "pin": {
          const id = toId(positionals[0]);
          const pinned = !boolFlags.has("off");
          const record = store.update(id, { pinned });
          if (record === undefined) {
            out(json, { error: `no memory #${id}` }, `no memory #${id}`);
            return 1;
          }
          out(json, { record }, `#${id} ${pinned ? "pinned" : "unpinned"}`);
          return 0;
        }
        case "merge": {
          const targetId = toId(positionals[0]);
          const sourceIds = positionals.slice(1).map((v) => toInt(v, "sourceId"));
          if (sourceIds.length === 0) fail("merge: missing <sourceId>...");
          const mergeInput: {
            targetId: number;
            sourceIds: number[];
            text?: string;
            tags?: string[];
          } = { targetId, sourceIds };
          if (flags.text !== undefined) mergeInput.text = flags.text;
          const tags = splitTags(flags.tags);
          if (tags !== undefined) mergeInput.tags = tags;
          const record = store.merge(mergeInput);
          if (record === undefined) {
            out(json, { error: "merge failed (bad ids?)" }, "merge failed");
            return 1;
          }
          out(json, { record }, `merged into #${record.id}`);
          return 0;
        }
        case "confirm": {
          const all = boolFlags.has("all");
          const confirmed = store.confirm(all ? "*" : toId(positionals[0]));
          out(json, { confirmed }, `confirmed ${confirmed} memory(ies)`);
          return 0;
        }
        case "export": {
          const records = store.list();
          const payload = JSON.stringify(
            { format: "dsh-ltm-export/1", records },
            null,
            2,
          );
          const outFile = flags.out;
          if (outFile === undefined) {
            process.stdout.write(payload + "\n");
          } else {
            writeExportFile(outFile, payload, config.path);
            out(
              json,
              { exported: records.length, file: outFile },
              `exported ${records.length} memories to ${outFile}`,
            );
          }
          return 0;
        }
        case "import": {
          const file = positionals[0];
          if (file === undefined) fail("import: missing <file>");
          const records = parseImportPayload(JSON.parse(readFileSync(resolve(file), "utf8")));
          const { imported, skipped } = store.importRecords(records);
          out(json, { imported, skipped }, `imported ${imported}, skipped ${skipped}`);
          return 0;
        }
        default:
          fail(`unknown command ${JSON.stringify(command)}`);
      }
    } finally {
      store.close();
    }
  } catch (error) {
    if (error instanceof ProcessExit) return error.code;
    // Schema/config exceptions may embed arbitrary stored values. Diagnostics are
    // metadata-only even on failure; do not forward raw library error messages.
    const message = doctorMode
      ? "doctor: cannot analyze database/configuration (missing, unreadable, invalid or incompatible); raw details withheld; no changes made"
      : error instanceof Error ? error.message : String(error);
    process.stderr.write(`dsh-ltm: ${message}\n`);
    return 1;
  }
}
