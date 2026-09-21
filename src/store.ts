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

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  DedupeHit,
  ListFilter,
  MemoryRecord,
  MemoryStore as MemoryStoreContract,
  MergeInput,
  SearchResult,
  WriteOptions,
} from "./contracts.js";
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

function toRecord(row: Row): MemoryRecord {
  return {
    id: row.id as number,
    text: row.text as string,
    tags: row.tags as string,
    scope: row.scope as string,
    pinned: (row.pinned as number) !== 0,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    lastConfirmedAt: row.last_confirmed_at as number,
  };
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
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    try {
      // This read-only preflight must precede journal-mode changes and DDL: an
      // unsupported database is rejected without changing any source bytes.
      assertSchemaCompatible(this.#db);
      this.#db.exec("PRAGMA journal_mode = WAL");
      this.#db.exec("PRAGMA busy_timeout = 5000");
      this.#db.exec("PRAGMA foreign_keys = ON");
      ensureSchema(this.#db);
      this.#ensureFtsTokenVersion();
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
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
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // connection already failed the transaction; surface the original error
      }
      throw error;
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

  #get(id: number): MemoryRecord | undefined {
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
          `INSERT INTO memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
   */
  insertMigrated(
    record: Omit<MemoryRecord, "id">,
    force?: boolean,
  ): { record: MemoryRecord; dedupeHits: DedupeHit[] } {
    const text = this.#validateText(record.text, "import");
    return this.#transaction(() => {
      const hits = force === true ? [] : this.#findDuplicates(text, record.scope);
      if (hits.length > 0) {
        return { record: hits[0]!.record, dedupeHits: hits };
      }
      const row = this.#db
        .prepare(
          `INSERT INTO memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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

  search(query: string, limit = 10, scope?: string): SearchResult[] {
    const match = compileMatch(query);
    if (match === undefined) return [];
    const capped = Math.max(1, Math.min(limit, this.#options.searchLimitMax));
    const sql = `
      SELECT m.*, memories_fts.rank AS fts_rank
      FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?
      ${scope === undefined ? "" : "AND m.scope = ?"}
      ORDER BY memories_fts.rank
      LIMIT ?
    `;
    const params: (string | number)[] =
      scope === undefined ? [match, capped] : [match, scope, capped];
    const rows = this.#db.prepare(sql).all(...params) as Row[];
    const hits: SearchResult[] = rows.map((row) => ({
      ...toRecord(row),
      ftsRank: (row.fts_rank as number) ?? 0,
      score: 0,
    }));
    return rerankResults(query, hits);
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
    const prepared = records.map((record) => ({
      ...record,
      text: this.#validateText(record.text, "import"),
      tags: normalizeTags(record.tags.split(" ")),
    }));
    return this.#transaction(() => {
      let imported = 0;
      let skipped = 0;
      for (const record of prepared) {
        const existing = this.#get(record.id);
        if (existing !== undefined) {
          if (JSON.stringify(existing) === JSON.stringify(record)) {
            skipped++;
            continue;
          }
          throw new Error(`memory import: id #${record.id} conflicts with an existing record`);
        }
        const row = this.#db
          .prepare(
            `INSERT INTO memories
               (id, text, tags, scope, pinned, created_at, updated_at, last_confirmed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
          ) as Row;
        this.#insertFts(toRecord(row));
        imported++;
      }
      return { imported, skipped };
    });
  }

  forPrompt(recentCount: number): MemoryRecord[] {
    const pinned = this.#db
      .prepare("SELECT * FROM memories WHERE pinned = 1 ORDER BY updated_at DESC, id DESC")
      .all() as Row[];
    const recent = this.#db
      .prepare(
        "SELECT * FROM memories WHERE pinned = 0 ORDER BY updated_at DESC, id DESC LIMIT ?",
      )
      .all(recentCount) as Row[];
    return [...pinned, ...recent].map(toRecord);
  }

  update(
    id: number,
    patch: { text?: string; tags?: readonly string[]; pinned?: boolean },
  ): MemoryRecord | undefined {
    const text = patch.text === undefined ? undefined : this.#validateText(patch.text, "update");
    return this.#transaction(() => {
      const current = this.#get(id);
      if (current === undefined) return undefined;
      const next = {
        text: text ?? current.text,
        tags: patch.tags !== undefined ? normalizeTags(patch.tags) : current.tags,
        pinned: patch.pinned ?? current.pinned,
      };
      const row = this.#db
        .prepare(
          `UPDATE memories SET text = ?, tags = ?, pinned = ?, updated_at = ?
           WHERE id = ? RETURNING *`,
        )
        .get(next.text, next.tags, next.pinned ? 1 : 0, this.#now(), id) as Row;
      const updated = toRecord(row);
      this.#deleteFts(id);
      this.#insertFts(updated);
      return updated;
    });
  }

  confirm(id: number | "*"): number {
    const now = this.#now();
    if (id === "*") {
      return Number(
        this.#db
          .prepare("UPDATE memories SET last_confirmed_at = ?")
          .run(now).changes,
      );
    }
    return Number(
      this.#db
        .prepare("UPDATE memories SET last_confirmed_at = ? WHERE id = ?")
        .run(now, id).changes,
    );
  }

  merge(input: MergeInput): MemoryRecord | undefined {
    const replacementText = input.text === undefined
      ? undefined
      : this.#validateText(input.text, "merge");
    return this.#transaction(() => {
      const target = this.#get(input.targetId);
      if (target === undefined) return undefined;
      const sources: MemoryRecord[] = [];
      for (const sourceId of input.sourceIds) {
        const source = this.#get(sourceId);
        if (source === undefined) {
          throw new Error(`memory merge: source #${sourceId} does not exist`);
        }
        if (sourceId === input.targetId) continue;
        sources.push(source);
      }
      const tagUnion = new Set(
        `${target.tags} ${sources.map((s) => s.tags).join(" ")}`.split(/\s+/).filter(Boolean),
      );
      const text = replacementText ?? target.text;
      const tags =
        input.tags !== undefined ? normalizeTags(input.tags) : [...tagUnion].sort().join(" ");
      const row = this.#db
        .prepare(
          `UPDATE memories SET text = ?, tags = ?, pinned = ?, updated_at = ?
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

  forget(id: number): boolean {
    return this.#transaction(() => {
      const deleted =
        Number(this.#db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
      if (deleted) this.#deleteFts(id);
      return deleted;
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
