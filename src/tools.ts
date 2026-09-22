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
  DedupeHit,
  MemoryRecord,
  MemoryStore,
  SearchResult,
  ToolSet,
} from "./contracts.js";
import type { ObjectValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import { visibleScopes } from "./scope.js";
import { normalizeTags } from "./tokenize.js";

/** Public projection of a record for tool output: never more than needed. */
function publicRecord(record: MemoryRecord) {
  return {
    id: record.id,
    text: record.text,
    tags: record.tags,
    scope: record.scope,
    pinned: record.pinned,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastConfirmedAt: record.lastConfirmedAt,
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
  };
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
): ToolSet {
  const operationScope = scopeContext?.activeScope ?? config.defaultScope;
  const readableScopes =
    scopeContext === undefined
      ? undefined
      : visibleScopes(operationScope, scopeContext.includeGlobal);

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
      return { deleted: store.forget(args.id, readableScopes) };
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
      const record = store.update(args.id, patch, readableScopes);
      return { record };
    },

    memory_confirm(args) {
      return { confirmed: store.confirm(args.id, readableScopes) };
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
      const input: {
        targetId: number;
        sourceIds: readonly number[];
        text?: string;
        tags?: readonly string[];
      } = { targetId: args.targetId, sourceIds: args.sourceIds };
      if (args.text !== undefined) input.text = args.text;
      if (args.tags !== undefined) input.tags = normalizeTagsList(args.tags);
      const record = store.merge(input, readableScopes);
      return { record };
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
export const memoryWriteOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
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
}

/** Projection of a dedupe hit in tool output. */
export interface HitProjection {
  id: number;
  text: string;
  tags: string;
  scope: string;
  similarity: number;
  measure: "jaccard" | "cosine";
}

/** Shape of `memory_write`'s execute() return; mirrors memoryWriteOutputSchema. */
export interface WriteToolOutput {
  written: boolean;
  record?: RecordProjection;
  dedupeHits: HitProjection[];
  hint?: string;
}

/** Serializers shared by the Cordis layer and the CLI's JSON output. */
export const serializers = {
  write(value: { record?: MemoryRecord; dedupeHits: DedupeHit[] }): WriteToolOutput {
    const hits = value.dedupeHits.map(publicHit);
    if (value.dedupeHits.length > 0) {
      // Blocked by dedupe: `record` echoes the closest existing entry (see
      // store.write), so it must not be reported as newly written.
      return {
        written: false,
        dedupeHits: hits,
        hint: "similar memories exist; call memory_merge or re-send with force: true",
      };
    }
    const output: WriteToolOutput = { written: true, dedupeHits: hits };
    if (value.record !== undefined) output.record = publicRecord(value.record);
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
