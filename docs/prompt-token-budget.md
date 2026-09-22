# Offline prompt token budget

Implements [proposal #15](https://github.com/tr1v3r/dsh-ltm/issues/15).

## Architecture and compatibility

`TokenCounter = (text: string) => number` is a synchronous deterministic seam in
`src/contracts.ts`, independent of the frozen retrieval `Tokenizer`. It returns a
nonnegative safe integer; invalid counts throw. `renderPrompt` and `recallRenderer`
accept an injected counter for tests/engine consumers. Configured token limits
without a counter throw, including for an empty store. Plugin startup loads a
counter before opening SQLite or registering tools; disposing the plugin preserves
the existing store lifecycle. No async callback or tool/CLI contract changes.

The optional adapter uses the official, maintained
[`@huggingface/tokenizers@0.2.0`](https://github.com/huggingface/tokenizers.js/tree/v0.2.0)
(Apache-2.0), pinned exactly in package metadata/lockfile. npm reports ~361 KB
unpacked, zero dependencies. Its CommonJS entry is lazily resolved with
`createRequire` only when enabled. No bundled WASM, native build or runtime network
is needed. Do not omit optional dependencies when enabling the feature.

A configured local `tokenizer.json` is parsed once and passed to
`new Tokenizer(json, {})`. Encoding uses `add_special_tokens: false`: tokenizer.json
added-token matching remains active, but no BOS/EOS, chat template or server framing
is inserted. `tokenizer_config.json` is deliberately not consumed. The unit being
budgeted is the recall section, not the entire conversation/request.

Default absent options retain the original char-only renderer byte-for-byte,
including its conservative separator accounting. Token mode uses exact assembled
candidates under both caps. It preserves the pinned-first greedy selection policy:
skip oversized pinned lines, block recent lines if any pinned was omitted, and
truncate the first pinned line only when none fit. Omission notices may evict recent
lines, never pinned ones. Truncation is code-point-safe (not grapheme-cluster-aware)
and requires an identifiable `- (#id` prefix. An impossible minimum budget produces
no section, not an oversized fallback.

## Supported asset subset

This is **not** an arbitrary Hugging Face JSON compatibility promise. The official
JS implementation documents regex differences from Rust/Oniguruma (including atomic
groups, possessive quantifiers, `\\G`, full Unicode case folding and Split merge
behaviors). Constructor success alone does not demonstrate fidelity.

The adapter therefore accepts only:

- BPE with all 256 canonical ByteLevel base symbols and integer vocabulary IDs;
- no dropout, unknown-token fallback, byte fallback, fused unknowns, ignore-merges,
  continuing-subword prefix or end-of-word suffix;
- no normalizer, or an empty Sequence;
- ByteLevel with explicit boolean `add_prefix_space` / `use_regex`; or a Sequence
  of the exact published DeepSeek-V3 `Isolated`, non-inverted Split regex patterns
  (allowlisted in source), ending in ByteLevel;
- added tokens with explicit `single_word/lstrip/rstrip: false`, valid id/content
  and boolean `normalized`/`special` flags. The backend ignores `single_word` and
  uses JS whitespace trimming rather than Rust semantics for strip flags, so those
  features are rejected. Normalization is identity here; overlapping contents
  across normalized/unnormalized added-token groups with an empty Sequence are
  rejected to avoid backend split-order differences;
- no tokenizer-level padding/truncation (the section budget must not be hidden by
  backend truncation).

Unsupported regex patterns, pipelines and normalization fail loudly. A tokenizer
for another model/revision may be refused even if the backend could support it.
Extend support only with upstream differential tests, not an estimated fallback.
Decoder/postprocessor definitions are passed to the backend, but decoding is not
used and automatic special-token postprocessing is disabled.

## Provisioning and model mismatch

1. Obtain the model publisher's tokenizer.json during deployment, **not at runtime**.
   Prefer an immutable Hugging Face commit URL rather than `resolve/main`.
2. Record publisher/model name, immutable revision, asset source URL, SHA-256,
   retrieval date, tokenizer library version and expected server model in your
   deployment manifest. Verify the SHA-256 before enabling config. This release
   does not automatically authenticate assets or require a configured hash.
3. Review the asset/model license, retain required notices and comply with local
   redistribution policy. The backend's Apache-2.0 license does not grant rights
   to a model's assets. No production model vocabulary is shipped in this package.
4. Store the file at a stable local path readable by the plugin process. Relative
   paths use the process working directory; absolute paths are recommended. Restart
   the plugin after changing the file/config; hot asset reload is not implemented.
5. Configure **both** `promptMaxTokens` (safe integer >= 1) and
   `promptTokenizerPath`. Neither has a default. `promptMaxChars` remains 2000.

Offline token counts for a supported chosen file do not guarantee server usage:
providers may change tokenizer revisions, add chat framing, handle special tokens
differently, or expose a model alias. Select the asset that matches your deployment
and retain headroom. There is no model inference, routing, download or network
fallback. This feature does not alter FTS schema/token versions, search, or dedupe.
Existing tag/scope escaping issue #10 and store scan issue #11 remain separate.

## Cost and verification

Disabled: no tokenizer resolution, asset loading or encoding; unchanged rendering.
Enabled: startup parses vocabulary/merges and allocates backend maps/caches once;
actual memory/startup cost scales with the model asset (DeepSeek's asset is large),
not the small npm wrapper. Rendering encodes whole candidates for greedy selection
and omission handling. Truncation checks descending code-point prefixes because
BPE token counts are not monotone under character extension. Worst-case truncation
can be quadratic in the character cap; keep `promptMaxChars` conservative (default
2000). This favors correctness over maximal packing and never assumes counts add.
No per-render I/O; only in-memory string work and encoding.

Regression fixtures:

- `tests/fixtures/bytelevel-tokenizer.json`: locally constructed MIT fixture, all
  256 ByteLevel symbols, seven real BPE merges, one added special token and the
  DeepSeek-V3 Split pipeline; not a production model vocabulary.
- `tests/fixtures/bytelevel-oracle.json`: complete expected ID sequences generated
  by Rust Hugging Face `tokenizers==0.22.2`, with special tokens disabled. Tests
  compare JS IDs as well as adapter counts; `hello hello` must be two merged tokens.
- Ten cases cover CJK/kana, Unicode combining marks, contractions, digit groups,
  punctuation, CRLF/tabs/trailing whitespace, NBSP/NEL/line separator, emoji/ZWJ,
  escaping syntax and added tokens. Tests require no Python, download or network.

Development additionally compared those ten complete ID sequences with the real
[DeepSeek-V3 tokenizer.json](https://huggingface.co/deepseek-ai/DeepSeek-V3/blob/main/tokenizer.json)
using Rust 0.22.2 vs JS 0.2.0. All matched. Tested asset SHA-256:
`621ac2e32d0dba658404412318818aaa8ce8cda492e59830109d8da6b517fb41`.
An independent differential run also matched all 1,867 complete ID sequences:
all pairs of 17 whitespace/control variants in three word contexts, plus 1,000
seeded mixed-script/code/emoji inputs. This is evidence for that asset and corpus,
not exhaustive proof for every Unicode input or future model. The large real asset and development Python environment are
not committed. Synthetic fixture SHA-256:
`65af32fce5b576fd2e3445132269a659c5bb441cd315cc7cb13ab419715af9e2`.

Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and
`node probe/boot-probe.mjs`. Tests also cover config failures, missing files,
startup-before-effects, removed assets after loading, invalid injected counters,
final assembled counting, dual caps, nonmonotone prefix counts, emoji truncation,
pinned priority and unchanged default behavior.
