/**
 * Shared guard for operator-supplied output paths (export `--out`, schema
 * upgrade `--backup`): never truncate an existing file (including
 * hardlinks/symlinks to the SQLite database), and reserve absent SQLite
 * sidecar names so a future WAL/journal writer cannot be broken.
 *
 * @module dsh-ltm/output-path
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Which database-relative target class a candidate output path collides with. */
export type OutputDatabaseConflict = "database" | "sidecar";

/**
 * Classify `output` against the database and its SQLite sidecars, following
 * filesystem aliases (symlinked parents, symlinked database names) and
 * reserving case/Unicode-normalization filename variants conservatively.
 * Returns `undefined` when the path is safe to create exclusively.
 */
export function outputConflictsWithDatabase(
  output: string,
  dbPath: string,
): OutputDatabaseConflict | undefined {
  // Resolve the raw parent through the filesystem before normalizing: lexical
  // resolve() would collapse a symlink/.. pair to the wrong directory.
  const target = join(realpathSync.native(dirname(output)), basename(output));
  // Keep the supplied basename to reserve alias sidecars, but resolve its raw
  // parent through the filesystem before any lexical normalization. Also guard
  // the real database name when the basename itself is a symlink.
  const databasePaths = [
    join(realpathSync.native(dirname(dbPath)), basename(dbPath)),
    realpathSync.native(dbPath),
  ];
  const filenameKey = (path: string) => path.normalize("NFC").toLowerCase();
  for (const database of databasePaths) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (filenameKey(target) === filenameKey(database + suffix)) {
        return suffix === "" ? "database" : "sidecar";
      }
    }
  }
  return undefined;
}
