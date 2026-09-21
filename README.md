# dsh-ltm

Structured long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): a local SQLite store with CJK-aware tokenized search, hybrid BM25 + char n-gram rerank, near-duplicate detection, expiry review, and one-command migration from `dsh-memory` — zero mandatory network access.

## Why

- `dsh-memory@0.1.0` is flat-text + FTS5 with the default tokenizer: Chinese retrieval effectively does not work (whole sentences become single tokens).
- Keeping memory → chezmoi template injection safe required two locally maintained pnpm patches (`{{` zero-width-space escaping). Here the escaping is built in and configurable.

## Install into a profile

The plugin ships a bundle patch (`cordis.patch.yml`) so a profile installs it as an inserted entry:

```yaml
# in the profile's cordis.patch.yml (or via `dsh plugin`)
- insert:
    - id: ltm
      name: dsh-ltm
      config:
        path: !!js dshHomePath('memory/ltm.db')
```

`path` is **required** and has no code-side default. The recommended deployment path `memory/ltm.db` under `$DSH_HOME` is a new, independent database — the legacy `memory/memory.db` is never written by this plugin.

## Configuration

| key | default | meaning |
|---|---|---|
| `path` | *(required)* | SQLite file, or `:memory:` |
| `defaultScope` | `""` | scope applied when a tool call omits scope |
| `escapeSequences` | `['{{']` | sequences broken with a zero-width space before prompt rendering |
| `promptRecentCount` | `10` | unpinned recent memories in the recall section |
| `promptMaxChars` | `2000` | character budget of the section; pinned survive first |
| `maxTextChars` | `2000` | max characters per memory |
| `searchLimitDefault` / `searchLimitMax` | `10` / `50` | search result limits |
| `promptOrder` | `50` | recall section order |
| `dedupeThreshold` | `0.8` | Jaccard similarity ≥ this marks a near-duplicate on write |
| `dedupeCosineThreshold` | `0.92` | cosine similarity ≥ this also marks a near-duplicate |
| `staleAfterDays` | `90` | memories unconfirmed for this long render as stale |

Invalid values (empty path, non-integer bounds, thresholds outside `[0,1]`, escape sequences shorter than 2 chars or containing a zero-width space) throw at plugin load — fail loud, not at first tool call.

## Model-facing tools

Compatible with `dsh-memory` habits:

- `memory_write(text, tags?, pinned?, force?)` — dedupe check first; near-duplicates are returned instead of written unless `force: true`
- `memory_search(query, limit?)` — CJK-aware tokenization + hybrid rerank
- `memory_forget(id)`

New:

- `memory_update(id, text?, tags?, pinned?)` — revise in place, keeps the id
- `memory_confirm(id | "*")` — refresh review timestamp, clear stale
- `memory_list(scope?, tags?, stale?, limit?)` — filtered browse (tags AND)
- `memory_merge(targetId, sourceIds[], text?, tags?)` — merge duplicates; tags default to the union

## CLI

```sh
npx dsh-ltm --db /path/to/ltm.db <command> [--json]
```

`list / search / show / edit / tag / pin / merge / confirm / export / import / migrate` — every command supports `--json` for machine-readable output. Default database: `$DSH_HOME/memory/ltm.db`.

### Migrating from dsh-memory

```sh
dsh-ltm migrate ~/.config/dsh/memory/memory.db
```

The legacy database is opened read-only (copied to a temp location first); the original file is never modified and stays as the rollback. The command prints a `MigrationReport` (migrated / deduped / failures).

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

- `node:sqlite` (Node `^22.19.0 || >=24.0.0`); WAL + `busy_timeout`.
- Engine modules: `src/store.ts`, `src/tokenize.ts`, `src/search.ts`, `src/dedupe.ts`, `src/expire.ts`, `src/migrate.ts`; frozen interfaces in `src/contracts.ts`.
- Surface modules: `src/config.ts`, `src/tools.ts`, `src/prompt.ts`, `src/cli.ts`, `src/index.ts`.

MIT © tr1v3r
