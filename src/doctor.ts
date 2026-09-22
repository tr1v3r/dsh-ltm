/** Read-only diagnostic surface: never construct MemoryStore or initialize FTS. */
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, MemoryRecord, TokenCounter } from "./contracts.js";
import { assertSchemaCompatible } from "./schema.js";
import { analyzeQuality } from "./quality.js";
import { promptBudgetReport } from "./prompt.js";
import { visibleScopes } from "./scope.js";

function readRecord(row: Record<string, unknown>): MemoryRecord {
  if (!Number.isSafeInteger(row.id) || Number(row.id) < 1 ||
      typeof row.text !== "string" || typeof row.tags !== "string" || typeof row.scope !== "string" ||
      (row.pinned !== 0 && row.pinned !== 1) ||
      ![row.created_at, row.updated_at, row.last_confirmed_at].every((v) => Number.isSafeInteger(v) && Number(v) >= 0)) {
    throw new Error("doctor: malformed memory row; refusing diagnostic snapshot");
  }
  return { id: row.id as number, text: row.text, tags: row.tags, scope: row.scope, pinned: row.pinned === 1,
    createdAt: row.created_at as number, updatedAt: row.updated_at as number, lastConfirmedAt: row.last_confirmed_at as number };
}

export function doctor(config: Config, activeScope: string, tokenCounter?: TokenCounter, maxPairs = 100_000) {
  // Fail before opening missing paths; readOnly is also essential against races.
  if (!statSync(config.path).isFile()) throw new Error("doctor: database must be an existing regular file");
  const db = new DatabaseSync(config.path, { readOnly: true });
  try {
    db.exec("BEGIN");
    try { assertSchemaCompatible(db); }
    catch { throw new Error("doctor: incompatible or malformed schema metadata; refusing analysis (raw metadata withheld)"); }
    const table = db.prepare("SELECT type FROM sqlite_schema WHERE name='memories'").get();
    if (table?.type !== "table") throw new Error("doctor: memories must be a base table");
    const columns = db.prepare("PRAGMA table_info(memories)").all();
    for (const [name, type] of Object.entries({ id: "INTEGER", text: "TEXT", tags: "TEXT", scope: "TEXT", pinned: "INTEGER", created_at: "INTEGER", updated_at: "INTEGER", last_confirmed_at: "INTEGER" })) {
      const column = columns.find((c) => c.name === name);
      if (!column || String(column.type).toUpperCase() !== type || (name === "id" ? column.pk !== 1 : column.notnull !== 1 || column.pk !== 0)) {
        throw new Error("doctor: incompatible memories base-table structure");
      }
    }
    // Explicit columns also reject malformed *empty* tables rather than reporting health.
    const records = db.prepare("SELECT id, text, tags, scope, pinned, created_at, updated_at, last_confirmed_at FROM memories ORDER BY updated_at DESC, id DESC").all().map(readRecord);
    const scopes = visibleScopes(activeScope, config.autoProjectScope);
    const visible = records.filter((r) => scopes.includes(r.scope));
    const candidates = [...visible.filter((r) => r.pinned), ...visible.filter((r) => !r.pinned).slice(0, config.promptRecentCount)];
    return {
      format: "dsh-ltm-doctor/1",
      readOnly: true,
      databasePath: resolve(config.path),
      ftsCheck: "not inspected or repaired; analysis uses base rows only",
      analysisScope: "all database scopes",
      ...analyzeQuality(records, config, maxPairs),
      prompt: {
        configSource: "CLI defaults or explicit --config JSON; not the running profile",
        activeScope, visibleScopes: scopes, visibleRecordCount: visible.length,
        recentCount: config.promptRecentCount,
        ...promptBudgetReport(candidates, config, tokenCounter),
      },
    };
  } finally {
    // Closing a read-only transaction cannot checkpoint or upgrade the database.
    db.close();
  }
}
