/**
 * Schema management for the dsh-ltm store (SCHEMA_VERSION = 2).
 *
 * v2 (issue #32 phase 1) adds the `memories.revision` column — a persisted
 * optimistic-concurrency version, 1..Number.MAX_SAFE_INTEGER, independent of
 * any clock. v1 databases are NOT upgraded implicitly: a normal open refuses
 * them read-only and points at the explicit `upgradeSchema` path (see
 * `src/upgrade.ts` and the `dsh-ltm upgrade-schema` CLI command).
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
export const SCHEMA_VERSION = 2;

/** Column constraint for `memories.revision` (fresh databases and upgrades). */
export const REVISION_COLUMN_DDL =
  "revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991)";

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
    last_confirmed_at INTEGER NOT NULL,
    ${REVISION_COLUMN_DDL}
  );

  CREATE INDEX IF NOT EXISTS memories_recent
    ON memories (updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope);

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    text, tags, scope,
    tokenize = 'unicode61'
  );
`;

/** Expected `memories` columns for the current schema (order-independent). */
const V2_MEMORIES_COLUMNS: ReadonlyMap<string, { type: string; notnull: boolean; pk: boolean }> =
  new Map([
    ["id", { type: "INTEGER", notnull: false, pk: true }],
    ["text", { type: "TEXT", notnull: true, pk: false }],
    ["tags", { type: "TEXT", notnull: true, pk: false }],
    ["scope", { type: "TEXT", notnull: true, pk: false }],
    ["pinned", { type: "INTEGER", notnull: true, pk: false }],
    ["created_at", { type: "INTEGER", notnull: true, pk: false }],
    ["updated_at", { type: "INTEGER", notnull: true, pk: false }],
    ["last_confirmed_at", { type: "INTEGER", notnull: true, pk: false }],
    ["revision", { type: "INTEGER", notnull: true, pk: false }],
  ]);

/** Expected `memories` columns of a supported legacy (v1) database. */
const V1_MEMORIES_COLUMNS: ReadonlyMap<string, { type: string; notnull: boolean; pk: boolean }> =
  new Map([
    ["id", { type: "INTEGER", notnull: false, pk: true }],
    ["text", { type: "TEXT", notnull: true, pk: false }],
    ["tags", { type: "TEXT", notnull: true, pk: false }],
    ["scope", { type: "TEXT", notnull: true, pk: false }],
    ["pinned", { type: "INTEGER", notnull: true, pk: false }],
    ["created_at", { type: "INTEGER", notnull: true, pk: false }],
    ["updated_at", { type: "INTEGER", notnull: true, pk: false }],
    ["last_confirmed_at", { type: "INTEGER", notnull: true, pk: false }],
  ]);

interface TableColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

function tableColumns(db: DatabaseSync, table: string): TableColumn[] | undefined {
  const row = db
    .prepare("SELECT type FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as { type: string } | undefined;
  if (row === undefined) return undefined;
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableColumn[];
}

/**
 * Structural check of a `memories` base table against an expected column set.
 * `revision` additionally requires the v2 default `1` when `requireRevision`.
 * Unknown extra columns fail: a superset is not "a compatible v1/v2 table" —
 * a database that already tracks its own revision-like state must not be
 * blindly ALTERed or adopted.
 */
function memoriesColumnsMatch(
  db: DatabaseSync,
  expected: ReadonlyMap<string, { type: string; notnull: boolean; pk: boolean }>,
  requireRevisionDefault: boolean,
): boolean {
  const columns = tableColumns(db, "memories");
  if (columns === undefined) return false;
  if (columns.length !== expected.size) return false;
  for (const column of columns) {
    const want = expected.get(column.name);
    if (want === undefined) return false;
    if (String(column.type).toUpperCase() !== want.type) return false;
    if ((column.notnull !== 0) !== want.notnull) return false;
    if ((column.pk !== 0) !== want.pk) return false;
  }
  if (requireRevisionDefault) {
    const revision = columns.find((column) => column.name === "revision");
    if (revision?.dflt_value !== "1") return false;
  }
  return true;
}

/**
 * Validate any existing schema metadata without executing a write statement.
 * Empty databases are accepted for first-time initialization.
 *
 * Called on a dedicated read-only connection before the read-write handle
 * exists (see `store.ts`), so a rejected database keeps its main file and
 * `-wal` bytes; this function itself must stay read-only.
 *
 * For the current version the `memories` base table, when present, must match
 * the v2 structure (including `revision`); a malformed base table is refused
 * rather than "repaired". Missing derived objects (indexes/FTS) stay
 * idempotently repairable via {@link ensureSchema}. Rows are validated for
 * revision integrity: a corrupted v2 row is never silently read as revision 1.
 */
export function assertSchemaCompatible(db: DatabaseSync): void {
  // `ESCAPE` matters: without it `_` is a LIKE wildcard, so a database whose
  // only table is named e.g. `sqliteXfoo` (a legal name; only the literal
  // `sqlite_` prefix is reserved) looked like an empty database and the plugin
  // would inject its schema into an unknown one.
  const objects = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' LIMIT 1",
    )
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

  // A `meta`-named table from an unrelated schema must be refused with the
  // designed message instead of leaking `no such column: value`.
  const columns = db.prepare("SELECT name FROM pragma_table_info('meta')").all() as {
    name: string;
  }[];
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("key") || !columnNames.has("value")) {
    throw new Error(
      "dsh-ltm: existing database has an unrecognized `meta` table; refusing to modify an unknown schema",
    );
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
    if (stored === 1) {
      throw new Error(
        `dsh-ltm: database schema version 1 is older than supported ${SCHEMA_VERSION}; this version is not upgraded implicitly — stop all writers and run 'dsh-ltm upgrade-schema' (see docs/data-model.md) to upgrade explicitly`,
      );
    }
    throw new Error(
      `dsh-ltm: database schema version ${row.value} is older than supported ${SCHEMA_VERSION}; no migration path is available`,
    );
  }

  // Current version: a present `memories` base table must match v2 exactly.
  // (Absent tables/indexes are the idempotent-repair case handled by
  // `ensureSchema`'s DDL; a malformed table is not repairable.)
  if (tableColumns(db, "memories") !== undefined) {
    if (!memoriesColumnsMatch(db, V2_MEMORIES_COLUMNS, true)) {
      throw new Error(
        "dsh-ltm: existing database has an unrecognized `memories` table for schema version 2; refusing to modify an unknown schema",
      );
    }
    const corrupted = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE typeof(revision) != 'integer' OR revision < 1 OR revision > 9007199254740991",
      )
      .get() as { n: number };
    if (corrupted.n > 0) {
      throw new Error(
        "dsh-ltm: existing database contains rows with invalid revision values; refusing to read them as a default",
      );
    }
  }
}

/**
 * Classify an existing database for the explicit schema upgrade path. Runs on
 * a READ-ONLY connection; performs the same fail-closed checks as
 * {@link assertSchemaCompatible} plus the deeper v1 structure verification
 * (real legacy column names/types/not-null/PK, no unexpected revision-like
 * columns, and a well-formed FTS virtual table when one exists).
 */
export type SchemaUpgradeClassification =
  | { kind: "empty" }
  | { kind: "current" }
  | { kind: "legacy-v1" }
  | { kind: "unsupported"; reason: string };

export function classifyForUpgrade(db: DatabaseSync): SchemaUpgradeClassification {
  let candidate: "empty" | "current" | "legacy-v1" = "current";
  try {
    assertSchemaCompatible(db);
    const hasMeta = db
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'meta'")
      .get() as { present: number } | undefined;
    candidate = hasMeta === undefined ? "empty" : "current";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^dsh-ltm: database schema version 1 is older/.test(message)) {
      candidate = "legacy-v1";
    } else {
      return { kind: "unsupported", reason: message };
    }
  }
  if (candidate === "empty") return { kind: "empty" };
  if (candidate === "current") return { kind: "current" };

  // Deep v1 verification: the meta table plus the exact legacy base table.
  if (!memoriesColumnsMatch(db, V1_MEMORIES_COLUMNS, false)) {
    return {
      kind: "unsupported",
      reason:
        "dsh-ltm: v1 database does not match the expected legacy memories table (unexpected columns or types); refusing to upgrade",
    };
  }
  // A v1 database with a `memories_fts` shadow must have the FTS5 virtual
  // table shape we know; a foreign FTS definition is not silently rebuilt.
  const fts = db
    .prepare("SELECT type, sql FROM sqlite_schema WHERE name = 'memories_fts'")
    .get() as { type: string; sql: string } | undefined;
  if (fts !== undefined && (fts.type !== "table" || !/USING\s+fts5/i.test(fts.sql ?? ""))) {
    return {
      kind: "unsupported",
      reason: "dsh-ltm: v1 database has an unexpected memories_fts object; refusing to upgrade",
    };
  }
  return { kind: "legacy-v1" };
}

/**
 * Verify, on a connection that has already acquired the write lock, that the
 * database still holds the claimed version and v1 structure. Used by the
 * upgrade path: the unlocked read-only preflight must never be the only
 * check (another writer may have committed in between).
 */
export function assertUpgradeableV1(db: DatabaseSync): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: unknown }
    | undefined;
  if (row === undefined || row.value !== "1") {
    throw new Error(
      `dsh-ltm: database changed while the upgrade was starting (schema_version is ${String(
        row?.value,
      )}); no changes were made`,
    );
  }
  if (!memoriesColumnsMatch(db, V1_MEMORIES_COLUMNS, false)) {
    throw new Error(
      "dsh-ltm: v1 database structure changed while the upgrade was starting; no changes were made",
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
  // A compatible version alone is not enough: older partial databases still
  // need the idempotent DDL to create missing tables/indexes. Healthy opens
  // should not compete with writers just to execute that same DDL again.
  const objects = db.prepare("SELECT type, name FROM sqlite_schema").all() as {
    type: string;
    name: string;
  }[];
  const present = new Set(objects.map(({ type, name }) => `${type}:${name}`));
  if ([
    "table:meta", "table:memories", "table:memories_fts",
    "index:memories_recent", "index:memories_scope",
  ].every((object) => present.has(object))) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    // Another initializer may have committed while we waited for the lock.
    // Never apply DDL based only on the earlier, unlocked compatibility check.
    assertSchemaCompatible(db);
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
