/** Offline prompt accounting only; unrelated to retrieval's Tokenizer seam. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { TokenCounter } from "./contracts.js";

/** DeepSeek-V3's published Split patterns (order is preserved by the asset). */
export const DEEPSEEK_SPLIT_PATTERNS = [
  "\\p{N}{1,3}",
  "[一-龥぀-ゟ゠-ヿ]+",
  '[!"#$%&\'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+|[^\r\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+| ?[\\p{P}\\p{S}]+[\r\n]*|\\s*[\r\n]+|\\s+(?!\\S)|\\s+',
] as const;

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a tokenizer JSON object");
  }
  return value as JsonObject;
}

/** Restrict to the tested ByteLevel/BPE family, not arbitrary HF JSON.
 * The JS backend accepts some unsupported regex constructs with changed semantics.
 * A closed pretokenizer allowlist avoids silently accepting those approximations.
 */
function validateAsset(value: unknown): JsonObject {
  const json = object(value);
  const model = object(json.model);
  if (model.type !== "BPE" || model.dropout != null || model.byte_fallback === true ||
      model.fuse_unk === true || model.ignore_merges === true ||
      model.continuing_subword_prefix != null || model.end_of_word_suffix != null || model.unk_token != null) {
    throw new Error("supported tokenizer requires deterministic ByteLevel BPE without dropout, unknown-token, suffix, or byte-fallback options");
  }
  const vocab = object(model.vocab);
  if (!Object.values(vocab).every((id) => Number.isSafeInteger(id) && Number(id) >= 0) || !Array.isArray(model.merges)) {
    throw new Error("invalid BPE vocabulary or merges");
  }
  const ids = new Map<number, string>();
  for (const [token, id] of Object.entries(vocab)) {
    if (ids.has(id as number)) throw new Error("BPE vocabulary IDs must be unique");
    ids.set(id as number, token);
  }
  const legacyMerges = typeof model.merges[0] === "string";
  for (const merge of model.merges) {
    if ((typeof merge === "string") !== legacyMerges) {
      throw new Error("BPE merges must use one consistent representation: all strings or all pairs");
    }
    const pair: unknown = typeof merge === "string" ? merge.split(" ") : merge;
    if (!Array.isArray(pair) || pair.length !== 2 ||
        typeof pair[0] !== "string" || typeof pair[1] !== "string" ||
        !Object.hasOwn(vocab, pair[0]) || !Object.hasOwn(vocab, pair[1]) ||
        !Object.hasOwn(vocab, pair[0] + pair[1])) {
      throw new Error("each BPE merge must have two vocabulary operands and a vocabulary concatenated result");
    }
  }
  // Canonical GPT-2/ByteLevel alphabet: validate all 256 base symbols so an
  // unseen Unicode byte cannot later disappear through a missing-vocab fallback.
  // This is asset validation only; all tokenization/BPE stays in the backend.
  let extra = 256;
  for (let byte = 0; byte < 256; byte++) {
    const visible = (byte >= 33 && byte <= 126) || (byte >= 161 && byte <= 172) || byte >= 174;
    const symbol = String.fromCodePoint(visible ? byte : extra++);
    if (!Object.hasOwn(vocab, symbol)) throw new Error("ByteLevel vocabulary must contain all 256 base byte symbols");
  }
  if (json.normalizer != null) {
    const normalizer = object(json.normalizer);
    if (normalizer.type !== "Sequence" || !Array.isArray(normalizer.normalizers) || normalizer.normalizers.length !== 0) {
      throw new Error("only an absent or empty Sequence normalizer is supported");
    }
  }
  if (json.added_tokens != null) {
    if (!Array.isArray(json.added_tokens)) throw new Error("added_tokens must be an array");
    const added = json.added_tokens.map(object);
    const contents = new Set<string>();
    for (const token of added) {
      // single_word is ignored by this backend; strip uses JS trim semantics,
      // which differ from Rust's Unicode whitespace set. Neither is safe here.
      if (token.single_word !== false || token.lstrip !== false || token.rstrip !== false ||
          typeof token.normalized !== "boolean" || typeof token.special !== "boolean" ||
          typeof token.content !== "string" || token.content.length === 0 ||
          !Number.isSafeInteger(token.id) || Number(token.id) < 0) {
        throw new Error("added tokens require valid id/content, explicit boolean normalized/special, and single_word/lstrip/rstrip=false");
      }
      const content = token.content as string;
      const id = token.id as number;
      if (contents.has(content) || (ids.has(id) && ids.get(id) !== content) ||
          (Object.hasOwn(vocab, content) && vocab[content] !== id)) {
        throw new Error("added-token contents must be unique and IDs must not conflict with vocabulary or other added tokens");
      }
      contents.add(content);
      ids.set(id, content);
    }
    // Normalization is identity in our supported subset. With an empty Sequence
    // the backend nevertheless splits unnormalized tokens before normalized ones;
    // cross-group overlapping contents could therefore change longest matching.
    if (json.normalizer != null) {
      for (const left of added) for (const right of added) {
        if (left.normalized !== right.normalized &&
            (left.content as string).includes(right.content as string)) {
          throw new Error("overlapping normalized and unnormalized added tokens are unsupported");
        }
      }
    }
  }
  const pre = object(json.pre_tokenizer);
  const steps = pre.type === "Sequence" ? pre.pretokenizers : [pre];
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("missing ByteLevel pretokenizer");
  for (const [index, value] of steps.entries()) {
    const step = object(value);
    if (index === steps.length - 1 && step.type === "ByteLevel") {
      if (typeof step.add_prefix_space !== "boolean" || typeof step.use_regex !== "boolean") {
        throw new Error("ByteLevel add_prefix_space and use_regex must be explicit booleans");
      }
    } else if (step.type === "Split" && step.behavior === "Isolated" && step.invert === false &&
      DEEPSEEK_SPLIT_PATTERNS.includes(object(step.pattern).Regex as typeof DEEPSEEK_SPLIT_PATTERNS[number])) {
      // Only the upstream DeepSeek patterns have been fidelity-tested.
    } else {
      throw new Error("unsupported pretokenizer: use ByteLevel or DeepSeek-V3 Isolated Split patterns followed by ByteLevel");
    }
  }
  if (object(steps[steps.length - 1]).type !== "ByteLevel") throw new Error("last pretokenizer must be ByteLevel");
  if (json.truncation != null || json.padding != null) throw new Error("tokenizer truncation/padding must be disabled for hard-budget accounting");
  return json;
}

/** Load once at startup. No Hub helpers, fetch, downloads, or render-time I/O.
 * No tokenizer_config.json/chat template: count the supplied section only,
 * with tokenizer.json added-token matching but no inserted special tokens.
 */
export function loadTokenCounter(path: string): TokenCounter {
  let json: JsonObject;
  try {
    json = validateAsset(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    // Avoid echoing the asset contents (JSON parser diagnostics can contain text).
    const detail = error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "invalid asset";
    throw new Error(`ltm: cannot load promptTokenizerPath: ${detail}`);
  }
  let backend: typeof import("@huggingface/tokenizers");
  try {
    backend = createRequire(import.meta.url)("@huggingface/tokenizers") as typeof backend;
  } catch {
    throw new Error("ltm: token budget requires optional @huggingface/tokenizers@0.2.0; install optional dependencies");
  }
  try {
    const tokenizer = new backend.Tokenizer(json, {});
    const counter: TokenCounter = (text) => {
      const ids: number[] = tokenizer.encode(text, { add_special_tokens: false }).ids;
      if (!ids.every((id) => Number.isSafeInteger(id) && id >= 0)) {
        throw new Error("ltm: tokenizer produced invalid IDs; check ByteLevel vocabulary completeness");
      }
      return ids.length;
    };
    // Force lazy regex/model initialization before registering the plugin.
    counter("Tokenizer startup check: 中文 café 123 😀\n");
    return counter;
  } catch {
    throw new Error("ltm: promptTokenizerPath is incompatible with the supported ByteLevel/BPE tokenizer; check vocabulary, merges and components");
  }
}

/** Validate the independent renderer seam even for direct/injected callers. */
export function validateTokenBudget(max: number | undefined, counter: TokenCounter | undefined): void {
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 1)) {
    throw new Error("ltm: promptMaxTokens must be a safe integer >= 1");
  }
  if (max !== undefined && counter === undefined) throw new Error("ltm: promptMaxTokens requires a TokenCounter");
}
