/**
 * Migration from the legacy dsh-memory database (R8).
 *
 * The legacy store (`~/.config/dsh/memory/memory.db`, SCHEMA_VERSION=1 with
 * `memories(id,text,tags,pinned,created_at,updated_at)` and an
 * external-content FTS index) is **never opened for writing**: the file (plus
 * its `-wal`/`-shm` siblings, which a read-only open of a live WAL database
 * would need to replay) is copied to a temp directory and the copy is opened.
 * The original bytes on disk therefore stay untouched — verified by tests via
 * sha256 before/after.
 *
 * @module dsh-ltm/migrate
 */

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
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
    // Copy db + sidecars so WAL recovery happens on the copy, not the source.
    const tempDb = join(tempDir, "legacy.db");
    copyFileSync(sourcePath, tempDb);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        copyFileSync(sourcePath + suffix, tempDb + suffix);
      } catch {
        // absent sidecar is the normal case for a cleanly closed database
      }
    }
    const db = new DatabaseSync(tempDb, { readOnly: true });
    try {
      const rows = db.prepare("SELECT * FROM memories ORDER BY id").all() as unknown as LegacyRow[];
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
      db.close();
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
