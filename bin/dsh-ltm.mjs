#!/usr/bin/env node
// dsh-ltm CLI entry. See src/cli.ts for the command surface.

import { runCli } from "../dist/cli.js";

const code = await runCli(process.argv.slice(2));
// Flush stdout before exiting: process.exit() does not wait for pipe drains,
// which silently truncated large (--json list/export) output at the 64 KiB
// pipe buffer when stdout was not a TTY.
if (process.stdout.writableLength > 0) {
  await new Promise((resolve) => process.stdout.write("", resolve));
}
process.exit(code);
