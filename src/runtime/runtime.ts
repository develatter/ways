import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isWorkId } from "../domain/constants.js";
import type { ActiveWork, EarlierRun } from "../domain/types.js";
import { writeAtomic } from "../fs/files.js";

/**
 * Runtime data lives inside the Git directory, never in the working tree and
 * never in history: which work is active, the local run log, derived search
 * indexes and service logs. This module only uses Node built-ins and Git so the
 * commit hook can load it cheaply.
 */
export interface GitDirs {
  top: string;
  /** Per-worktree Git directory (equals `common` in the main worktree). */
  gitDir: string;
  common: string;
}

const resolved = new Map<string, GitDirs>();

/**
 * Finds the working tree the way Git does for the plain layouts (a `.git`
 * directory, or a `.git` file pointing at a worktree's or submodule's Git
 * directory) without starting a process. Anything else, or GIT_DIR in the
 * environment, is left to `git rev-parse`.
 */
function locate(cwd: string): GitDirs | undefined {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return undefined;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    let stats;
    try {
      stats = statSync(dotGit);
    } catch {
      if (dirname(dir) === dir) return undefined;
      continue;
    }
    if (stats.isDirectory()) return { top: dir, gitDir: dotGit, common: dotGit };
    const match = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match?.[1]) return undefined;
    const gitDir = resolve(dir, match[1].trim());
    let common = gitDir;
    try {
      common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
    } catch {
      // A submodule's Git directory is its own common directory.
    }
    return { top: dir, gitDir, common };
  }
}

/** Resolved once per directory and process: the commit hook must not spawn git for every lookup. */
export function gitDirs(cwd: string): GitDirs {
  const cached = resolved.get(cwd);
  if (cached) return cached;
  let dirs = locate(cwd);
  if (!dirs) {
    const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Not inside a Git working tree: ${cwd}`);
    const [top, gitDir, common] = result.stdout.trim().split("\n");
    if (!top || !gitDir || !common) throw new Error(`Not inside a Git working tree: ${cwd}`);
    dirs = { top, gitDir, common };
  }
  resolved.set(cwd, dirs);
  return dirs;
}

/** The branch HEAD points at, read from the Git directory without spawning git; undefined when detached. */
export function currentBranchOf(dirs: GitDirs): string | undefined {
  try {
    const head = readFileSync(join(dirs.gitDir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : undefined;
  } catch {
    return undefined;
  }
}

export function runtimeDir(cwd: string, shared = true): string {
  const dirs = gitDirs(cwd);
  return join(shared ? dirs.common : dirs.gitDir, "ways");
}

function activePath(gitDir: string): string {
  return join(gitDir, "ways", "active.json");
}

function parseActive(path: string): ActiveWork | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const active = value as Partial<ActiveWork>;
  if (active.schemaVersion !== 1 || typeof active.id !== "string" || !isWorkId(active.id) || (active.kind !== "outcome" && active.kind !== "change")
    || typeof active.base !== "string" || typeof active.startedAt !== "string") return undefined;
  return value as ActiveWork;
}

/** The work active in this worktree, or the one active in the main worktree when this one has none. */
export function readActive(cwd: string): ActiveWork | undefined {
  const dirs = gitDirs(cwd);
  return parseActive(activePath(dirs.gitDir)) ?? (dirs.gitDir === dirs.common ? undefined : parseActive(activePath(dirs.common)));
}

export async function writeActive(cwd: string, active: ActiveWork): Promise<void> {
  await writeAtomic(activePath(gitDirs(cwd).gitDir), `${JSON.stringify(active, null, 2)}\n`);
}

export function clearActive(cwd: string, id?: string): void {
  const dirs = gitDirs(cwd);
  for (const gitDir of new Set([dirs.gitDir, dirs.common])) {
    const path = activePath(gitDir);
    if (id === undefined || parseActive(path)?.id === id) rmSync(path, { force: true });
  }
}

function runLogPath(cwd: string, id: string): string {
  return join(runtimeDir(cwd), "runs", `${id}.jsonl`);
}

/** Appends one `ways done` run to the local log; the closing evidence lists them. */
export function appendRun(cwd: string, id: string, run: EarlierRun): void {
  const path = runLogPath(cwd, id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(run)}\n`, "utf8");
}

export function readRuns(cwd: string, id: string): EarlierRun[] {
  try {
    return readFileSync(runLogPath(cwd, id), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as EarlierRun);
  } catch {
    return [];
  }
}

export function clearRuns(cwd: string, id: string): void {
  rmSync(runLogPath(cwd, id), { force: true });
}
