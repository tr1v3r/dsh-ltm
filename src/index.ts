/**
 * Cordis entry (P1' surface): open the store, register the seven tools, and
 * contribute the recall prompt section. The store is closed in an effect
 * disposer, so plugin disposal never leaks the SQLite connection.
 *
 * @module dsh-ltm
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { loadConfig } from "./config.js";
import { MemoryStore } from "./store.js";
import {
  createToolSet,
  memoryWriteOutputSchema,
  serializers,
  type WriteToolOutput,
} from "./tools.js";
import { promptLine, renderPrompt } from "./prompt.js";

export const name = "ltm";
export const inject = ["tools", "systemPrompt"];
export { Config } from "./config.js";

const WRITE_DESCRIPTION =
  "Remember one durable fact across sessions: a user preference, a project convention, a decision and its reason, or a hard-won detail about this codebase. Write one self-contained fact per call — it will be read back with no surrounding conversation. Do NOT store transient task state (use the todo list), secrets, or anything the repository already records. Near-duplicates are detected on write; if similar memories come back, merge them or re-send with force: true.";
const SEARCH_DESCRIPTION =
  "Search stored memories by keyword (CJK-aware tokenization, hybrid rerank). Pinned and recent memories already appear in your context, so search when you need something older or more specific than what you can already see.";
const FORGET_DESCRIPTION =
  "Delete one stored memory by id, for a fact that is now wrong or obsolete. Ids come from memory_search or memory_write.";
const UPDATE_DESCRIPTION =
  "Revise an existing memory's text/tags/pinned in place, keeping its id. Prefer this over delete-and-rewrite so id references in the conversation stay valid.";
const CONFIRM_DESCRIPTION =
  'Confirm one memory is still accurate (refreshes its review timestamp, clears the stale flag). Pass id: "*" to confirm every stored memory.';
const LIST_DESCRIPTION =
  "Browse stored memories filtered by scope, tags (AND semantics), staleness, or pinned state.";
const MERGE_DESCRIPTION =
  "Merge near-duplicate memories into one surviving record: sources are absorbed into the target and deleted; tags default to the union of all merged records.";

/**
 * Open the store, register the tools, contribute the section.
 *
 * @param ctx - plugin context; the store, tools, and section are disposed with it.
 * @param rawConfig - config value from the patch tree (validated here, fail-loud).
 */
export function apply(ctx: Context, rawConfig: unknown) {
  const config = loadConfig(rawConfig);
  let store: MemoryStore | undefined;
  ctx.effect(() => {
    store = new MemoryStore(config.path, {
      staleAfterDays: config.staleAfterDays,
      dedupeThreshold: config.dedupeThreshold,
      dedupeCosineThreshold: config.dedupeCosineThreshold,
      maxTextChars: config.maxTextChars,
      searchLimitMax: config.searchLimitMax,
    });
    return () => {
      store?.close();
      store = undefined;
    };
  });

  /**
   * The open store, or a loud failure. Reached only while the fiber is
   * active, so an absent store is a lifecycle bug rather than an expected
   * state.
   */
  function open(): MemoryStore {
    if (!store) throw new Error("ltm: store is not open");
    return store;
  }

  const tools = createToolSet(
    new Proxy({} as MemoryStore, {
      get(_target, prop, receiver) {
        const target = open() as unknown as Record<string | symbol, unknown>;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    config,
  );

  ctx.systemPrompt.section({
    name: "ltm:recall",
    order: config.promptOrder,
    // Always read through the fiber-scoped store, never a captured handle.
    text: () => renderPrompt(open().forPrompt(config.promptRecentCount), config),
  });

  ctx.tools.register(
    defineTool({
      name: "memory_write",
      description: WRITE_DESCRIPTION,
      parameters: {
        text: {
          type: "string",
          required: true,
          description: "The self-contained fact to remember.",
        },
        tags: {
          type: "array",
          description:
            'Optional labels for later retrieval, e.g. ["preference", "build"].',
          items: { type: "string" },
        },
        pinned: {
          type: "boolean",
          description:
            "Always show this memory in context. Reserve it for facts that matter in every session.",
        },
        force: {
          type: "boolean",
          description:
            "Skip the near-duplicate check and store anyway. Only after reviewing the reported dedupeHits.",
        },
      },
      output: {
        schema: memoryWriteOutputSchema,
        render: (_args, value: WriteToolOutput) => [
          {
            type: "text",
            text:
              value.written && value.record
                ? `Stored memory #${value.record.id}${value.record.pinned ? " (pinned)" : ""}.`
                : `Not stored — ${value.dedupeHits.length} near-duplicate(s) found; merge them or re-send with force: true.`,
          },
        ],
      },
      presentCall: (args) => ({
        card: "generic",
        title: "memory_write",
        kind: "edit",
        rawInput: args,
      }),
      async execute(args) {
        const { record, dedupeHits } = tools.memory_write(args);
        return serializers.write({ record, dedupeHits });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "memory_search",
      description: SEARCH_DESCRIPTION,
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "Keywords to look for in memory text and tags.",
        },
        limit: {
          type: "number",
          description: `Maximum results. Defaults to ${config.searchLimitDefault}, capped at ${config.searchLimitMax}.`,
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            results: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "integer", required: true },
                  text: { type: "string", required: true },
                  tags: { type: "string", required: true },
                  pinned: { type: "boolean", required: true },
                },
              },
            },
          },
        },
        render: (args, value: ReturnType<typeof serializers.search>) => [
          {
            type: "text",
            text:
              value.results.length === 0
                ? `No memories match ${JSON.stringify(args.query)}.`
                : value.results
                    .map((hit) =>
                      promptLine(
                        {
                          ...hit,
                          scope: "",
                          createdAt: 0,
                          updatedAt: 0,
                          lastConfirmedAt: 0,
                        },
                        config.escapeSequences,
                        config.staleAfterDays,
                      ),
                    )
                    .join("\n"),
          },
        ],
        presentationMeta: (_args, value: ReturnType<typeof serializers.search>) => ({
          count: value.results.length,
        }),
      },
      presentCall: (args) => ({
        card: "generic",
        title: `memory_search ${args.query}`,
        kind: "search",
      }),
      async execute(args) {
        return serializers.search(tools.memory_search(args));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "memory_forget",
      description: FORGET_DESCRIPTION,
      parameters: {
        id: {
          type: "integer",
          required: true,
          description: "The memory id to delete.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "integer", required: true },
            deleted: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.deleted
              ? `Forgot memory #${value.id}.`
              : `No memory #${value.id} to forget.`,
          },
        ],
      },
      async execute(args) {
        const { deleted } = tools.memory_forget(args);
        return { id: args.id, deleted };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "memory_update",
      description: UPDATE_DESCRIPTION,
      parameters: {
        id: { type: "integer", required: true, description: "The memory id." },
        text: { type: "string", description: "Replacement text." },
        tags: {
          type: "array",
          description: "Replacement tag list.",
          items: { type: "string" },
        },
        pinned: { type: "boolean", description: "New pinned flag." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            updated: { type: "boolean", required: true },
            id: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.updated
              ? `Updated memory #${value.id}.`
              : `No memory #${value.id} to update.`,
          },
        ],
      },
      async execute(args) {
        const { record } = tools.memory_update(args);
        return { updated: record !== undefined, id: args.id };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "memory_confirm",
      description: CONFIRM_DESCRIPTION,
      parameters: {
        id: {
          type: "string",
          required: true,
          description: 'The memory id, or "*" to confirm all.',
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            confirmed: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `Confirmed ${value.confirmed} memory(ies).` },
        ],
      },
      async execute(args) {
        const id = args.id === "*" ? "*" : Number(args.id);
        if (id !== "*" && !Number.isInteger(id)) {
          throw new Error('memory_confirm: `id` must be an integer or "*"');
        }
        return tools.memory_confirm({ id });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "memory_list",
      description: LIST_DESCRIPTION,
      parameters: {
        scope: { type: "string", description: "Filter by scope bucket." },
        tags: {
          type: "array",
          description: "Records must carry every listed tag (AND).",
          items: { type: "string" },
        },
        stale: {
          type: "boolean",
          description: "Only stale (true) or only fresh (false) records.",
        },
        limit: { type: "number", description: "Maximum records to return." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            records: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "integer", required: true },
                  text: { type: "string", required: true },
                  tags: { type: "string", required: true },
                  pinned: { type: "boolean", required: true },
                },
              },
            },
          },
        },
        render: (_args, value: ReturnType<typeof serializers.record> extends
          infer _R
          ? { records: { id: number; text: string; pinned?: boolean; tags?: string }[] }
          : never) => [
          {
            type: "text",
            text:
              value.records.length === 0
                ? "No memories match the filter."
                : value.records
                    .map((record) =>
                      promptLine(
                        {
                          ...record,
                          tags: record.tags ?? "",
                          pinned: record.pinned ?? false,
                          scope: "",
                          createdAt: 0,
                          updatedAt: 0,
                          lastConfirmedAt: 0,
                        },
                        config.escapeSequences,
                        config.staleAfterDays,
                      ),
                    )
                    .join("\n"),
          },
        ],
      },
      async execute(args) {
        const { records } = tools.memory_list(args);
        return {
          records: records.map((record) => ({
            id: record.id,
            text: record.text,
            tags: record.tags,
            pinned: record.pinned,
          })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "memory_merge",
      description: MERGE_DESCRIPTION,
      parameters: {
        targetId: {
          type: "integer",
          required: true,
          description: "Surviving record id.",
        },
        sourceIds: {
          type: "array",
          required: true,
          description: "Ids absorbed into the target and then deleted.",
          items: { type: "integer" },
        },
        text: { type: "string", description: "Replacement text for the target." },
        tags: {
          type: "array",
          description: "Replacement tags; defaults to the union of all records.",
          items: { type: "string" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            merged: { type: "boolean", required: true },
            targetId: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.merged
              ? `Merged into memory #${value.targetId}.`
              : `Merge failed — no memory #${value.targetId}.`,
          },
        ],
      },
      async execute(args) {
        const { record } = tools.memory_merge(args);
        return { merged: record !== undefined, targetId: args.targetId };
      },
    }),
  );
}
