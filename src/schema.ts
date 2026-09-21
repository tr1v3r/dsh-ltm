/**
 * Schema management for the dsh-ltm store (SCHEMA_VERSION = 1).
 *
 * The FTS5 virtual table stores **tokenized** text (see `tokenize.ts`), not
 * the original prose: `memories.text` holds the original, and the FTS index
 * columns hold the CJK-aware token streams. That is why the index is not
 * external-content — it must be rebuildable from the tokenizer.
 *
 * @module dsh-ltm/schema
 */

import type { DatabaseSync } from "node:sqlite";

/** On-disk schema version, recorded in `meta.schema_version`. */
export const SCHEMA_VERSION = 1;

const DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    text              TEXT    NOT NULL,
    tags              TEXT    NOT NULL DEFAULT '',
    scope             TEXT    NOT NULL DEFAULT '',
    pinned            INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    last_confirmed_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS memories_recent
    ON memories (updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope);

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    text, tags, scope,
    tokenize = 'unicode61'
  );
`;

/**
 * Validate any existing schema metadata without executing a write statement.
 * Empty databases are accepted for first-time initialization.
 */
export function assertSchemaCompatible(db: DatabaseSync): void {
  const objects = db
    .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get() as { name: string } | undefined;
  const hasMeta = db
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'meta'")
    .get() as { present: number } | undefined;

  if (hasMeta === undefined) {
    if (objects !== undefined) {
      throw new Error(
        "dsh-ltm: existing database has no schema_version metadata; refusing to modify an unknown schema",
      );
    }
    return;
  }

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: unknown }
    | undefined;
  if (row === undefined) {
    throw new Error(
      "dsh-ltm: existing database has no schema_version value; refusing to modify an unknown schema",
    );
  }
  if (typeof row.value !== "string" || !/^(?:0|[1-9]\d*)$/.test(row.value)) {
    throw new Error(
      `dsh-ltm: invalid database schema version ${String(row.value)}; expected a canonical non-negative integer`,
    );
  }

  const stored = Number(row.value);
  if (!Number.isSafeInteger(stored)) {
    throw new Error(
      `dsh-ltm: invalid database schema version ${row.value}; value exceeds the supported integer range`,
    );
  }
  if (stored > SCHEMA_VERSION) {
    throw new Error(
      `dsh-ltm: database schema version ${row.value} is newer than supported ${SCHEMA_VERSION}; upgrade dsh-ltm first`,
    );
  }
  if (stored < SCHEMA_VERSION) {
    throw new Error(
      `dsh-ltm: database schema version ${row.value} is older than supported ${SCHEMA_VERSION}; no migration path is available`,
    );
  }
}

/**
 * Apply the current schema after {@link assertSchemaCompatible} succeeds.
 *
 * The DDL and the version stamp commit together. Otherwise a crash in that
 * window would leave a database that {@link assertSchemaCompatible} must then
 * refuse forever (tables present, no version row) — module initialization must
 * be all-or-nothing.
 */
export function ensureSchema(db: DatabaseSync): void {
  assertSchemaCompatible(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(DDL);
    db.prepare(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION));
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite may have rolled the transaction back already; the original
      // error is the one that matters.
    }
    throw error;
  }
}
