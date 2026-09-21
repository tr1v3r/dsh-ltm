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
 * Apply the schema idempotently and stamp `meta.schema_version`.
 *
 * @param db - an open `node:sqlite` connection.
 * @throws when the stored version is newer than {@link SCHEMA_VERSION}
 *   (a database from a future dsh-ltm must not be silently downgraded).
 */
export function ensureSchema(db: DatabaseSync): void {
  db.exec(DDL);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row === undefined) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
    return;
  }
  const stored = Number.parseInt(row.value, 10);
  if (!Number.isInteger(stored) || stored > SCHEMA_VERSION) {
    throw new Error(
      `dsh-ltm: database schema version ${row.value} is newer than supported ${SCHEMA_VERSION}; upgrade dsh-ltm first`,
    );
  }
  // stored < SCHEMA_VERSION would run incremental migrations here; 1 is the
  // initial version, so nothing to do yet.
}
