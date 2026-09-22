/**
 * Resolve the project-memory scope for one DSH agent workspace.
 *
 * Scope identity is local-first and deterministic. Git repositories use their
 * common Git directory, so linked worktrees share memories with the main
 * checkout. Non-Git workspaces use the canonical working directory. Only a
 * short hash is stored for Git; plain directories also carry a readable
 * basename. Absolute paths never enter the memory database or model prompt.
 *
 * @module dsh-ltm/scope
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Minimal structural shape accepted from DSH's per-agent scope object. */
interface AgentScopeLike {
  session?: {
    header?: {
      cwd?: unknown;
    };
  };
}

/** Result of resolving a workspace into one memory bucket. */
export interface ResolvedScope {
  /** Stable, non-sensitive value stored in `memories.scope`. */
  scope: string;
  /** Whether the identity came from a Git repository or a plain directory. */
  kind: "git" | "directory" | "fallback";
}

function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function findGitRoot(cwd: string): string | undefined {
  let directory = canonical(cwd);
  for (;;) {
    if (exists(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function gitDirectory(root: string): string | undefined {
  const marker = join(root, ".git");
  try {
    if (statSync(marker).isDirectory()) return canonical(marker);
    const firstLine = readFileSync(marker, "utf8").split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine?.startsWith("gitdir:")) return undefined;
    const value = firstLine.slice("gitdir:".length).trim();
    if (value.length === 0) return undefined;
    return canonical(isAbsolute(value) ? value : resolve(root, value));
  } catch {
    return undefined;
  }
}

function gitCommonDirectory(gitDir: string): string {
  try {
    const value = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (value.length > 0) {
      return canonical(isAbsolute(value) ? value : resolve(gitDir, value));
    }
  } catch {
    // A normal checkout has no `commondir`; its `.git` directory is common.
  }
  return canonical(gitDir);
}

function scopeName(kind: "git" | "directory", label: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  if (kind === "git") return `git:${digest}`;
  const readable = encodeURIComponent(label || "workspace");
  return `directory:${readable}:${digest}`;
}

/**
 * Resolve one session cwd to a project scope. Missing cwd uses `fallback`.
 */
export function resolveProjectScope(cwd: string | undefined, fallback = ""): ResolvedScope {
  if (cwd === undefined || cwd.length === 0) {
    return { scope: fallback, kind: "fallback" };
  }

  const workspace = canonical(cwd);
  const root = findGitRoot(workspace);
  if (root !== undefined) {
    const gitDir = gitDirectory(root);
    if (gitDir !== undefined) {
      const commonDir = gitCommonDirectory(gitDir);
      return {
        // Only the shared metadata identity enters a Git scope. A display label
        // would make main/linked worktrees diverge for separate-git-dir layouts.
        scope: scopeName("git", "", commonDir),
        kind: "git",
      };
    }
  }

  return {
    scope: scopeName("directory", basename(workspace), workspace),
    kind: "directory",
  };
}

/** Safely read `session.header.cwd` from a DSH prompt/tool scope. */
export function cwdFromAgentScope(scope: object | undefined): string | undefined {
  const cwd = (scope as AgentScopeLike | undefined)?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

/** Active scope visibility, optionally including the global bucket. */
export function visibleScopes(activeScope: string, includeGlobal = true): string[] {
  if (!includeGlobal || activeScope.length === 0) return [activeScope];
  return ["", activeScope];
}
