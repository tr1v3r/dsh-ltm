/**
 * Plugin configuration (P1' surface).
 *
 * Schemastery schema plus fail-loud validation: any unusable value throws at
 * load time (R9, constraints §4.6) instead of surfacing at the first tool
 * call. Field semantics are frozen in {@link ./contracts.ts} (`Config`).
 *
 * @module dsh-ltm/config
 */

import z from "@deepseek-ai/schemastery";
import type { Config as LtmConfig } from "./contracts.js";

/** Zero-width space used to break explicitly configured output sequences. */
export const ZERO_WIDTH_SPACE = "\u200b";

/**
 * Insert a zero-width space after the first character of `sequence`, breaking
 * the sequence without changing what a human reads.
 *
 * @param sequence - a raw sequence explicitly configured by the operator.
 * @returns the escaped form.
 */
function escapeSequence(sequence: string): string {
  return sequence[0] + ZERO_WIDTH_SPACE + sequence.slice(1);
}

/**
 * Break every explicitly configured `escapeSequences` occurrence in `text`.
 *
 * This optional output transform is idempotent. An empty sequence list—the
 * default—preserves stored memory text exactly. Deployments that pass rendered
 * prompts through another parser may opt in to breaking its delimiters.
 *
 * @param text - memory text as stored.
 * @param escapeSequences - output sequences to break up.
 * @returns the text to render into a prompt.
 */
export function escapeForPrompt(
  text: string,
  escapeSequences: readonly string[],
): string {
  let out = text;
  for (const sequence of escapeSequences) {
    if (sequence.length < 2 || sequence.includes(ZERO_WIDTH_SPACE)) continue;
    const escaped = escapeSequence(sequence);
    // `replaceAll` consumes non-overlapping matches left-to-right, so a cluster
    // of an odd number of the lead character (e.g. "{{{" or "{{{ .x }}}") leaves
    // a trailing raw pair. Repeat until no configured raw occurrence remains.
    // Each pass only inserts zero-width spaces (which can never form a new raw
    // sequence), so the raw-match count strictly
    // decreases: the loop terminates and stays idempotent on already-escaped text.
    while (out.includes(sequence)) {
      out = out.replaceAll(sequence, escaped);
    }
  }
  return out;
}

/**
 * Schemastery schema for the plugin entry config. `path` has no default on
 * purpose: a durable store of user facts must not land in whatever directory
 * the harness happened to start in.
 */
const ConfigSchema = z.object({
  path: z.string().required(),
  defaultScope: z.string().default(""),
  escapeSequences: z.array(z.string()).default([]),
  promptRecentCount: z.number().default(10),
  promptMaxChars: z.number().default(2000),
  maxTextChars: z.number().default(2000),
  searchLimitDefault: z.number().default(10),
  searchLimitMax: z.number().default(50),
  promptOrder: z.number().default(50),
  dedupeThreshold: z.number().default(0.8),
  dedupeCosineThreshold: z.number().default(0.92),
  staleAfterDays: z.number().default(90),
});

/** Positive-integer bounds checked beyond what the schema can express. */
const POSITIVE_INTEGER_FIELDS = [
  "promptRecentCount",
  "promptMaxChars",
  "maxTextChars",
  "searchLimitDefault",
  "searchLimitMax",
  "staleAfterDays",
] as const;

/** Similarity thresholds that must land in [0, 1]. */
const THRESHOLD_FIELDS = ["dedupeThreshold", "dedupeCosineThreshold"] as const;

/**
 * Validate the bounds the schema cannot express. Throws on the first problem
 * so a broken patch layer fails the whole plugin load (fail-loud).
 *
 * @param config - schema-validated config.
 * @throws `Error` describing the offending field.
 */
export function validateConfig(config: LtmConfig): void {
  if (config.path.length === 0) {
    throw new Error("ltm: `path` must not be empty");
  }
  for (const field of POSITIVE_INTEGER_FIELDS) {
    const value = config[field];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `ltm: invalid ${field} ${value} — must be an integer >= 1`,
      );
    }
  }
  if (!Number.isFinite(config.promptOrder)) {
    throw new Error(
      `ltm: invalid promptOrder ${config.promptOrder} — must be finite`,
    );
  }
  for (const field of THRESHOLD_FIELDS) {
    const value = config[field];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`ltm: invalid ${field} ${value} — must be in [0, 1]`);
    }
  }
  if (config.searchLimitDefault > config.searchLimitMax) {
    throw new Error(
      `ltm: searchLimitDefault ${config.searchLimitDefault} exceeds searchLimitMax ${config.searchLimitMax}`,
    );
  }
  for (const [index, sequence] of config.escapeSequences.entries()) {
    if (typeof sequence !== "string" || sequence.length < 2) {
      throw new Error(
        `ltm: escapeSequences[${index}] ${JSON.stringify(sequence)} must be a string of length >= 2`,
      );
    }
    if (sequence.includes(ZERO_WIDTH_SPACE)) {
      throw new Error(
        `ltm: escapeSequences[${index}] must not itself contain a zero-width space`,
      );
    }
  }
}

/**
 * Load and fully validate a config value (typically `ctx.config.ltm` from the
 * patch layer). Schemastery fills defaults; {@link validateConfig} then
 * rejects unusable values, so this either returns a safe config or throws.
 *
 * @param value - raw config value from the patch tree.
 * @returns the validated config.
 */
export function loadConfig(value: unknown): LtmConfig {
  const config = ConfigSchema(value as never) as LtmConfig;
  validateConfig(config);
  return config;
}

/** Schemastery schema, exported under the Cordis plugin convention. */
export const Config = ConfigSchema;
