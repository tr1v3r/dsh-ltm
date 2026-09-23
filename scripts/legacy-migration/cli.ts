/** Explicit, repository-only entry point for the one-time dsh-memory migration. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { MemoryStore } from "../../src/store.js";
import { assertLegacySource, migrateLegacy } from "./migrate.js";

const USAGE = "usage: pnpm dlx tsx scripts/legacy-migration/cli.ts --source OLD_MEMORY_DB --db NEW_LTM_DB (repo root; see scripts/legacy-migration/README.md)";

/** No implicit database paths, profile configuration, or destructive overwrite mode. */
export function runMigrationCli(argv: readonly string[]): number {
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) {
      process.stdout.write(USAGE + "\n");
      return 0;
    }
    const paths = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 2) {
      const flag = argv[i]!;
      if (flag !== "--source" && flag !== "--db") throw new Error(`unknown argument ${JSON.stringify(flag)}; ${USAGE}`);
      if (paths.has(flag)) throw new Error(`duplicate ${flag}; ${USAGE}`);
      const value = argv[i + 1];
      if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
        throw new Error(`missing value for ${flag}; ${USAGE}`);
      }
      paths.set(flag, resolve(value));
    }
    const sourcePath = paths.get("--source");
    const targetPath = paths.get("--db");
    if (!sourcePath || !targetPath) throw new Error(`both --source and --db are required; ${USAGE}`);

    // Reject the wrong source before even creating/opening a destination store.
    // migrateLegacy validates the consistent snapshot again before row writes.
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try { assertLegacySource(source); }
    finally { source.close(); }

    const store = new MemoryStore(targetPath);
    try {
      const report = migrateLegacy(sourcePath, store);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return report.failures.length > 0 ? 1 : 0;
    } finally { store.close(); }
  } catch (error) {
    process.stderr.write(`legacy-migration: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** Resolve the executable through the filesystem: argv[1] and import.meta.url
 * can differ on symlinked prefixes (e.g. macOS /var vs /private/var). */
if (process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  process.exitCode = runMigrationCli(process.argv.slice(2));
}
