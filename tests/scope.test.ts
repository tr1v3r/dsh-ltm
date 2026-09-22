import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cwdFromAgentScope,
  resolveProjectScope,
  visibleScopes,
} from "../src/scope.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ltm-scope-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveProjectScope", () => {
  it("uses one Git scope throughout a repository", () => {
    const root = join(dir, "project");
    const nested = join(root, "packages", "app");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    const fromRoot = resolveProjectScope(root);
    const fromNested = resolveProjectScope(nested);
    expect(fromRoot.kind).toBe("git");
    expect(fromNested).toEqual(fromRoot);
    expect(fromRoot.scope).toMatch(/^git:[a-f0-9]{16}$/);
    expect(fromRoot.scope).not.toContain(dir);
  });

  it("shares scope between a repository and its linked worktree", () => {
    const root = join(dir, "project");
    const common = join(root, ".git");
    const worktree = join(dir, "feature-worktree");
    const gitDir = join(common, "worktrees", "feature-worktree");
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "commondir"), "../..\n");

    expect(resolveProjectScope(worktree)).toEqual(resolveProjectScope(root));
  });

  it("shares scope with a linked worktree using a separate Git directory", () => {
    const root = join(dir, "project-name");
    const metadata = join(dir, "metadata", "opaque.git");
    const worktree = join(dir, "feature-worktree");
    const gitDir = join(metadata, "worktrees", "feature-worktree");
    mkdirSync(root, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${metadata}\n`);
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "commondir"), "../..\n");

    expect(resolveProjectScope(worktree)).toEqual(resolveProjectScope(root));
    expect(resolveProjectScope(root).scope).toMatch(/^git:[a-f0-9]{16}$/);
  });

  it("isolates non-Git working directories and supports fallback", () => {
    const first = join(dir, "first");
    const second = join(dir, "second");
    mkdirSync(first);
    mkdirSync(second);

    expect(resolveProjectScope(first).kind).toBe("directory");
    expect(resolveProjectScope(first).scope).not.toBe(
      resolveProjectScope(second).scope,
    );
    expect(resolveProjectScope(undefined, "manual")).toEqual({
      scope: "manual",
      kind: "fallback",
    });
  });
});

describe("DSH scope helpers", () => {
  it("reads only a valid agent session cwd", () => {
    expect(
      cwdFromAgentScope({ session: { header: { cwd: "/workspace/repo" } } }),
    ).toBe("/workspace/repo");
    expect(cwdFromAgentScope({ session: { header: { cwd: 42 } } })).toBeUndefined();
    expect(cwdFromAgentScope(undefined)).toBeUndefined();
  });

  it("includes global only when requested", () => {
    expect(visibleScopes("")).toEqual([""]);
    expect(visibleScopes("project:a:1234")).toEqual(["", "project:a:1234"]);
    expect(visibleScopes("fixed", false)).toEqual(["fixed"]);
  });
});
