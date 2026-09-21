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

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { MemoryStore } from "./store.js";
import { migrateLegacy } from "./migrate.js";
import { isStale } from "./prompt.js";
import type { Config } from "./contracts.js";

/** Long options that take a value. */
const VALUE_FLAGS = new Set([
  "--scope",
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
  list [--scope S] [--tags a,b] [--stale|--fresh] [--pinned] [--limit N]
  search <query> [--limit N]
  show <id>
  edit <id> --text <text>
  tag <id> --tags a,b            (replaces the tag set)
  pin <id> [--off]
  merge <targetId> <sourceId>... [--text <text>] [--tags a,b]
  confirm <id>|--all
  export [--out <file>]          (JSON to stdout or file)
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
  try {
    const parsed = parseArgv(argv);
    const { command, positionals, flags, boolFlags, json } = parsed;
    if (command === undefined || command === "help") {
      out(json, { usage: USAGE }, USAGE);
      return command === undefined ? 1 : 0;
    }

    const config = loadConfig({
      path: parsed.db === undefined ? defaultDbPath() : resolve(parsed.db),
    });

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
            writeFileSync(outFile, payload, "utf8");
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
          const parsedImport = JSON.parse(readFileSync(resolve(file), "utf8")) as {
            records?: unknown;
          };
          if (!Array.isArray(parsedImport.records)) fail("import: not an export file");
          let imported = 0;
          let skipped = 0;
          for (const raw of parsedImport.records) {
            const record = raw as Record<string, unknown>;
            const text = typeof record.text === "string" ? record.text : "";
            if (text.trim().length === 0) {
              skipped++;
              continue;
            }
            const tags = typeof record.tags === "string" ? record.tags.split(" ") : [];
            const { record: written } = store.write(text, tags, {
              scope: typeof record.scope === "string" ? record.scope : "",
              pinned: record.pinned === true,
              force: true,
            });
            if (written !== undefined) imported++;
          }
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
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dsh-ltm: ${message}\n`);
    return 1;
  }
}
