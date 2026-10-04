/**
 * Model-facing tool logic (P1' surface).
 *
 * Pure {@link ToolSet} implementations bound to a store and config; the
 * Cordis layer (`index.ts`) and the CLI (`cli.ts`) both call into these so
 * validation, clamping, and dedupe-on-write semantics exist exactly once.
 *
 * Compatibility (contracts §compat): `memory_write` / `memory_search` /
 * `memory_forget` keep the legacy parameter shapes; new tools
 * (`memory_update` / `memory_confirm` / `memory_list` / `memory_merge`)
 * extend the set (§4).
 *
 * @module dsh-ltm/tools
 */

import type {
  Config,
  BudgetFeedback,
  MemoryToolError,
  TokenCounter,
  DedupeHit,
  MemoryRecord,
  MemoryStore,
  MergeInput,
  MutationOptions,
  SearchResult,
  ToolSet,
} from "./contracts.js";
import { MemoryMutationError, isValidRevision } from "./errors.js";
import type { ObjectValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import { promptBudgetReport } from "./prompt.js";
import { validateTokenBudget } from "./token-counter.js";
import { visibleScopes } from "./scope.js";
import { normalizeTags } from "./tokenize.js";

/** Public projection of a record for tool output: never more than needed. */
function publicRecord(record: MemoryRecord) {
  // Every store read/write carries a real revision; a record without one is
  // never silently reported as any default — that would fake CAS tokens.
  if (!isValidRevision(record.revision)) {
    throw new Error("memory serializer: record carries no usable revision");
  }
  return {
    id: record.id,
    text: record.text,
    tags: record.tags,
    scope: record.scope,
    pinned: record.pinned,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastConfirmedAt: record.lastConfirmedAt,
    revision: record.revision,
  };
}

/** Public projection of a dedupe hit. */
function publicHit(hit: DedupeHit) {
  return {
    id: hit.record.id,
    text: hit.record.text,
    tags: hit.record.tags,
    scope: hit.record.scope,
    similarity: hit.similarity,
    measure: hit.measure,
    revision: publicRecord(hit.record).revision,
  };
}

/**
 * Structured detail for a typed domain error, or `undefined` for anything
 * else (I/O, SQLite, unexpected shapes) which must keep propagating.
 * Rebuilt field-by-field so no explicit-`undefined` properties leak into
 * schema-validated tool output.
 */
function mutationErrorDetail(error: unknown): MemoryToolError | undefined {
  if (!(error instanceof MemoryMutationError)) return undefined;
  const detail: MemoryToolError = { code: error.detail.code, operation: error.detail.operation };
  if (error.detail.id !== undefined) detail.id = error.detail.id;
  if (error.detail.expectedRevision !== undefined) detail.expectedRevision = error.detail.expectedRevision;
  if (error.detail.currentRevision !== undefined) detail.currentRevision = error.detail.currentRevision;
  return detail;
}

/** Build store CAS options without downgrading present-but-malformed values. */
function casOptions(args: { expectedRevision?: number }): MutationOptions | undefined {
  return args.expectedRevision === undefined ? undefined : { expectedRevision: args.expectedRevision };
}

/**
 * Build the seven-tool set over one store.
 *
 * @param store - the live memory store (owns its own thresholds).
 * @param config - validated plugin config.
 * @param scopeContext - agent-local visibility. Omit for CLI/legacy operation.
 * @returns the {@link ToolSet} implementation.
 */
export interface ToolScopeContext {
  activeScope: string;
  includeGlobal: boolean;
}

export function createToolSet(
  store: MemoryStore,
  config: Config,
  scopeContext?: ToolScopeContext,
  tokenCounter?: TokenCounter,
): ToolSet {
  validateTokenBudget(config.promptMaxTokens, tokenCounter);
  const operationScope = scopeContext?.activeScope ?? config.defaultScope;
  const readableScopes =
    scopeContext === undefined
      ? undefined
      : visibleScopes(operationScope, scopeContext.includeGlobal);

  function feedback(): BudgetFeedback {
    try {
      const scopes = readableScopes ?? visibleScopes(operationScope, config.autoProjectScope);
      return { budget: promptBudgetReport(store.forPrompt(config.promptRecentCount, scopes), config, tokenCounter) };
    } catch {
      // Persistence already succeeded. Never suggest a retry or leak memory text from errors.
      return { budgetWarning: "Memory saved; recall budget feedback unavailable." };
    }
  }

  function requireText(text: string, op = "memory_write"): string {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error(`${op}: \`text\` must not be blank`);
    }
    if (trimmed.length > config.maxTextChars) {
      throw new Error(
        `${op}: \`text\` is ${trimmed.length} chars, over the ${config.maxTextChars} limit`,
      );
    }
    return trimmed;
  }

  function clampLimit(limit: number | undefined, tool = "memory_search"): number {
    const requested = limit ?? config.searchLimitDefault;
    if (!Number.isInteger(requested) || requested < 1) {
      throw new Error(
        `${tool}: \`limit\` must be an integer >= 1 (got ${requested})`,
      );
    }
    return Math.min(requested, config.searchLimitMax);
  }

  return {
    memory_write(args) {
      const text = requireText(args.text);
      const { record, dedupeHits } = store.write(text, args.tags ?? [], {
        scope: operationScope,
        pinned: args.pinned ?? false,
        force: args.force ?? false,
      });
      return {
        record: record as MemoryRecord,
        dedupeHits,
        ...(dedupeHits.length === 0 && record.pinned ? feedback() : {}),
      };
    },

    memory_search(args) {
      const results = store.search(
        args.query,
        clampLimit(args.limit),
        readableScopes ?? (config.defaultScope || undefined),
      );
      return { results };
    },

    memory_forget(args) {
      try {
        return store.forgetVersioned(args.id, readableScopes, casOptions(args));
      } catch (error) {
        const detail = mutationErrorDetail(error);
        if (detail !== undefined) return { deleted: false, error: detail };
        throw error;
      }
    },

    memory_update(args) {
      const patch: {
        text?: string;
        tags?: readonly string[];
        pinned?: boolean;
      } = {};
      if (args.text !== undefined) patch.text = requireText(args.text, "memory_update");
      if (args.tags !== undefined) patch.tags = normalizeTagsList(args.tags);
      if (args.pinned !== undefined) patch.pinned = args.pinned;
      let record: MemoryRecord | undefined;
      try {
        record = store.update(args.id, patch, readableScopes, casOptions(args));
      } catch (error) {
        const detail = mutationErrorDetail(error);
        if (detail !== undefined) return { record: undefined, error: detail };
        throw error;
      }
      return { record, ...(record !== undefined && (record.pinned || args.pinned === false) && Object.keys(patch).length > 0 ? feedback() : {}) };
    },

    memory_confirm(args) {
      try {
        return store.confirmVersioned(args.id, readableScopes, casOptions(args));
      } catch (error) {
        const detail = mutationErrorDetail(error);
        if (detail !== undefined) return { confirmed: 0, error: detail };
        throw error;
      }
    },

    memory_list(args) {
      const filter: {
        scope?: string;
        tags?: readonly string[];
        stale?: boolean;
        limit?: number;
      } = {};
      if (args.scope !== undefined) filter.scope = args.scope;
      if (args.tags !== undefined) filter.tags = args.tags;
      if (args.stale !== undefined) filter.stale = args.stale;
      // No `limit` means "every record" (R6): only clamp when one was given,
      // otherwise memory_list would silently truncate to the search default.
      if (args.limit !== undefined) filter.limit = clampLimit(args.limit, "memory_list");
      const records = store.list(filter);
      return { records };
    },

    memory_merge(args) {
      const input: MergeInput = { targetId: args.targetId, sourceIds: args.sourceIds };
      if (args.text !== undefined) input.text = args.text;
      if (args.tags !== undefined) input.tags = normalizeTagsList(args.tags);
      // Present-but-malformed CAS fields must survive forwarding (never
      // truthiness-filtered); the store rejects them loudly.
      if (args.expectedRevision !== undefined) input.expectedRevision = args.expectedRevision;
      if (args.expectedSourceRevisions !== undefined) {
        input.expectedSourceRevisions = args.expectedSourceRevisions;
      }
      try {
        const record = store.merge(input, readableScopes);
        return record === undefined ? { record: undefined } : { record };
      } catch (error) {
        const detail = mutationErrorDetail(error);
        if (detail !== undefined) return { record: undefined, error: detail };
        throw error;
      }
    },
  };
}

/** Normalize a model-supplied tag array through the engine's normalizer. */
function normalizeTagsList(tags: readonly string[]): string[] {
  return normalizeTags(tags).split(" ").filter((tag) => tag.length > 0);
}

/**
 * JSON Schema of the full public record projection ({@link publicRecord}).
 * Shared by every tool that returns records so the registered output schema
 * always matches the fields actually serialized (previously `memory_search`
 * and `memory_list` declared only 4 of the 9 fields their execute() returned).
 */
export const memoryRecordOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "integer", required: true },
    text: { type: "string", required: true },
    tags: { type: "string", required: true },
    scope: { type: "string", required: true },
    pinned: { type: "boolean", required: true },
    createdAt: { type: "integer", required: true },
    updatedAt: { type: "integer", required: true },
    lastConfirmedAt: { type: "integer", required: true },
    revision: { type: "integer", required: true },
  },
} satisfies ObjectValueSchemaSpec;

/** JSON Schema of a search hit: the full record plus its relevance score. */
export const memorySearchResultOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...memoryRecordOutputSchema.properties,
    score: { type: "number", required: true },
  },
} satisfies ObjectValueSchemaSpec;

/**
 * JSON Schema of `memory_write`'s execute() return value (the shape
 * {@link serializers.write} produces). Declared here so tests can validate
 * actual outputs against the exact schema the Cordis layer registers.
 */
export const budgetFeedbackOutputProperties = {
  budget: {
    type: "object", additionalProperties: false,
    properties: {
      selectedIds: { type: "array", items: { type: "integer" }, required: true },
      truncatedIds: { type: "array", items: { type: "integer" }, required: true },
      omittedIds: { type: "array", items: { type: "integer" }, required: true },
      chars: { type: "integer", required: true }, maxChars: { type: "integer", required: true },
      tokens: { type: "integer" }, maxTokens: { type: "integer" },
      pinnedCount: { type: "integer", required: true }, selectedPinnedCount: { type: "integer", required: true },
      omittedPinnedIds: { type: "array", items: { type: "integer" }, required: true },
      truncatedPinnedIds: { type: "array", items: { type: "integer" }, required: true },
    },
  },
  budgetWarning: { type: "string" },
} satisfies ObjectValueSchemaSpec["properties"];

/** Human-visible advisory; omitted/truncated pinned records need deliberate review. */
export function renderBudgetFeedback(value: BudgetFeedback): string {
  if (value.budgetWarning) return ` ${value.budgetWarning}`;
  const b = value.budget;
  if (!b) return "";
  return ` Recall budget: ${b.chars}/${b.maxChars} chars${b.tokens === undefined ? "" : `, ${b.tokens}/${b.maxTokens} tokens`}; pinned ${b.selectedPinnedCount}/${b.pinnedCount} selected, ${b.truncatedPinnedIds.length} truncated, ${b.omittedPinnedIds.length} omitted.`;
}

/** JSON Schema of the structured domain-error field on tool failures. */
export const memoryToolErrorOutputProperties = {
  error: {
    type: "object",
    additionalProperties: false,
    properties: {
      code: { type: "string", required: true },
      operation: { type: "string", required: true },
      id: { type: "integer" },
      expectedRevision: { type: "integer" },
      currentRevision: { type: "integer" },
    },
  },
} satisfies ObjectValueSchemaSpec["properties"];

/**
 * Structured detail as it appears in tool output (schema-inferred types:
 * `code`/`operation` are plain strings there, not literal unions).
 */
export interface RenderedToolError {
  code: string;
  operation: string;
  id?: number | undefined;
  expectedRevision?: number | undefined;
  currentRevision?: number | undefined;
}

/** Human-visible rendering of a structured failure; metadata only. */
export function renderToolError(value: RenderedToolError): string {
  switch (value.code) {
    case "MEMORY_REVISION_CONFLICT":
      return `revision conflict (expected ${String(value.expectedRevision)}, current ${String(
        value.currentRevision,
      )}) — re-read the memory${value.id === undefined ? "" : ` #${value.id}`} and retry with its current revision`;
    case "MEMORY_NOT_FOUND":
      return `no such memory${value.id === undefined ? "" : ` #${value.id}`} (unknown, deleted, or outside the active project)`;
    case "MEMORY_INVALID_ARGUMENT":
      return `invalid revision argument${value.id === undefined ? "" : ` for #${value.id}`}`;
    case "MEMORY_SCOPE_MISMATCH":
      return "cannot merge memories from different scopes";
    case "MEMORY_REVISION_OVERFLOW":
      return `memory${value.id === undefined ? "" : ` #${value.id}`} reached the maximum safe revision and can no longer be changed`;
  }
  return `failed (${value.code})`;
}

/** Registered `memory_forget` output: legacy shape plus CAS outcome fields. */
export const memoryForgetOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...memoryToolErrorOutputProperties,
    id: { type: "integer", required: true },
    deleted: { type: "boolean", required: true },
    deletedRevision: { type: "integer" },
  },
} satisfies ObjectValueSchemaSpec;

/** Registered `memory_update` output: legacy shape plus the write's revision. */
export const memoryUpdateOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...budgetFeedbackOutputProperties,
    ...memoryToolErrorOutputProperties,
    updated: { type: "boolean", required: true },
    id: { type: "integer", required: true },
    revision: { type: "integer" },
  },
} satisfies ObjectValueSchemaSpec;

/** Registered `memory_confirm` output: count plus single-id revision. */
export const memoryConfirmOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...memoryToolErrorOutputProperties,
    confirmed: { type: "integer", required: true },
    revision: { type: "integer" },
  },
} satisfies ObjectValueSchemaSpec;

/** Registered `memory_merge` output: legacy shape plus the target revision. */
export const memoryMergeOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...memoryToolErrorOutputProperties,
    merged: { type: "boolean", required: true },
    targetId: { type: "integer", required: true },
    revision: { type: "integer" },
  },
} satisfies ObjectValueSchemaSpec;

export const memoryWriteOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...budgetFeedbackOutputProperties,
    written: { type: "boolean", required: true },
    record: memoryRecordOutputSchema,
    dedupeHits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer", required: true },
          text: { type: "string", required: true },
          tags: { type: "string", required: true },
          scope: { type: "string", required: true },
          similarity: { type: "number", required: true },
          measure: { type: "string", required: true },
          revision: { type: "integer", required: true },
        },
      },
    },
    hint: { type: "string" },
  },
} satisfies ObjectValueSchemaSpec;

/** Serializers shared by the Cordis layer and the CLI's JSON output. */
/** Projection of a record in tool output. */
export interface RecordProjection {
  id: number;
  text: string;
  tags: string;
  scope: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  lastConfirmedAt: number;
  revision: number;
}

/** Projection of a dedupe hit in tool output. */
export interface HitProjection {
  id: number;
  text: string;
  tags: string;
  scope: string;
  similarity: number;
  measure: "jaccard" | "cosine";
  revision: number;
}

/** Shape of `memory_write`'s execute() return; mirrors memoryWriteOutputSchema. */
export interface WriteToolOutput extends BudgetFeedback {
  written: boolean;
  record?: RecordProjection;
  dedupeHits: HitProjection[];
  hint?: string;
}

/** Serializers shared by the Cordis layer and the CLI's JSON output. */
export const serializers = {
  write(value: { record?: MemoryRecord; dedupeHits: DedupeHit[] } & BudgetFeedback): WriteToolOutput {
    const hits = value.dedupeHits.map(publicHit);
    if (value.dedupeHits.length > 0) {
      // Blocked by dedupe: `record` echoes the closest existing entry (see
      // store.write), so it must not be reported as newly written.
      return {
        written: false,
        dedupeHits: hits,
        hint: "Similar memories exist; similarity is not a contradiction verdict. Review the hits: update the existing id for changed state, merge only equivalent facts. Do not force-write changed state alongside the old fact.",
      };
    }
    const output: WriteToolOutput = { written: true, dedupeHits: hits };
    if (value.record !== undefined) output.record = publicRecord(value.record);
    if (value.budget !== undefined) output.budget = value.budget;
    if (value.budgetWarning !== undefined) output.budgetWarning = value.budgetWarning;
    return output;
  },
  search(value: { results: SearchResult[] }) {
    return {
      results: value.results.map((hit) => ({
        ...publicRecord(hit),
        score: hit.score,
      })),
    };
  },
  record(record: MemoryRecord | undefined) {
    return record === undefined ? undefined : publicRecord(record);
  },
};
