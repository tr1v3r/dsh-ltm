/**
 * Explicit v1 → v2 schema upgrade (issue #32 phase 1).
 *
 * A normal {@link MemoryStore} open refuses a v1 database read-only and points
 * here. The upgrade: classify on a read-only handle (never an implicit
 * upgrade, never creating a missing database), take one SQLite-consistent
 * backup via read-only `VACUUM INTO` (which includes committed WAL frames —
 * never an independent db+wal+shm copy), then `ALTER TABLE ... ADD COLUMN
 * revision ...` and the `meta.schema_version = '2'` stamp inside ONE
 * `BEGIN IMMEDIATE` transaction, after re-verifying that the database is
 * still the v1 structure the read-only preflight accepted. Any failure rolls
 * back both the column and the version stamp and keeps the backup; there is
 * no half-upgraded state.
 *
 * `fts_token_version` is untouched (the derived FTS index is not part of this
 * upgrade); the store's existing idempotent repair rebuilds it when needed.
 *
 * Rollback story (documented for operators): stop ALL writers first, then
 * restore the backup snapshot over the database; any write performed after
 * the upgrade is lost with the restored file.
 *
 * @module dsh-ltm/upgrade
 */

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { outputConflictsWithDatabase } from "./output-path.js";
import {
  assertMetaShape,
  assertSchemaCompatible,
  assertUpgradeableV1,
  classifyForUpgrade,
  REVISION_COLUMN_DDL,
  SCHEMA_VERSION,
} from "./schema.js";

/** Options for {@link upgradeSchema}. */
export interface UpgradeSchemaOptions {
  /**
   * New-file backup path. Must not exist and must not target the database,
   * its SQLite sidecars, or any alias of them. Defaults to
   * `<db>.pre-v2-backup-<UTC timestamp>` next to the database.
   */
  backupPath?: string;
}

/** Outcome of one {@link upgradeSchema} run. */
export interface UpgradeSchemaReport {
  /** `true` when this run performed the v1 → v2 transition. */
  upgraded: boolean;
  /** Schema version after the run (always the current version). */
  schemaVersion: number;
  /**
   * The backup file this run wrote before mutating the database. Present for
   * every run that took a backup — including the concurrent-upgrade no-op,
   * where the snapshot may contain private content and is therefore kept and
   * reported (never silently deleted) for the operator to review and remove.
   * `undefined` only when no backup was taken (already current at the
   * read-only classification).
   */
  backupPath?: string;
  /** Rows present when the transition ran (v1); `0` for no-op runs. */
  recordCount: number;
  /** Why a no-op run still reports a backup (concurrent-upgrade race only). */
  note?: string;
}

function defaultBackupPath(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `${dbPath}.pre-v2-backup-${stamp}`;
}

function guardBackupTarget(backup: string, dbPath: string): void {
  const conflict = outputConflictsWithDatabase(backup, dbPath);
  if (conflict === "database" || conflict === "sidecar") {
    throw new Error(
      `dsh-ltm: upgrade-schema: --backup must not target the database or its SQLite sidecars`,
    );
  }
  if (existsSync(backup)) {
    throw new Error(
      "dsh-ltm: upgrade-schema: --backup already exists; choose a new file (existing files are never overwritten)",
    );
  }
}

/**
 * Upgrade a v1 dsh-ltm database to the current schema.
 *
 * @param path - database file. Must already exist; this entry point never
 *   creates a database.
 * @param options - backup target control.
 * @returns what happened; throws (without partial changes) on any refusal.
 */
export function upgradeSchema(path: string, options?: UpgradeSchemaOptions): UpgradeSchemaReport {
  if (path === ":memory:") {
    throw new Error("dsh-ltm: upgrade-schema requires a database file, not :memory:");
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(
      "dsh-ltm: upgrade-schema requires an existing database file; it never creates one",
    );
  }

  // Read-only classification. A refused database is never opened read-write.
  let recordCount = 0;
  const classification = (() => {
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      const result = classifyForUpgrade(probe);
      if (result.kind === "legacy-v1") {
        recordCount = Number(
          (probe.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n,
        );
      }
      return result;
    } finally {
      probe.close();
    }
  })();

  if (classification.kind === "empty") {
    throw new Error(
      "dsh-ltm: upgrade-schema: database is empty; nothing to upgrade — open it normally to initialize the current schema",
    );
  }
  if (classification.kind === "current") {
    return { upgraded: false, schemaVersion: SCHEMA_VERSION, recordCount: 0 };
  }
  if (classification.kind !== "legacy-v1") {
    throw new Error(classification.reason);
  }

  const backup = options?.backupPath ?? defaultBackupPath(path);
  guardBackupTarget(backup, path);

  // One SQLite-consistent snapshot (committed WAL frames included) from a
  // read-only connection. Independent file copies of db/-wal/-shm would be
  // torn; `serialize()` is Node 24+ only while this package supports 22.19.
  let backupTaken = false;
  let db: DatabaseSync | undefined;
  let transactionStarted = false;
  let failed = false;
  try {
    try {
      const snapshotter = new DatabaseSync(path, { readOnly: true });
      try {
        snapshotter.prepare("VACUUM INTO ?").run(backup);
        backupTaken = true;
      } finally {
        snapshotter.close();
      }
      db = new DatabaseSync(path, { timeout: 5000 });
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      assertMetaShape(db);
      // Re-verify under the write lock: the unlocked preflight must not be
      // the only check. A concurrent upgrade that already committed leaves
      // the database current — verify the FULL current structure (never
      // trust the version stamp alone) and report a no-op.
      const version = db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      if (version?.value === String(SCHEMA_VERSION)) {
        assertSchemaCompatible(db);
        db.exec("ROLLBACK");
        transactionStarted = false;
        // This run already wrote its backup before acquiring the lock. The
        // snapshot may contain private content, so it is kept and REPORTED
        // rather than silently deleted; the operator deletes it after review.
        return {
          upgraded: false,
          schemaVersion: SCHEMA_VERSION,
          recordCount: 0,
          backupPath: backup,
          note: "a concurrent upgrade had already committed; this run made no changes and its pre-taken backup was kept (delete it after review if unneeded)",
        };
      }
      assertUpgradeableV1(db);
      db.exec(`ALTER TABLE memories ADD COLUMN ${REVISION_COLUMN_DDL}`);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION),
      );
      db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      failed = true;
      if (transactionStarted) {
        try {
          db?.exec("ROLLBACK");
        } catch {
          // Preserve the original failure if SQLite already rolled back.
        }
      }
      throw error;
    } finally {
      try {
        db?.close();
      } catch (error) {
        if (!failed) throw error;
      }
    }
  } catch (error) {
    // Includes open, lock acquisition, and close failures after the snapshot.
    if (!backupTaken) throw error;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; backup kept at ${backup}`,
      { cause: error },
    );
  }

  return { upgraded: true, schemaVersion: SCHEMA_VERSION, backupPath: backup, recordCount };
}
