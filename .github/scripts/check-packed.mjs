import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ENTRY_FILES = ["cli.d.ts", "cli.js", "index.d.ts", "index.js"];
const ROOT_FILES = ["LICENSE", "README.md", "bin/dsh-ltm.mjs", "cordis.patch.yml", "package.json"];
const HASHED_CHUNK = /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js$/;

/** Compare every packed file with fixed public files and this build's chunks. */
export function assertPackedContents(packedFiles, builtFiles) {
  for (const entry of ENTRY_FILES) {
    assert.ok(builtFiles.includes(entry), `missing build entry: ${entry}`);
  }
  for (const file of builtFiles) {
    assert.ok(ENTRY_FILES.includes(file) || HASHED_CHUNK.test(file), `unexpected build artifact: ${file}`);
  }
  const expected = [...ROOT_FILES, ...builtFiles.map((file) => `dist/${file}`)].sort();
  assert.deepEqual([...packedFiles].sort(), expected, "unexpected or missing packed contents");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const listing = process.argv[2];
  if (!listing) throw new Error("usage: node .github/scripts/check-packed.mjs <tar-listing.txt>");
  const files = readFileSync(listing, "utf8").split(/\r?\n/).filter((line) => line && !line.endsWith("/"));
  const packed = files.map((file) => {
    assert.ok(file.startsWith("package/"), `unexpected archive path: ${file}`);
    return file.slice("package/".length);
  });
  const built = readdirSync("dist", { withFileTypes: true }).map((entry) => {
    assert.ok(entry.isFile(), `unexpected build directory or symlink: ${entry.name}`);
    return entry.name;
  });
  assertPackedContents(packed, built);
  console.log(`packed contents OK: ${packed.length} files`);
}
