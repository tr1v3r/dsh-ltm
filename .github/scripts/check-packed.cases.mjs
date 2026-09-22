import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPackedContents } from "./check-packed.mjs";

const entries = ["cli.d.ts", "cli.js", "index.d.ts", "index.js"];
const roots = ["LICENSE", "README.md", "bin/dsh-ltm.mjs", "cordis.patch.yml", "package.json"];
const packed = (built) => [...roots, ...built.map((file) => `dist/${file}`)];

test("accepts renamed and multiple shared chunks from the actual build", () => {
  for (const chunks of [[], ["prompt-DmwR6shM.js"], ["scope-DuylH5Ol.js", "shared-A1b2C3_d.js"]]) {
    const built = [...entries, ...chunks];
    assertPackedContents(packed(built), built);
  }
});
test("rejects missing fixed package files", () => {
  assert.throws(() => assertPackedContents(packed(entries).filter((p) => p !== "cordis.patch.yml"), entries));
});
test("rejects a missing built shared chunk", () => {
  assert.throws(() => assertPackedContents(packed(entries), [...entries, "scope-DuylH5Ol.js"]));
});
test("rejects extra hashed chunks not emitted by this build", () => {
  assert.throws(() => assertPackedContents([...packed(entries), "dist/stale-AbCd1234.js"], entries));
});
test("rejects leaked source, state, or arbitrary JavaScript", () => {
  for (const extra of ["src/tools.ts", "memory.db", ".npmrc", "dist/secret.js"]) {
    assert.throws(() => assertPackedContents([...packed(entries), extra], entries));
  }
  assert.throws(() => assertPackedContents(packed([...entries, "secret.js"]), [...entries, "secret.js"]));
});
test("rejects missing build entries and duplicate archive entries", () => {
  assert.throws(() => assertPackedContents(packed(entries.slice(1)), entries.slice(1)));
  assert.throws(() => assertPackedContents([...packed(entries), "dist/cli.js"], entries));
});
