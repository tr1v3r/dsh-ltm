/**
 * Frozen interfaces for dsh-ltm 0.1.
 *
 * This module is the contract between the core engine (store / tokenize /
 * search / dedupe / expire / migrate) and the plugin surface (config /
 * tools / prompt / CLI). Field and function semantics here are normative:
 * implementations must not weaken them, and reviews check against them.
 *
 * Compatibility note: `MemoryRecord` extends the dsh-memory@0.1.0 record
 * (id/text/tags/pinned/createdAt/updatedAt) with additional columns; the
 * three legacy tools (`memory_write` / `memory_search` / `memory_forget`)
 * keep their parameter and result shapes so existing model habits carry
 * over unchanged.
 *
 * @module dsh-ltm/contracts
 */

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Scope bucket for cross-project aggregation (R1, R6). Empty = global. */
export type ScopeName = string;

/**
 * One stored memory as tools and the prompt section see it.
 * Superset of the legacy dsh-memory record; migration maps old rows onto
 * this shape (R8).
 */
export interface MemoryRecord {
  id: number;
  /** The self-contained fact. Never logged (R9, secrets policy). */
  text: string;
  /** Normalized, deduplicated, space-joined lowercase tag list; "" if none. */
  tags: string;
  /** Optional project/scope bucket for aggregation views. */
  scope: ScopeName;
  /** Pinned records always render in the recall section, ahead of recent ones. */
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * Epoch ms of the last `memory_confirm` (or creation). Records whose
   * lastConfirmedAt is older than `staleAfterDays` are marked stale (R5).
   */
  lastConfirmedAt: number;
}

/** A search hit: the record plus engine scores. */
export interface SearchResult extends MemoryRecord {
  /** FTS5/BM25 rank (lower = better) before rerank; 0 when rerank-only. */
  ftsRank: number;
  /** Final blended relevance score; higher = better. */
  score: number;
}

/** A near-duplicate candidate surfaced on write (R4). */
export interface DedupeHit {
  record: MemoryRecord;
  /** Similarity in [0,1]; >= configured threshold means "hit". */
  similarity: number;
  /** Which measure produced the similarity: "jaccard" | "cosine". */
  measure: "jaccard" | "cosine";
}

/** Outcome of one migration run from the legacy dsh-memory database (R8). */
export interface MigrationReport {
  /** Absolute path of the legacy database that was read. */
  sourcePath: string;
  /** Rows found in the legacy `memories` table. */
  sourceCount: number;
  /** Rows copied into the new store. */
  migratedCount: number;
  /** Rows skipped as near-duplicates of already-stored content. */
  dedupedCount: number;
  /** Rows that failed to map; entry per row with the reason. */
  failures: Array<{ legacyId: number; reason: string }>;
  /** Epoch ms start/end of the run. */
  startedAt: number;
  endedAt: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Options for {@link MemoryStore.write} when a dedupe check should run. */
export interface WriteOptions {
  scope?: ScopeName;
  pinned?: boolean;
  /** Skip the dedupe check and force the write (model chose "strong write"). */
  force?: boolean;
}

/** Filter for {@link MemoryStore.list}. All fields optional (AND-combined). */
export interface ListFilter {
  scope?: ScopeName;
  /** Match records whose tags contain every listed tag. */
  tags?: readonly string[];
  /** Only stale / only fresh; undefined = both. */
  stale?: boolean;
  pinned?: boolean;
  limit?: number;
}

/** Merge semantics for {@link MemoryStore.merge} (R4, R6). */
export interface MergeInput {
  /** Surviving record id. */
  targetId: number;
  /** Ids absorbed into the target and then deleted. */
  sourceIds: readonly number[];
  /** Replacement text; defaults to the target's text. */
  text?: string;
  /** Replacement tags; defaults to the union of all merged records' tags. */
  tags?: readonly string[];
  /** Pinned flag of the result; defaults to target's. */
  pinned?: boolean;
}

/**
 * The durable memory store. One instance owns one SQLite connection
 * (WAL, busy_timeout). `close()` is idempotent and runs from the plugin's
 * disposer.
 */
export interface MemoryStore {
  /** Store one memory; runs dedupe first unless `force`. */
  write(text: string, tags: readonly string[], options?: WriteOptions):
    { record: MemoryRecord; dedupeHits: DedupeHit[] };
  /** Hybrid search over text and tags, best match first (R2, R3). */
  search(query: string, limit?: number, scope?: ScopeName): SearchResult[];
  /** Filtered browse (R6, memory_list). Limits are validated and hard-capped. */
  list(filter?: ListFilter): MemoryRecord[];
  /**
   * Atomically restore exported records with their ids and lifecycle timestamps.
   * An identical existing id is skipped; a different record with the same id
   * aborts the complete import as a conflict.
   */
  importRecords(records: readonly MemoryRecord[]): { imported: number; skipped: number };
  /** Records for the recall section: pinned first, then recent, deduped. */
  forPrompt(recentCount: number): MemoryRecord[];
  /** Revise text/tags/pinned in place, keeping the id (memory_update). */
  update(id: number, patch: { text?: string; tags?: readonly string[]; pinned?: boolean }):
    MemoryRecord | undefined;
  /** Refresh lastConfirmedAt / clear stale for one or all records (R5). */
  confirm(id: number | "*"): number;
  /** Merge duplicates; returns the surviving record (memory_merge). */
  merge(input: MergeInput): MemoryRecord | undefined;
  /** Delete one memory. */
  forget(id: number): boolean;
  /** Total stored memories. */
  count(): number;
  /** Close the connection; idempotent. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Tokenize / search engine seams (frozen so implementations stay swappable)
// ---------------------------------------------------------------------------

/**
 * CJK-aware tokenizer (R2): Latin/digit runs as whole lowercase words,
 * CJK text as overlapping bigrams (unigram fallback for isolated CJK chars).
 * Returned tokens are FTS5-safe (already quote-stripped content); the FTS
 * layer must quote every token when building MATCH expressions.
 */
export type Tokenizer = (input: string) => string[];

/**
 * Relevance reranker (R3 default tier): blends BM25 (from FTS5) with
 * char n-gram cosine similarity. Zero network access in this tier.
 */
export interface Reranker {
  /** Blend FTS ranks and n-gram cosine into one descending `score`. */
  rerank(query: string, hits: SearchResult[]): SearchResult[];
}

/**
 * Optional embeddings adapter seam (R3 future tier). Not implemented in
 * 0.1; declared so the search pipeline shape is already frozen.
 */
export interface EmbeddingAdapter {
  /** Embed text into a unit-norm vector; adapter owns dimensionality. */
  embed(text: string): Promise<number[]>;
}

// ---------------------------------------------------------------------------
// Plugin surface
// ---------------------------------------------------------------------------

/** Synchronous, deterministic count of a complete section; never additive.
 * Independent of retrieval's Tokenizer. Must return a nonnegative safe integer.
 */
export type TokenCounter = (text: string) => number;

/** Plugin config (schemastery-validated, fail-loud on invalid values). */
export interface Config {
  /** SQLite file for this deployment's memories, or `:memory:`. Required. */
  path: string;
  /** Default scope applied when a tool call omits scope ("" = global). */
  defaultScope: ScopeName;
  /** Opt-in output sequences broken with a zero-width space before prompt rendering. Default `[]`. */
  escapeSequences: readonly string[];
  /** Unpinned recent memories rendered in the recall section. */
  promptRecentCount: number;
  /** Character budget of the rendered section; pinned survive first. */
  promptMaxChars: number;
  /** Optional hard token cap in addition to promptMaxChars; absent = char-only. */
  promptMaxTokens?: number;
  /** Local supported Hugging Face tokenizer.json; required with promptMaxTokens. */
  promptTokenizerPath?: string;
  /** Maximum characters accepted for one memory. */
  maxTextChars: number;
  /** Default `limit` for `memory_search` when the model omits it. */
  searchLimitDefault: number;
  /** Hard cap on `memory_search` results. */
  searchLimitMax: number;
  /** Prompt-section order. */
  promptOrder: number;
  /** Jaccard similarity >= this marks a near-duplicate on write (R4). */
  dedupeThreshold: number;
  /** Cosine similarity >= this also marks a near-duplicate when provided. */
  dedupeCosineThreshold: number;
  /** lastConfirmedAt older than this many days marks the record stale (R5). */
  staleAfterDays: number;
}

/** The seven model-facing tools (§4). Semantics normative. */
export interface ToolSet {
  /** Legacy-compatible; returns dedupe hits when not forcing. */
  memory_write(args: {
    text: string;
    tags?: string[];
    pinned?: boolean;
    force?: boolean;
  }): { record: MemoryRecord; dedupeHits: DedupeHit[] };
  /** Legacy-compatible; ranked results. */
  memory_search(args: { query: string; limit?: number }): { results: SearchResult[] };
  /** Legacy-compatible delete. */
  memory_forget(args: { id: number }): { deleted: boolean };
  /** Revise text/tags/pinned in place. */
  memory_update(args: {
    id: number;
    text?: string;
    tags?: string[];
    pinned?: boolean;
  }): { record: MemoryRecord | undefined };
  /** Refresh lastConfirmedAt, clear stale; `id: "*"` refreshes all. */
  memory_confirm(args: { id: number | "*" }): { confirmed: number };
  /** Browse by scope/tag/stale/pinned. */
  memory_list(args: {
    scope?: string;
    tags?: string[];
    stale?: boolean;
    limit?: number;
  }): { records: MemoryRecord[] };
  /** Merge duplicates into a surviving record. */
  memory_merge(args: {
    targetId: number;
    sourceIds: number[];
    text?: string;
    tags?: string[];
  }): { record: MemoryRecord | undefined };
}
