/**
 * Cordis entry (P1' surface): open the store, register the seven tools, and
 * contribute the recall prompt section. The store is closed in an effect
 * disposer, so plugin disposal never leaks the SQLite connection.
 *
 * @module dsh-ltm
 */

import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { loadConfig } from "./config.js";
import { MemoryStore } from "./store.js";
import {
  createToolSet,
  budgetFeedbackOutputProperties,
  renderBudgetFeedback,
  memoryRecordOutputSchema,
  memorySearchResultOutputSchema,
  memoryWriteOutputSchema,
  serializers,
  type WriteToolOutput,
} from "./tools.js";
import { promptLine, renderPrompt } from "./prompt.js";
import { loadTokenCounter } from "./token-counter.js";
export { loadTokenCounter } from "./token-counter.js";
export type { TokenCounter, PromptRenderResult, PromptBudgetReport, BudgetFeedback } from "./contracts.js";
export { renderPromptResult, promptBudgetReport } from "./prompt.js";
import {
  cwdFromAgentScope,
  resolveProjectScope,
  visibleScopes,
} from "./scope.js";

export const name = "ltm";
export const inject = ["tools", "systemPrompt"];
export { Config } from "./config.js";

const WRITE_DESCRIPTION =
  "Remember one durable fact across sessions: a user preference, a project convention, a decision and its reason, or a hard-won detail about this codebase. Write one self-contained fact per call — it will be read back with no surrounding conversation. Do NOT store transient task state (use the todo list), secrets, or anything the repository already records. Before writing changed state, search for the existing fact if its id is not already known, then update that id. Search is guidance, not a required gate. Near-duplicate similarity is not a contradiction verdict: merge equivalent facts, update superseded facts, and do not force-write changed state alongside the old fact.";
const SEARCH_DESCRIPTION =
  "Search global and current-project memories by keyword (CJK-aware tokenization, hybrid rerank). Pinned and recent memories already appear in your context, so search when you need something older or more specific than what you can already see.";
const FORGET_DESCRIPTION =
  "Delete one visible global/current-project memory by id, for a fact that is now wrong or obsolete. Ids come from memory_search or memory_write.";
const UPDATE_DESCRIPTION =
  "Revise a visible global/current-project memory's text/tags/pinned in place, keeping its id. Prefer this for changed state over writing another record or delete-and-rewrite. If the id is unknown, search first; a known id can be updated directly without a mandatory search.";
const CONFIRM_DESCRIPTION =
  'Confirm one visible memory is still accurate (refreshes its review timestamp, clears the stale flag). Pass id: "*" to confirm all global/current-project memories.';
const LIST_DESCRIPTION =
  "Explicitly browse memories across projects, filtered by scope, tags (AND semantics), staleness, or pinned state.";
const MERGE_DESCRIPTION =
  "Merge near-duplicate memories from one visible scope into one surviving record: sources are absorbed into the target and deleted; tags default to the union of all merged records.";

/**
 * Open the store, register the tools, contribute the section.
 *
 * @param ctx - plugin context; the store, tools, and section are disposed with it.
 * @param rawConfig - config value from the patch tree (validated here, fail-loud).
 */
export function apply(ctx: Context, rawConfig: unknown) {
  const config = loadConfig(rawConfig);
  // Fail before opening SQLite or registering any effects/tools. Default mode
  // never resolves/imports the optional tokenizer dependency.
  const tokenCounter = config.promptTokenizerPath === undefined
    ? undefined : loadTokenCounter(config.promptTokenizerPath);
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

  const storeProxy = new Proxy({} as MemoryStore, {
    get(_target, prop, receiver) {
      const target = open() as unknown as Record<string | symbol, unknown>;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  function activeScope(scope: object | undefined): string {
    if (!config.autoProjectScope) return config.defaultScope;
    return resolveProjectScope(
      cwdFromAgentScope(scope),
      config.defaultScope,
    ).scope;
  }

  function toolsFor(exec: ToolRunContext | undefined) {
    return createToolSet(storeProxy, config, {
      activeScope: activeScope(exec?.agent),
      includeGlobal: config.autoProjectScope,
    }, tokenCounter);
  }

  ctx.systemPrompt.section({
    name: "ltm:recall",
    order: config.promptOrder,
    // Assembly scope is the current agent, so concurrent Web sessions do not
    // share the process cwd or leak pinned/recent memories across projects.
    // Always read through the fiber-scoped store, never a captured handle.
    text: (assembly) => {
      const scope = activeScope(assembly?.scope);
      const scopes = visibleScopes(scope, config.autoProjectScope);
      return renderPrompt(
        open().forPrompt(config.promptRecentCount, scopes),
        config,
        tokenCounter,
      );
    },
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
                ? `Stored memory #${value.record.id}${value.record.pinned ? " (pinned)" : ""}.${renderBudgetFeedback(value)}`
                : `Not stored — ${value.dedupeHits.length} near-duplicate(s) found. ${value.hint ?? "Review existing facts before retrying."}`,
          },
        ],
      },
      presentCall: (args) => ({
        card: "generic",
        title: "memory_write",
        kind: "edit",
        rawInput: args,
      }),
      async execute(args, exec) {
        return serializers.write(toolsFor(exec).memory_write(args));
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
              items: memorySearchResultOutputSchema,
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
                      promptLine(hit, config.escapeSequences, config.staleAfterDays),
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
      async execute(args, exec) {
        return serializers.search(toolsFor(exec).memory_search(args));
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
      async execute(args, exec) {
        const { deleted } = toolsFor(exec).memory_forget(args);
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
            ...budgetFeedbackOutputProperties,
            updated: { type: "boolean", required: true },
            id: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.updated
              ? `Updated memory #${value.id}.${renderBudgetFeedback(value)}`
              : `No memory #${value.id} to update.`,
          },
        ],
      },
      async execute(args, exec) {
        const { record, ...feedback } = toolsFor(exec).memory_update(args);
        return { updated: record !== undefined, id: args.id, ...feedback };
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
      async execute(args, exec) {
        const id = args.id === "*" ? "*" : Number(args.id);
        if (id !== "*" && !Number.isInteger(id)) {
          throw new Error('memory_confirm: `id` must be an integer or "*"');
        }
        return toolsFor(exec).memory_confirm({ id });
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
              items: memoryRecordOutputSchema,
            },
          },
        },
        render: (
          _args,
          value: { records: NonNullable<ReturnType<typeof serializers.record>>[] },
        ) => [
          {
            type: "text",
            text:
              value.records.length === 0
                ? "No memories match the filter."
                : value.records
                    .map((record) =>
                      promptLine(record, config.escapeSequences, config.staleAfterDays),
                    )
                    .join("\n"),
          },
        ],
      },
      async execute(args, exec) {
        const { records } = toolsFor(exec).memory_list(args);
        return {
          records: records.map((record) => serializers.record(record)!),
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
      async execute(args, exec) {
        const { record } = toolsFor(exec).memory_merge(args);
        return { merged: record !== undefined, targetId: args.targetId };
      },
    }),
  );
}
