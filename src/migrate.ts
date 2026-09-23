/**
 * Migration from the legacy dsh-memory database (R8).
 *
 * The legacy store (`~/.config/dsh/memory/memory.db`, SCHEMA_VERSION=1 with
 * `memories(id,text,tags,pinned,created_at,updated_at)` and an
 * external-content FTS index) is **never opened for writing**. A read-only
 * connection produces one SQLite-consistent snapshot (`VACUUM INTO`, including
 * committed WAL frames) in a temp database; the migration reads only that
 * snapshot. This avoids a torn main/`-wal`/`-shm` three-file copy and leaves the
 * source main database and its `-wal` untouched — verified by tests via sha256
 * before/after. Opening even read-only can still update the `-shm` sidecar.
 *
 * @module dsh-ltm/migrate
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { MigrationReport } from "./contracts.js";
import { normalizeTags } from "./tokenize.js";
import type { MemoryStore } from "./store.js";

interface LegacyRow {
  id: number;
  text: string;
  tags: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}

/**
 * Only the version-1 legacy row layout is supported (verified against the
 * published dsh-memory@0.1.0 schema and its PRAGMA user_version). Accepting
 * a superset would silently turn modern LTM project memories into global ones
 * (including when the caller supplies the destination itself as the source).
 * The derived legacy FTS index/triggers are not needed to import base rows.
 */
function assertLegacySource(db: DatabaseSync): void {
  const table = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'memories'").get();
  const columns = db.prepare("PRAGMA table_xinfo(memories)").all();
  const expected = [
    ["id", "INTEGER", 1],
    ["text", "TEXT", 0],
    ["tags", "TEXT", 0],
    ["pinned", "INTEGER", 0],
    ["created_at", "INTEGER", 0],
    ["updated_at", "INTEGER", 0],
  ] as const;
  if (table?.type !== "table" || columns.length !== expected.length ||
      expected.some(([name, type, pk]) => !columns.some(column =>
        column.name === name && column.type === type && column.pk === pk &&
        column.notnull === (name === "id" ? 0 : 1) && column.hidden === 0))) {
    throw new Error(
      "dsh-ltm: unsupported legacy source schema; expected the dsh-memory v1 memories table, not an LTM or unrelated database.",
    );
  }
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (version !== 1) {
    throw new Error(
      `dsh-ltm: unsupported legacy source version ${String(version)}; expected dsh-memory PRAGMA user_version = 1.`,
    );
  }
}

/**
 * Migrate every row of the legacy dsh-memory database into `store`.
 *
 * Mapping: `scope = ""`, `last_confirmed_at = updated_at`, tags re-normalized
 * through the shared normalizer. Each row passes the store's dedupe check
 * against already-migrated content; hits are counted in `dedupedCount` and
 * skipped (legacy duplicates are not silently force-written). Rows that fail
 * to map are recorded in `failures` and do not abort the run.
 *
 * @param sourcePath - absolute path of the legacy `memory.db`.
 * @param store - the destination store (open).
 * @returns the {@link MigrationReport}; the temp copy is removed before
 *   returning and the source file is never modified.
 */
export function migrateLegacy(sourcePath: string, store: MemoryStore): MigrationReport {
  const startedAt = Date.now();
  const tempDir = mkdtempSync(join(tmpdir(), "dsh-ltm-migrate-"));
  let sourceCount = 0;
  let migratedCount = 0;
  let dedupedCount = 0;
  const failures: MigrationReport["failures"] = [];

  try {
    const tempDb = join(tempDir, "legacy.db");
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      assertLegacySource(source);
      // VACUUM INTO reads the source through one SQLite transaction, so
      // committed WAL frames are captured atomically instead of racing
      // independent filesystem copies. It is used instead of
      // `DatabaseSync#serialize()`, which only exists from Node 24 on, while
      // this package still supports Node 22.19.
      source.prepare("VACUUM INTO ?").run(tempDb);
    } finally {
      source.close();
    }

    const snapshot = new DatabaseSync(tempDb, { readOnly: true });
    try {
      // A live source may change between preflight and VACUUM. Validate the
      // actual immutable snapshot as well, before any destination writes.
      assertLegacySource(snapshot);
      const rows = snapshot.prepare("SELECT * FROM memories ORDER BY id").all() as unknown as LegacyRow[];
      sourceCount = rows.length;
      for (const row of rows) {
        try {
          if (typeof row.text !== "string" || row.text.trim().length === 0) {
            failures.push({ legacyId: row.id, reason: "text is blank or not a string" });
            continue;
          }
          const { record, dedupeHits } = store.insertMigrated({
            text: row.text,
            tags: normalizeTags(typeof row.tags === "string" ? row.tags.split(/\s+/).filter(Boolean) : []),
            scope: "",
            pinned: row.pinned !== 0,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastConfirmedAt: row.updated_at,
          });
          if (dedupeHits.length > 0) {
            dedupedCount++;
          } else {
            migratedCount++;
            void record;
          }
        } catch (error) {
          failures.push({
            legacyId: row.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      snapshot.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    sourcePath,
    sourceCount,
    migratedCount,
    dedupedCount,
    failures,
    startedAt,
    endedAt: Date.now(),
  };
}
