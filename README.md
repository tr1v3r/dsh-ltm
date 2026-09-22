# dsh-ltm

Structured long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): a local SQLite store with CJK-aware tokenized search, hybrid BM25 + char n-gram rerank, near-duplicate detection, expiry review, and one-command migration from `dsh-memory` — zero mandatory network access.

## Why

- `dsh-memory@0.1.0` is flat-text + FTS5 with the default tokenizer: Chinese retrieval effectively does not work (whole sentences become single tokens).
- Long-lived memories need lifecycle controls beyond append/search: structured scopes and tags, duplicate detection, review timestamps, and bounded recall.

## Install into a profile

With `@tr1v3r/dsh-ltm` **0.1.2 or newer**, install and register the bundled configuration in one command:

```sh
dsh plugin --profile web add @tr1v3r/dsh-ltm
```

This command intentionally does not pin a historical release. Your package manager's release-age policy still applies: pnpm 11 defaults to a 24-hour delay, so it may select an earlier eligible version immediately after a release (even with `@latest`). To try a just-published release, check [Releases](https://github.com/tr1v3r/dsh-ltm/releases) and explicitly append its version, or wait for it to mature. With the default non-strict policy, an explicit version is recorded as a package-specific release-age exception; `minimumReleaseAgeStrict` may require approval.

**Initial release caveat (2026-09-22):** one-command installation requires **0.1.2 or newer**. Until 0.1.2 has aged 24 hours, the command above can select bundle-less 0.1.0/0.1.1; use `@tr1v3r/dsh-ltm@0.1.2` during that initial window. This is a temporary workaround, not a permanent version recommendation.

Replace `web` with your profile name (for example `dsh-tui`), then restart that profile. The bundle sets the database path to `$DSH_HOME/memory/ltm.db`; no API key or embedding service is needed.

When replacing `dsh-memory`, disable its existing entry first: both plugins register `memory_write`, `memory_search`, and `memory_forget`. If you already inserted an `ltm` entry manually, remove that manual insert before enabling the bundle to avoid duplicate instances. Installing does not migrate the old database automatically; see [Migrating from dsh-memory](#migrating-from-dsh-memory).

For manual composition (including versions 0.1.0–0.1.1, which lack the bundle manifest), install the npm dependency and insert the following into the profile's `cordis.patch.yml` instead of enabling the bundle:

```yaml
- insert:
    - id: ltm
      name: '@tr1v3r/dsh-ltm'
      config:
        path: !!js dshHomePath('memory/ltm.db')
```

`path` is **required** and has no code-side default. The recommended deployment path `memory/ltm.db` under `$DSH_HOME` is a new, independent database — the legacy `memory/memory.db` is never written by this plugin.

## Configuration

| key | default | meaning |
|---|---|---|
| `path` | *(required)* | SQLite file, or `:memory:` |
| `defaultScope` | `""` | fallback scope, or fixed scope when automatic detection is disabled |
| `autoProjectScope` | `true` | derive the active project from each agent session's cwd/Git repository |
| `escapeSequences` | `[]` | optional output sequences broken with a zero-width space before prompt rendering |
| `promptRecentCount` | `10` | unpinned recent memories in the recall section |
| `promptMaxChars` | `2000` | hard UTF-16 character budget of the section; pinned survive first |
| `promptMaxTokens` | *(unset)* | optional positive safe-integer hard token cap, alongside characters |
| `promptTokenizerPath` | *(unset)* | local supported Hugging Face `tokenizer.json`; required together with `promptMaxTokens` |
| `maxTextChars` | `2000` | max characters per memory |
| `searchLimitDefault` / `searchLimitMax` | `10` / `50` | search result limits |
| `promptOrder` | `50` | recall section order |
| `dedupeThreshold` | `0.8` | Jaccard similarity ≥ this marks a near-duplicate on write |
| `dedupeCosineThreshold` | `0.92` | cosine similarity ≥ this also marks a near-duplicate |
| `staleAfterDays` | `90` | memories unconfirmed for this long render as stale |

Memory text is preserved exactly in recalled prompts by default. `escapeSequences` is an explicit deployment-level opt-in for environments that pass rendered prompts through an additional delimiter-based parser; DSH itself does not require it.

Invalid values (empty path, non-integer bounds, thresholds outside `[0,1]`, escape sequences shorter than 2 chars or containing a zero-width space) throw at plugin load — fail loud, not at first tool call.

### Automatic project isolation

With `autoProjectScope: true`, every agent resolves its own `session.header.cwd`; the shared DSH process cwd is never used. A Git checkout is identified by its canonical common Git directory, so subdirectories and linked worktrees share one project scope. A non-Git workspace is identified by its canonical directory. Git scope names contain only a short SHA-256 digest so every linked-worktree layout stays identical; directory scopes also include a readable basename. Absolute paths are never stored.

Model-facing defaults are intentionally narrow:

- writes and near-duplicate checks use the active project scope;
- search and automatic prompt recall see only the active project plus global memories (`scope=""`);
- update, forget, confirm, and merge reject records outside those visible scopes, and merge never crosses scope boundaries;
- `memory_list` and the CLI remain explicit cross-project aggregation/administration surfaces.

Set `autoProjectScope: false` to use only `defaultScope` as a fixed deployment scope (use `""` for global-only operation). Scope is a context-isolation boundary, not an operating-system permission boundary; anyone with direct access to the SQLite file or CLI can still administer every record.
### Optional offline prompt token budget

```yaml
# Add to the ltm entry's config; provision this local asset yourself.
promptMaxChars: 2000
promptMaxTokens: 512
promptTokenizerPath: /path/to/pinned-model-revision/tokenizer.json
```

Neither option is enabled by default: existing character-only output stays unchanged.
Both must be set together. The optional `@huggingface/tokenizers@0.2.0` dependency
is loaded **only at configured plugin startup**, once; rendering remains synchronous,
with no network requests, downloads, or file reads. Install optional dependencies
if your package manager omits them. The CLI does not render prompts and is unchanged.

This supports a **restricted, fidelity-tested ByteLevel/BPE subset**: GPT-2-style
ByteLevel or the published DeepSeek-V3 Isolated Split patterns followed by ByteLevel,
with no normalizer (or an empty Sequence), a complete byte vocabulary and deterministic
BPE. Unsupported pipelines/options fail at startup, rather than silently approximating
an arbitrary Hugging Face tokenizer. Missing files, malformed JSON, invalid limits,
and missing optional dependencies also fail loudly before opening the store.

The cap counts the **complete escaped recall section**, including header, metadata,
newlines, truncation ellipsis and any omission notice, without adding BOS/EOS or a
chat template. Pinned records take priority; recent records never displace pinned
records for an omission notice. When necessary the first pinned line is shortened
on a Unicode code-point boundary. If even its identifiable prefix plus header and
ellipsis cannot fit both caps, the section is empty. Counts are not additive; every
candidate is encoded as a whole. UTF-16 character limits remain hard caps.

Offline counts are exact for the supported chosen tokenizer definition, **not a
promise of server-reported usage**: providers may use another revision/tokenizer,
chat framing or special-token policy. No automatic model routing or server usage
calibration is performed. FTS/search/dedupe tokenization and schema versions are
unaffected. See [provisioning, compatibility and verification](docs/prompt-token-budget.md)
for asset version/hash/license requirements, overhead and fidelity evidence.

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

## Scale and limitations

Near-duplicate detection scans all memories in the same scope on each non-forced `memory_write`. This design targets personal long-term fact stores rather than large document collections. Write cost grows with the number and length of memories in that scope; no benchmark-backed capacity limit is currently documented.

Multiple sessions on one personal PC or server can share a local WAL database. Opening an initialized, compatible store with current FTS tokens does not take the schema writer lock; first initialization, schema repair, and token-index rebuilds still require writes. SQLite still serializes writers with a 5-second busy timeout. A `SQLITE_BUSY` error asks you to retry later; there is no automatic application retry. Dedupe remains inside the write transaction, so its full-scope scan can hold the writer lock longer as the store grows. This is not a high-concurrency service or cross-machine database synchronization.

## CLI

```sh
npx -p @tr1v3r/dsh-ltm dsh-ltm --db /path/to/ltm.db <command> [--json]
```

`list / search / show / edit / tag / pin / merge / confirm / export / import / migrate` — every command supports `--json` for machine-readable output. Unknown flags, mutually exclusive flags, and surplus positional arguments are rejected. Default database: `$DSH_HOME/memory/ltm.db`.

`export` emits `dsh-ltm-export/1`; `import` validates the complete payload and restores IDs, timestamps, normalized tags, scope, pinned state, and stale lifecycle. Re-importing an identical ID is skipped; an ID whose stored value differs aborts the entire import without partial writes.

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

## Publishing credentials

Releases go out through npm Trusted Publishing (OIDC + provenance) from `.github/workflows/publish.yml`, so CI needs no stored npm token at all.

Keep any other npm publishing credential outside the repository whenever possible. If a local publish command requires a project-level config, use the ignored `.npmrc-publish` path and never force-add it to Git. Do not place an npm token in a tracked `.npmrc`, source file, example, test fixture, shell transcript, or CI log.

Provide CI publishing credentials through the platform's encrypted secret store. Use a least-privilege, short-lived or granular token where supported. If a token may have entered a commit, log, artifact, or shared terminal history, revoke or rotate it in the npm account immediately before cleaning up the exposed copy; rewriting Git history alone does not invalidate the credential.

MIT © tr1v3r
