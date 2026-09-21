import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the source test suite. Without this, Vitest's default glob also
    // descends into gitignored local artifacts (pnpm's content-addressed
    // store, git worktrees), running many stale duplicate copies of these
    // same files and making the local `pnpm test` count non-deterministic.
    include: ["tests/**/*.test.ts"],
  },
});
