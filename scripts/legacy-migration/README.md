# Legacy dsh-memory migration (one-shot, repository-only)

This utility imports memories from the retired `dsh-memory@0.1.0` plugin
(`~/.config/dsh/memory/memory.db`) into a dsh-ltm database. It is **not part of
the published npm package** and is not installed with the plugin: migration is a
one-time step when switching plugins, so it lives in the repository only.

The former `dsh-ltm migrate` CLI command has been removed for the same reason.
For ongoing backups and transfers between dsh-ltm databases use
`dsh-ltm export` / `dsh-ltm import`, which preserve project scopes and review
timestamps.

## When to use

Only when you still have a legacy dsh-memory database and want its rows in
dsh-ltm. Do not use it to copy between dsh-ltm databases: modern sources
(including the destination itself) are rejected by schema/version validation.

## Usage

```sh
git clone https://github.com/tr1v3r/dsh-ltm
cd dsh-ltm
pnpm install
pnpm dlx tsx scripts/legacy-migration/cli.ts \
  --source ~/.config/dsh/memory/memory.db \
  --db ~/.config/dsh/memory/ltm.db
```

(If you prefer not to use `tsx`, bundle once and run with plain Node:
`node node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild scripts/legacy-migration/cli.ts --bundle --platform=node --format=esm --external:node:* --outfile=/tmp/legacy-migrate.mjs && node /tmp/legacy-migrate.mjs --source … --db …`.)

Both paths are explicit; there is no default database and no `--force` mode.
The source is opened read-only and validated against the exact dsh-memory v1
table layout (`PRAGMA user_version = 1`) before anything is written, and the
consistent snapshot is validated again before row import. The source database
and its committed WAL bytes are never modified; the original file remains as
the rollback. The command prints a JSON `MigrationReport` (migrated / deduped /
failures) and exits 1 if any row failed to map.

Migration maps every row to global scope (`scope = ""`) and sets
`lastConfirmedAt = updatedAt`, matching the legacy schema that had no project
concept.
