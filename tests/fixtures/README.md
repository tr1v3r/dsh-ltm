# Tokenizer fixtures

These small test assets are locally constructed fixtures under this repository's
MIT license, not production model vocabularies. No model weights or vocabulary
were copied.

`bytelevel-tokenizer.json` was built with Python Hugging Face
`tokenizers==0.22.2`:

1. Assign IDs 0–255 to `sorted(pre_tokenizers.ByteLevel.alphabet())`.
2. Add merges in this order, assigning the concatenated token the next ID:
   `('h','e'), ('he','l'), ('hel','l'), ('hell','o'), ('Ġ','hello'),
   ('1','2'), ('12','3')`.
3. Construct `Tokenizer(models.BPE(vocab, merges))`, use ByteLevel decoding,
   no normalization, padding, truncation or postprocessing.
4. Set `pre_tokenizer` to the published DeepSeek-V3 three Isolated Split patterns
   plus ByteLevel (`add_prefix_space: false`, `use_regex: false`). These patterns
   are also allowlisted in `src/token-counter.ts`.
5. Add `<special>` at the next ID with `single_word/lstrip/rstrip/normalized:
   false`, `special: true`.

`bytelevel-oracle.json` records complete Rust-generated IDs for its listed texts:
`Tokenizer.from_file(...).encode(text, add_special_tokens=False).ids`.
The JS tests compare actual IDs and counts with these committed reference values.
Tests never invoke Python, fetch a Hub file or require network access. See
`docs/prompt-token-budget.md` for production asset provenance and differential
verification details. Do not regenerate oracle values with the JS implementation
under test.
