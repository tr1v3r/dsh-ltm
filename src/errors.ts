/**
 * Typed domain errors for memory mutations (issue #32 phase 1).
 *
 * The store throws these for CAS and shape failures so tools/CLI can convert
 * them into structured results instead of parsing message text. Messages are
 * metadata only: they never contain memory text, tags, scopes, or any other
 * record's state beyond the id/versions that identify the conflict.
 *
 * @module dsh-ltm/errors
 */

/** Machine-readable failure kinds. */
export type MemoryMutationErrorCode =
  | "MEMORY_INVALID_ARGUMENT"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_SCOPE_MISMATCH"
  | "MEMORY_REVISION_CONFLICT"
  | "MEMORY_REVISION_OVERFLOW";

/** Which model-facing operation failed. */
export type MemoryOperation =
  | "memory_update"
  | "memory_confirm"
  | "memory_forget"
  | "memory_merge";

/** Structured detail shared by the store error and tool/CLI outputs. */
export interface MemoryMutationErrorDetail {
  code: MemoryMutationErrorCode;
  operation: MemoryOperation;
  /** The record id the operation addressed, when known. */
  id?: number | undefined;
  /** The caller-supplied version, when the operation carried one. */
  expectedRevision?: number | undefined;
  /** The version actually visible for `id` (conflicts only, never leaks prose). */
  currentRevision?: number | undefined;
}

/**
 * A failed memory mutation with machine-readable detail.
 *
 * Non-domain failures (SQLite I/O, SQLITE_BUSY, unexpected shapes) are NOT
 * wrapped in this class; surfaces must not swallow them.
 */
export class MemoryMutationError extends Error {
  readonly detail: MemoryMutationErrorDetail;

  constructor(detail: MemoryMutationErrorDetail) {
    super(messageFor(detail));
    this.name = "MemoryMutationError";
    this.detail = detail;
  }
}

/** Metadata-only message; never embeds record content. */
function messageFor(detail: MemoryMutationErrorDetail): string {
  const at = detail.id === undefined ? "" : ` for #${detail.id}`;
  switch (detail.code) {
    case "MEMORY_INVALID_ARGUMENT":
      return `${detail.operation}${at}: invalid argument`;
    case "MEMORY_NOT_FOUND":
      // Deliberately does not distinguish missing, deleted, and out-of-scope,
      // and never discloses the visible revision.
      return `${detail.operation}${at}: no such memory`;
    case "MEMORY_SCOPE_MISMATCH":
      return `${detail.operation}${at}: cannot merge memories from different scopes`;
    case "MEMORY_REVISION_CONFLICT":
      return `${detail.operation}${at}: revision conflict (expected ${String(
        detail.expectedRevision,
      )}, current ${String(detail.currentRevision)}); re-read the record and retry with its current revision`;
    case "MEMORY_REVISION_OVERFLOW":
      return `${detail.operation}${at}: revision reached the maximum safe integer and can no longer be incremented`;
  }
}

/** Upper bound of the persisted revision: Number.MAX_SAFE_INTEGER. */
export const MEMORY_REVISION_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Validate a caller-supplied revision. Accepts only positive safe integers;
 * `null`, strings, 0, negatives, fractions, NaN, Infinity and out-of-range
 * values are rejected (never silently treated as "not provided").
 */
export function isValidRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Validate a caller-supplied record id (positive safe integer), as used by
 * `expectedSourceRevisions` entries.
 */
export function isValidRecordId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
