/**
 * The durable memory store (R1): one `node:sqlite` connection per instance,
 * WAL + `busy_timeout`, idempotent `close()`/`dispose()`.
 *
 * The FTS5 virtual table stores tokenized text (Latin words + CJK unigrams/bigrams);
 * `memories.text` keeps the original prose. Both are maintained inside the
 * same transaction on every write path.
 *
 * @module dsh-ltm/store
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  DedupeHit,
  ListFilter,
  MemoryRecord,
  MemoryStore as MemoryStoreContract,
  MergeInput,
  MutationOptions,
  SearchResult,
  VersionedMemoryRecord,
  WriteOptions,
} from "./contracts.js";
import {
  MemoryMutationError,
  MEMORY_REVISION_MAX,
  isValidRecordId,
  isValidRevision,
  type MemoryOperation,
} from "./errors.js";
import { findDuplicates } from "./dedupe.js";
import { staleCutoff } from "./expire.js";
import { compileMatch, rerankResults } from "./search.js";
import { assertSchemaCompatible, ensureSchema } from "./schema.js";
import { joinTokens, normalizeTags, tokenize } from "./tokenize.js";

export interface StoreOptions {
  /** lastConfirmedAt older than this many days marks a record stale (R5). */
  staleAfterDays: number;
  /** Token Jaccard >= this marks a near-duplicate on write (R4). */
  dedupeThreshold: number;
  /** n-gram cosine >= this also marks a near-duplicate; >= 1 disables it. */
  dedupeCosineThreshold: number;
  /** Maximum characters accepted for one memory. */
  maxTextChars: number;
  /** Hard cap on search results. */
  searchLimitMax: number;
  /** Injectable clock (tests); defaults to `Date.now`. */
  now: () => number;
}

/** Version of the derived FTS token stream (independent of the SQL schema). */
const FTS_TOKEN_VERSION = 2;

export const DEFAULT_STORE_OPTIONS: StoreOptions = {
  staleAfterDays: 90,
  dedupeThreshold: 0.8,
  // Mirrors the plugin config default (`ConfigSchema.dedupeCosineThreshold`), so
  // direct library use and the plugin/CLI (which always pass the config value)
  // dedupe identically. Previously this was 1 (cosine dedupe effectively off),
  // diverging from the 0.92 every plugin deployment actually runs with.
  dedupeCosineThreshold: 0.92,
  maxTextChars: 2000,
  searchLimitMax: 50,
  now: Date.now,
};

type Row = Record<string, unknown>;

class StoreBusyError extends Error {}

/** Node reports SQLITE_BUSY as ERR_SQLITE_ERROR with numeric errcode 5. */
function actionableSqliteError(error: unknown): unknown {
  if (error instanceof StoreBusyError || !(error instanceof Error)) return error;
  const sqlite = error as Error & { code?: string; errcode?: number; errstr?: string };
  if (sqlite.code !== "SQLITE_BUSY" &&
      !(typeof sqlite.errcode === "number" && (sqlite.errcode & 0xff) === 5)) return error;
  const wrapped = new StoreBusyError(
    "dsh-ltm: database is busy (SQLITE_BUSY); another connection may be writing. Retry the operation later.",
    { cause: error },
  );
  // Keep the driver's identifiers, including extended SQLite result codes.
  for (const key of ["code", "errcode", "errstr"] as const) {
    if (sqlite[key] !== undefined) Object.assign(wrapped, { [key]: sqlite[key] });
  }
  return wrapped;
}

function toRecord(row: Row): VersionedMemoryRecord {
  const revision = row.revision;
  // A row missing or corrupting revision is never silently read back as a
  // default; the schema preflight already refuses such databases, this keeps
  // the invariant one layer lower too.
  if (!isValidRevision(revision)) {
    throw new Error(
      `dsh-ltm: record #${String(row.id)} has an invalid revision; refusing to read a corrupted row`,
    );
  }
  return {
    id: row.id as number,
    text: row.text as string,
    tags: row.tags as string,
    scope: row.scope as string,
    pinned: (row.pinned as number) !== 0,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    lastConfirmedAt: row.last_confirmed_at as number,
    revision,
  };
}

/**
 * Read the CAS precondition from caller options. An absent or explicitly
 * undefined `expectedRevision` means the legacy, non-CAS path (never claimed
 * to be version-protected); any other present-but-malformed value is a loud
 * {@link MemoryMutationError} instead of being downgraded to "not provided".
 */
function readExpectedRevision(
  operation: MemoryOperation,
  options: MutationOptions | undefined,
  id?: number,
): { provided: boolean; revision: number | undefined } {
  const value = options?.expectedRevision;
  // Explicit `undefined` counts as absent; every other malformed value
  // (null, strings, 0, negatives, fractions, NaN, Infinity, out of range)
  // is rejected loudly instead of being downgraded to "not provided".
  if (value === undefined) return { provided: false, revision: undefined };
  if (!isValidRevision(value)) {
    // The malformed value itself is not copied into the detail: the field is
    // typed as a number, and the message must stay metadata-only.
    throw new MemoryMutationError({
      code: "MEMORY_INVALID_ARGUMENT",
      operation,
      id,
    });
  }
  return { provided: true, revision: value };
}

/** Uniform "missing / deleted / out of scope" for CAS callers: no version leak. */
function notFound(operation: MemoryOperation, id: number): MemoryMutationError {
  return new MemoryMutationError({ code: "MEMORY_NOT_FOUND", operation, id });
}

/** Pre-write upper-bound check for every path that increments a revision. */
function assertIncrementable(operation: MemoryOperation, record: VersionedMemoryRecord): void {
  if (record.revision >= MEMORY_REVISION_MAX) {
    throw new MemoryMutationError({
      code: "MEMORY_REVISION_OVERFLOW",
      operation,
      id: record.id,
      currentRevision: record.revision,
    });
  }
}

/** Tokenize a value for the FTS columns (text/tags/scope share the shape). */
function ftsValue(text: string): string {
  return joinTokens(tokenize(text));
}

/**
 * Open (creating if absent) the store at `path`, applying the schema.
 *
 * @param path - database file, or `:memory:` for an ephemeral store.
 * @param options - engine tuning; unspecified fields fall back to
 *   {@link DEFAULT_STORE_OPTIONS}.
 * @throws when `path` is empty or the on-disk schema is from a newer version.
 */
export class MemoryStore implements MemoryStoreContract {
  readonly #db: DatabaseSync;
  readonly #options: StoreOptions;
  #closed = false;

  constructor(path: string, options?: Partial<StoreOptions>) {
    if (path.length === 0) throw new Error("dsh-ltm: `path` must not be empty");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#options = { ...DEFAULT_STORE_OPTIONS, ...options };

    // Preflight an existing database on a READ-ONLY handle, before the
    // read-write handle is even created. Opening a WAL database read-write is
    // itself destructive: SQLite folds the WAL into the main file and removes
    // `-wal`/`-shm` when the last connection closes, so a database this version
    // must refuse (newer schema, unknown shape) would still be rewritten by the
    // refusal. A read-only connection leaves the main file and `-wal` alone
    // (`-shm`, SQLite's shared-memory coordination file, may be created or
    // updated even then).
    let db: DatabaseSync | undefined;
    try {
      if (path !== ":memory:" && existsSync(path)) {
        const probe = new DatabaseSync(path, { readOnly: true });
        try {
          assertSchemaCompatible(probe);
        } finally {
          probe.close();
        }
      }

      db = this.#db = new DatabaseSync(path, { timeout: 5000 });
      this.#db.exec("PRAGMA journal_mode = WAL");
      this.#db.exec("PRAGMA busy_timeout = 5000");
      this.#db.exec("PRAGMA foreign_keys = ON");
      // `ensureSchema` re-asserts on this read-write handle: the database could
      // have appeared or changed between the preflight and this open.
      ensureSchema(this.#db);
      this.#ensureFtsTokenVersion();
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Preserve the open/initialization failure if cleanup also fails.
      }
      this.#closed = true;
      throw actionableSqliteError(error);
    }
  }

  /**
   * Rebuild the derived FTS rows when tokenizer semantics change. The SQL
   * schema is unchanged, so this lightweight data-version marker avoids
   * coupling an index refresh to the schema migration machinery.
   */
  #ensureFtsTokenVersion(): void {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'fts_token_version'").get() as
      | { value: string }
      | undefined;
    if (row?.value === String(FTS_TOKEN_VERSION)) return;

    this.#transaction(() => {
      this.#db.exec("DELETE FROM memories_fts");
      const records = this.#db.prepare("SELECT * FROM memories ORDER BY id").all() as Row[];
      for (const record of records) this.#insertFts(toRecord(record));
      this.#db
        .prepare(
          `INSERT INTO meta (key, value) VALUES ('fts_token_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(FTS_TOKEN_VERSION));
    });
  }

  #now(): number {
    return this.#options.now();
  }

  /** Run `fn` inside one transaction; FTS rows always commit with the base rows. */
  #transaction<T>(fn: () => T): T {
    let begun = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      begun = true;
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (begun) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // connection already failed the transaction; surface the original error
        }
      }
      throw actionableSqliteError(error);
    }
  }

  #insertFts(record: MemoryRecord): void {
    this.#db
      .prepare(
        "INSERT INTO memories_fts (rowid, text, tags, scope) VALUES (?, ?, ?, ?)",
      )
      .run(record.id, ftsValue(record.text), ftsValue(record.tags), ftsValue(record.scope));
  }

  #deleteFts(id: number): void {
    this.#db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(id);
  }

  #get(id: number): VersionedMemoryRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  #validateText(text: string, operation: "write" | "update" | "merge" | "import"): string {
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new Error(`memory ${operation}: \`text\` must not be blank`);
    if (trimmed.length > this.#options.maxTextChars) {
      throw new Error(
        `memory ${operation}: \`text\` is ${trimmed.length} chars, over the ${this.#options.maxTextChars} limit`,
      );
    }
    return trimmed;
  }

  #findDuplicates(text: string, scope: string): DedupeHit[] {
    const rows = this.#db
      .prepare("SELECT * FROM memories WHERE scope = ? ORDER BY updated_at DESC, id DESC")
      .all(scope) as Row[];
    return findDuplicates(text, rows.map(toRecord), {
      jaccardThreshold: this.#options.dedupeThreshold,
      cosineThreshold: this.#options.dedupeCosineThreshold,
    });
  }

  write(
    text: string,
    tags: readonly string[],
    options?: WriteOptions,
  ): { record: MemoryRecord; dedupeHits: DedupeHit[] } {
    const trimmed = this.#validateText(text, "write");
    const scope = options?.scope ?? "";
    const normalized = normalizeTags(tags);
    const now = this.#now();
    return this.#transaction(() => {
      // BEGIN IMMEDIATE serializes competing writers before the dedupe read,
      // closing the check-then-insert race across store instances.
      const hits = options?.force === true ? [] : this.#findDuplicates(trimmed, scope);
      if (hits.length > 0) {
        return { record: hits[0]!.record, dedupeHits: hits };
      }
      const row = this.#db
        .prepare(
          `INSERT INTO memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING *`,
        )
        .get(
          trimmed,
          normalized,
          scope,
          (options?.pinned ?? false) ? 1 : 0,
          now,
          now,
          now,
        ) as Row;
      const created = toRecord(row);
      this.#insertFts(created);
      return { record: created, dedupeHits: [] };
    });
  }

  /**
   * Insert a fully-formed record preserving its timestamps (migration path,
   * R8). Still re-normalizes nothing — `text`/`tags`/`scope` are indexed as
   * given. Runs the dedupe check against the target scope and reports hits
   * without writing when not forced (migration uses this to count
   * `dedupedCount`).
   *
   * Legacy boundary: inserted rows always start at `revision = 1`, and a
   * dedupe hit returns the existing record with its current revision without
   * modifying or incrementing it.
   */
  insertMigrated(
    record: Omit<MemoryRecord, "id">,
    force?: boolean,
  ): { record: VersionedMemoryRecord; dedupeHits: DedupeHit[] } {
    const text = this.#validateText(record.text, "import");
    return this.#transaction(() => {
      const hits = force === true ? [] : this.#findDuplicates(text, record.scope);
      if (hits.length > 0) {
        return { record: hits[0]!.record as VersionedMemoryRecord, dedupeHits: hits };
      }
      const row = this.#db
        .prepare(
          `INSERT INTO memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING *`,
        )
        .get(
          text,
          normalizeTags(record.tags.split(" ")),
          record.scope,
          record.pinned ? 1 : 0,
          record.createdAt,
          record.updatedAt,
          record.lastConfirmedAt,
        ) as Row;
      const created = toRecord(row);
      this.#insertFts(created);
      return { record: created, dedupeHits: [] };
    });
  }

  search(
    query: string,
    limit = 10,
    scope?: string | readonly string[],
  ): SearchResult[] {
    const match = compileMatch(query);
    if (match === undefined) return [];
    const scopes =
      scope === undefined
        ? undefined
        : [...new Set(typeof scope === "string" ? [scope] : scope)];
    if (scopes?.length === 0) return [];
    const capped = Math.max(1, Math.min(limit, this.#options.searchLimitMax));
    // A fixed pool keeps BM25 min-max normalization and ranking independent of
    // the requested output limit. The 200-candidate floor trades bounded cosine
    // work for recall quality; this is not an exact full-database rerank. Honor
    // larger configured output caps without ever fetching an unbounded pool.
    const candidateLimit = Math.max(200, this.#options.searchLimitMax);
    const scopeClause =
      scopes === undefined
        ? ""
        : `AND m.scope IN (${scopes.map(() => "?").join(", ")})`;
    const sql = `
      SELECT m.*, memories_fts.rank AS fts_rank
      FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?
      ${scopeClause}
      ORDER BY memories_fts.rank, m.id
      LIMIT ?
    `;
    const params: (string | number)[] = [match, ...(scopes ?? []), candidateLimit];
    const rows = this.#db.prepare(sql).all(...params) as Row[];
    const hits: SearchResult[] = rows.map((row) => ({
      ...toRecord(row),
      ftsRank: (row.fts_rank as number) ?? 0,
      score: 0,
    }));
    return rerankResults(query, hits).slice(0, capped);
  }

  list(filter?: ListFilter): MemoryRecord[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.scope !== undefined) {
      conditions.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter?.tags !== undefined) {
      // Whole-tag AND semantics over the normalized space-joined tag list.
      // `instr()` matches the literal substring, so SQL LIKE wildcards in a tag
      // (`_` and `%` — `_` is a legal tag character) are treated literally
      // rather than as pattern metacharacters. The previous `LIKE '% tag %'`
      // had no ESCAPE clause, so a tag like `build_tool` also matched
      // `build-tool`/`buildXtool`. A tag that normalizes to empty can never be
      // a discrete entry in the space-delimited list, so the filter matches
      // nothing.
      for (const tag of filter.tags) {
        const normalized = normalizeTags([tag]);
        if (normalized.length === 0) return [];
        conditions.push("instr(' ' || tags || ' ', ' ' || ? || ' ') > 0");
        params.push(normalized);
      }
    }
    if (filter?.stale !== undefined) {
      const cutoff = staleCutoff(this.#options.staleAfterDays, this.#now());
      conditions.push(filter.stale ? "last_confirmed_at < ?" : "last_confirmed_at >= ?");
      params.push(cutoff);
    }
    if (filter?.pinned !== undefined) {
      conditions.push("pinned = ?");
      params.push(filter.pinned ? 1 : 0);
    }
    const requestedLimit = filter?.limit;
    if (requestedLimit !== undefined && (!Number.isInteger(requestedLimit) || requestedLimit < 1)) {
      throw new Error(`memory list: \`limit\` must be an integer >= 1 (got ${requestedLimit})`);
    }
    params.push(requestedLimit === undefined ? -1 : Math.min(requestedLimit, this.#options.searchLimitMax));
    const rows = this.#db
      .prepare(
        `SELECT * FROM memories ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY scope, updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map(toRecord);
  }

  importRecords(records: readonly MemoryRecord[]): { imported: number; skipped: number } {
    const prepared = records.map((record) => {
      // Legacy export files (`dsh-ltm-export/1`) carry no revision and are
      // restored at 1 — the only boundary where absent means 1. Versioned
      // backups keep their revision, strictly validated; a malformed value
      // is never silently repaired or dropped.
      if (record.revision !== undefined && !isValidRevision(record.revision)) {
        throw new Error(`memory import: record #${record.id} has an invalid revision`);
      }
      return {
        ...record,
        revision: record.revision ?? 1,
        text: this.#validateText(record.text, "import"),
        tags: normalizeTags(record.tags.split(" ")),
      };
    });
    return this.#transaction(() => {
      let imported = 0;
      let skipped = 0;
      for (const record of prepared) {
        const existing = this.#get(record.id);
        if (existing !== undefined) {
          // Compare fields rather than JSON text: callers may hand us an
          // object whose property order differs, which must still count as the
          // same record instead of an id conflict. The revision participates
          // in the full-state comparison, so an id can never be overwritten
          // (down- or upgraded) by an import.
          if (
            existing.text === record.text &&
            existing.tags === record.tags &&
            existing.scope === record.scope &&
            existing.pinned === record.pinned &&
            existing.createdAt === record.createdAt &&
            existing.updatedAt === record.updatedAt &&
            existing.lastConfirmedAt === record.lastConfirmedAt &&
            existing.revision === record.revision
          ) {
            skipped++;
            continue;
          }
          throw new Error(`memory import: id #${record.id} conflicts with an existing record`);
        }
        const row = this.#db
          .prepare(
            `INSERT INTO memories
               (id, text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          )
          .get(
            record.id,
            record.text,
            record.tags,
            record.scope,
            record.pinned ? 1 : 0,
            record.createdAt,
            record.updatedAt,
            record.lastConfirmedAt,
            record.revision,
          ) as Row;
        this.#insertFts(toRecord(row));
        imported++;
      }
      return { imported, skipped };
    });
  }

  forPrompt(recentCount: number, scopes?: readonly string[]): MemoryRecord[] {
    const uniqueScopes = scopes === undefined ? undefined : [...new Set(scopes)];
    if (uniqueScopes?.length === 0) return [];
    const scopeClause =
      uniqueScopes === undefined
        ? ""
        : `AND scope IN (${uniqueScopes.map(() => "?").join(", ")})`;
    const params = uniqueScopes ?? [];
    const pinned = this.#db
      .prepare(
        `SELECT * FROM memories WHERE pinned = 1 ${scopeClause}
         ORDER BY updated_at DESC, id DESC`,
      )
      .all(...params) as Row[];
    const recent = this.#db
      .prepare(
        `SELECT * FROM memories WHERE pinned = 0 ${scopeClause}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, recentCount) as Row[];
    return [...pinned, ...recent].map(toRecord);
  }

  update(
    id: number,
    patch: { text?: string; tags?: readonly string[]; pinned?: boolean },
    scopes?: readonly string[],
    options?: MutationOptions,
  ): VersionedMemoryRecord | undefined {
    const text = patch.text === undefined ? undefined : this.#validateText(patch.text, "update");
    const allowed = scopes === undefined ? undefined : new Set(scopes);
    // Shape errors are rejected before any lock is taken.
    const cas = readExpectedRevision("memory_update", options, id);
    if (allowed?.size === 0) {
      if (cas.provided) throw notFound("memory_update", id);
      return undefined;
    }
    return this.#transaction(() => {
      // Scopes are applied before any version comparison: unknown, deleted
      // and out-of-scope ids are indistinguishable for CAS callers.
      const current = this.#get(id);
      if (current === undefined || (allowed !== undefined && !allowed.has(current.scope))) {
        if (cas.provided) throw notFound("memory_update", id);
        return undefined;
      }
      if (cas.provided && cas.revision !== current.revision) {
        throw new MemoryMutationError({
          code: "MEMORY_REVISION_CONFLICT",
          operation: "memory_update",
          id,
          expectedRevision: cas.revision,
          currentRevision: current.revision,
        });
      }
      assertIncrementable("memory_update", current);
      const next = {
        text: text ?? current.text,
        tags: patch.tags !== undefined ? normalizeTags(patch.tags) : current.tags,
        pinned: patch.pinned ?? current.pinned,
      };
      const row = this.#db
        .prepare(
          `UPDATE memories SET text = ?, tags = ?, pinned = ?, updated_at = ?, revision = revision + 1
           WHERE id = ? RETURNING *`,
        )
        .get(next.text, next.tags, next.pinned ? 1 : 0, this.#now(), id) as Row;
      const updated = toRecord(row);
      this.#deleteFts(id);
      this.#insertFts(updated);
      return updated;
    });
  }

  confirm(id: number | "*", scopes?: readonly string[], options?: MutationOptions): number {
    return this.confirmVersioned(id, scopes, options).confirmed;
  }

  confirmVersioned(
    id: number | "*",
    scopes?: readonly string[],
    options?: MutationOptions,
  ): { confirmed: number; revision?: number } {
    // `*` can never carry one revision for the whole batch: rejected before
    // any read, even when zero records are visible.
    const cas = readExpectedRevision("memory_confirm", options, id === "*" ? undefined : id);
    if (id === "*" && cas.provided) {
      throw new MemoryMutationError({
        code: "MEMORY_INVALID_ARGUMENT",
        operation: "memory_confirm",
      });
    }
    const uniqueScopes = scopes === undefined ? undefined : [...new Set(scopes)];
    if (uniqueScopes?.length === 0) {
      if (cas.provided) throw notFound("memory_confirm", id as number);
      return { confirmed: 0 };
    }
    const scopeClause =
      uniqueScopes === undefined
        ? ""
        : `scope IN (${uniqueScopes.map(() => "?").join(", ")})`;
    const now = this.#now();
    return this.#transaction(() => {
      if (id === "*") {
        // Same-transaction precheck + update: one visible row at the ceiling
        // fails the whole batch before anything is written.
        const overflow = this.#db
          .prepare(
            `SELECT id FROM memories WHERE ${scopeClause.length > 0 ? `${scopeClause} AND ` : ""}revision >= ? ORDER BY id LIMIT 1`,
          )
          .get(...(uniqueScopes ?? []), MEMORY_REVISION_MAX) as { id: number } | undefined;
        if (overflow !== undefined) {
          throw new MemoryMutationError({
            code: "MEMORY_REVISION_OVERFLOW",
            operation: "memory_confirm",
            id: overflow.id,
            currentRevision: MEMORY_REVISION_MAX,
          });
        }
        const confirmed = Number(
          this.#db
            .prepare(
              `UPDATE memories SET last_confirmed_at = ?, revision = revision + 1${scopeClause.length === 0 ? "" : ` WHERE ${scopeClause}`}`,
            )
            .run(now, ...(uniqueScopes ?? [])).changes,
        );
        return { confirmed };
      }
      const current = this.#get(id);
      if (current === undefined || (uniqueScopes !== undefined && !uniqueScopes.includes(current.scope))) {
        if (cas.provided) throw notFound("memory_confirm", id);
        return { confirmed: 0 };
      }
      if (cas.provided && cas.revision !== current.revision) {
        throw new MemoryMutationError({
          code: "MEMORY_REVISION_CONFLICT",
          operation: "memory_confirm",
          id,
          expectedRevision: cas.revision,
          currentRevision: current.revision,
        });
      }
      assertIncrementable("memory_confirm", current);
      const row = this.#db
        .prepare(
          `UPDATE memories SET last_confirmed_at = ?, revision = revision + 1 WHERE id = ? RETURNING revision`,
        )
        .get(now, id) as Row;
      return { confirmed: 1, revision: row.revision as number };
    });
  }

  merge(input: MergeInput, scopes?: readonly string[]): VersionedMemoryRecord | undefined {
    const replacementText = input.text === undefined
      ? undefined
      : this.#validateText(input.text, "merge");
    const allowed = scopes === undefined ? undefined : new Set(scopes);
    // Legacy `sourceIds` quirks are normalized once: duplicates collapse and
    // the target id itself is ignored rather than rejected.
    const sourceIds = [...new Set(input.sourceIds)].filter((id) => id !== input.targetId);
    const cas = this.#mergePreconditions(input, sourceIds);
    if (allowed?.size === 0) {
      if (cas !== undefined) throw notFound("memory_merge", input.targetId);
      return undefined;
    }
    return this.#transaction(() => {
      const target = this.#get(input.targetId);
      if (target === undefined || (allowed !== undefined && !allowed.has(target.scope))) {
        if (cas !== undefined) throw notFound("memory_merge", input.targetId);
        return undefined;
      }
      const sources: VersionedMemoryRecord[] = [];
      // Stable order (ascending id) so a multi-party failure reports the
      // first deterministic conflict.
      for (const sourceId of [...sourceIds].sort((a, b) => a - b)) {
        const source = this.#get(sourceId);
        if (source === undefined) {
          if (cas !== undefined) throw notFound("memory_merge", sourceId);
          throw new Error(`memory merge: source #${sourceId} does not exist`);
        }
        if (allowed !== undefined && !allowed.has(source.scope)) {
          if (cas !== undefined) throw notFound("memory_merge", sourceId);
          throw new Error(`memory merge: source #${sourceId} is outside the active project`);
        }
        if (source.scope !== target.scope) {
          // Metadata-only failure: no paths, no other scope's content.
          throw new MemoryMutationError({
            code: "MEMORY_SCOPE_MISMATCH",
            operation: "memory_merge",
            id: sourceId,
          });
        }
        sources.push(source);
      }
      if (cas !== undefined) {
        // All participants visible and same-scope before any comparison.
        if (target.revision !== cas.expectedRevision) {
          throw new MemoryMutationError({
            code: "MEMORY_REVISION_CONFLICT",
            operation: "memory_merge",
            id: target.id,
            expectedRevision: cas.expectedRevision,
            currentRevision: target.revision,
          });
        }
        for (const source of sources) {
          const expected = cas.sourceRevisions.get(source.id);
          if (expected !== source.revision) {
            throw new MemoryMutationError({
              code: "MEMORY_REVISION_CONFLICT",
              operation: "memory_merge",
              id: source.id,
              expectedRevision: expected,
              currentRevision: source.revision,
            });
          }
        }
      }
      // Sources are only deleted, never incremented, so a ceiling source is
      // mergeable; the target is the one that must still be incrementable.
      assertIncrementable("memory_merge", target);
      const tagUnion = new Set(
        `${target.tags} ${sources.map((s) => s.tags).join(" ")}`.split(/\s+/).filter(Boolean),
      );
      const text = replacementText ?? target.text;
      const tags =
        input.tags !== undefined ? normalizeTags(input.tags) : [...tagUnion].sort().join(" ");
      const row = this.#db
        .prepare(
          `UPDATE memories SET text = ?, tags = ?, pinned = ?, updated_at = ?, revision = revision + 1
           WHERE id = ? RETURNING *`,
        )
        .get(
          text,
          tags,
          (input.pinned ?? target.pinned) ? 1 : 0,
          this.#now(),
          input.targetId,
        ) as Row;
      for (const source of sources) {
        this.#db.prepare("DELETE FROM memories WHERE id = ?").run(source.id);
        this.#deleteFts(source.id);
      }
      this.#deleteFts(input.targetId);
      const merged = toRecord(row);
      this.#insertFts(merged);
      return merged;
    });
  }

  /**
   * Validate the CAS preconditions of a merge. Absent CAS fields = legacy
   * (`undefined`); any present field switches to strict mode, which requires
   * `expectedRevision` for the target plus a complete, exact, duplicate-free
   * declaration covering every unique non-target source id. All shape errors
   * throw before any lock or read.
   */
  #mergePreconditions(
    input: MergeInput,
    sourceIds: readonly number[],
  ): { expectedRevision: number; sourceRevisions: Map<number, number> } | undefined {
    const hasTarget = input.expectedRevision !== undefined;
    const declared = input.expectedSourceRevisions;
    if (!hasTarget && declared === undefined) return undefined;
    const invalid = new MemoryMutationError({
      code: "MEMORY_INVALID_ARGUMENT",
      operation: "memory_merge",
      id: input.targetId,
    });
    if (!isValidRevision(input.expectedRevision)) throw invalid;
    if (!Array.isArray(declared)) throw invalid;
    const sourceSet = new Set(sourceIds);
    const sourceRevisions = new Map<number, number>();
    for (const entry of declared) {
      if (typeof entry !== "object" || entry === null) throw invalid;
      if (!isValidRecordId(entry.id) || !isValidRevision(entry.revision)) throw invalid;
      if (entry.id === input.targetId) throw invalid; // target declared as a source
      if (!sourceSet.has(entry.id)) throw invalid; // extra/unknown id
      if (sourceRevisions.has(entry.id)) throw invalid; // repeated declaration
      sourceRevisions.set(entry.id, entry.revision);
    }
    if (sourceRevisions.size !== sourceSet.size) throw invalid; // missing sources
    return { expectedRevision: input.expectedRevision, sourceRevisions };
  }

  forget(id: number, scopes?: readonly string[], options?: MutationOptions): boolean {
    return this.forgetVersioned(id, scopes, options).deleted;
  }

  forgetVersioned(
    id: number,
    scopes?: readonly string[],
    options?: MutationOptions,
  ): { deleted: boolean; deletedRevision?: number } {
    const cas = readExpectedRevision("memory_forget", options, id);
    const uniqueScopes = scopes === undefined ? undefined : [...new Set(scopes)];
    if (uniqueScopes?.length === 0) {
      if (cas.provided) throw notFound("memory_forget", id);
      return { deleted: false };
    }
    return this.#transaction(() => {
      const current = this.#get(id);
      if (current === undefined || (uniqueScopes !== undefined && !uniqueScopes.includes(current.scope))) {
        if (cas.provided) throw notFound("memory_forget", id);
        return { deleted: false };
      }
      if (cas.provided && cas.revision !== current.revision) {
        throw new MemoryMutationError({
          code: "MEMORY_REVISION_CONFLICT",
          operation: "memory_forget",
          id,
          expectedRevision: cas.revision,
          currentRevision: current.revision,
        });
      }
      // Deleting needs no increment, so a ceiling revision is forgettable.
      this.#db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      this.#deleteFts(id);
      // The revision that was removed — never a post-delete value.
      return { deleted: true, deletedRevision: current.revision };
    });
  }

  count(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM memories").get() as Row).n as number;
  }

  /** Close the connection; idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  /** Alias for {@link close} — the plugin disposer calls this. */
  dispose(): void {
    this.close();
  }
}
