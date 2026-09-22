# dsh-ltm — Project Instructions

## Overview

`@tr1v3r/dsh-ltm` is a structured, local-first long-term-memory plugin for
DeepSeek Harness. It stores memories in SQLite, indexes CJK-aware token streams
with FTS5, reranks results with BM25 plus character n-gram cosine similarity,
and exposes the same core through Cordis tools and a CLI.

The package is ESM TypeScript and supports Node `^22.19.0 || >=24.0.0`.
`node:sqlite` may print an ExperimentalWarning on supported Node versions; this
is expected.

## Commands

```sh
pnpm install
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest run
pnpm build                # tsdown → dist/
node probe/boot-probe.mjs # real Cordis boot and tool lifecycle probe
node bin/dsh-ltm.mjs --help
```

Before completing a code change, run at least `pnpm typecheck && pnpm test`.
Run `pnpm build` when changing public exports, CLI entry points, or packaging.
Changes to plugin wiring or tool schemas must also pass the real boot probe;
`--dump-config` alone does not import plugin modules.

## Project Structure

- `src/contracts.ts` — frozen contracts shared by engine and surfaces.
- `src/schema.ts` — SQLite schema/version compatibility checks.
- `src/store.ts` — transactional store and FTS synchronization.
- `src/tokenize.ts`, `src/search.ts`, `src/dedupe.ts` — retrieval pipeline.
- `src/expire.ts`, `src/migrate.ts` — lifecycle and legacy migration.
- `src/tools.ts` — model-facing semantics shared with integrations.
- `src/prompt.ts` — bounded recall prompt rendering.
- `src/config.ts` — Schemastery config and fail-loud validation.
- `src/index.ts` — Cordis plugin entry and tool registration.
- `src/cli.ts`, `bin/dsh-ltm.mjs` — CLI implementation and executable.
- `tests/` — Vitest unit and integration tests matching source modules.
- `probe/` — minimal real-boot Cordis fixture.
- `docs/` — requirements, data model, ADRs, verification, and runbooks.

## Architectural Invariants

- Keep the package local-first: no mandatory network or embedding dependency.
- `memories.text` stores original prose; `memories_fts` stores derived tokens.
- Update the base row and its FTS row in the same transaction on every write.
- Run dedupe reads after `BEGIN IMMEDIATE` so concurrent writers cannot bypass
  the check-then-insert decision.
- Quote every FTS5 query token; never concatenate raw model/user input into
  `MATCH` expressions or SQL.
- Treat `meta.schema_version` and `meta.fts_token_version` separately. A token
  format change should rebuild the derived FTS index, not silently alter data.
- Preflight existing databases read-only and fail closed on unknown, malformed,
  older-without-migration, or newer schemas. Refusal must not rewrite the main
  database or committed WAL bytes.
- Legacy migration must open the source read-only and use a SQLite-consistent
  snapshot; never mutate or checkpoint the old `dsh-memory` database.
- `stale` is derived from `lastConfirmedAt`; do not add a persisted stale flag.
- Pinned prompt lines take precedence over recent lines and must never be
  evicted merely to fit the optional omission notice.
- Escape configured prompt sequences only at rendering time; preserve stored
  memory text unchanged.

## Code Conventions

- Use strict TypeScript and explicit types at public seams. Preserve
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` compatibility.
- Keep engine logic independent of Cordis. The plugin and CLI should reuse the
  store/tool semantics rather than implement parallel behavior.
- Validate configuration and operator input early and fail loudly with an
  actionable message. Do not silently redirect a CLI operation to another DB.
- Keep SQLite connections and temporary resources in `try/finally` blocks;
  `close()` must remain idempotent.
- Never log secrets or memory contents unless the operator explicitly requested
  those records through a command/tool result.
- Add regression tests beside the affected module as `tests/<module>.test.ts`.
- When changing a tool serializer, update and test its registered output schema
  against the actual value returned through the tool registry.

## Compatibility and Scope

The legacy tools `memory_write`, `memory_search`, and `memory_forget` retain
compatible model-facing behavior. New fields or tools must not weaken the
contracts in `src/contracts.ts`. The optional `EmbeddingAdapter` is a future
seam; version 0.1 uses only BM25 plus character n-gram cosine reranking.

## Git and Release

Agent-executed tasks must not modify the working tree directly. Before making
any change, create a dedicated git worktree under the `.git` directory (e.g.
`git worktree add .git/worktrees/<task> -b <task-branch>`) and do all work
there; apply results back via branch/merge or patch instead of editing the
main checkout in place.

Use Conventional Commits. CI tests Node 22 and 24 and validates packed-file
contents. Publishing is manual/tag-gated through npm Trusted Publishing. Do not
commit npm tokens, local databases, build output, caches, or files under
`probe/tmp/`.
