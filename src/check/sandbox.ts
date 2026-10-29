import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../fs/digest.js";
import type { GitRepository } from "../git/git.js";
import { fastHash } from "../runtime/lazy.js";
import { gitDirs, writeFileAtomic } from "../runtime/runtime.js";

/**
 * A clean checkout for evaluations: a detached Git worktree, outside the
 * working tree, holding exactly a committed tree. It is reused between runs
 * (that is the cache): each run checks out the commit with `--force` and
 * removes every untracked and ignored file except the dependency directories,
 * so nothing the agent left in its own checkout (build output, scratch files,
 * a stale `dist/`) reaches the checks.
 *
 * Dependencies: with a `setup` command configured, it runs in the checkout,
 * and only again when the setup command or a lockfile changes. Without one,
 * the dependency directories of the agent's checkout (`node_modules`, `.venv`,
 * `venv`) are linked in, read as they are; the evidence says so, and the CI,
 * which installs from scratch, stays the clean judge of those.
 */
export const DEPENDENCY_DIRS = ["node_modules", ".venv", "venv"] as const;

const LOCKFILES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "requirements.txt", "requirements-dev.txt", "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile.lock",
  "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock",
]);

export interface Checkout {
  dir: string;
  commit: string;
  /** How dependencies got there: "setup", "setup (cached)", "linked: node_modules", or "none". */
  dependencies: string;
  release(): void;
}

/** One clean checkout per worktree, so works running in parallel worktrees never wait for each other. */
function sandboxRoot(common: string, top: string): string {
  return join(tmpdir(), "ways-eval", fastHash(`${common}\n${top}`).slice(0, 16));
}

function lock(path: string): () => void {
  mkdirSync(join(path, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path);
      writeFileAtomic(join(path, "pid"), String(process.pid));
      return () => rmSync(path, { recursive: true, force: true });
    } catch {
      let pid = Number.NaN;
      try {
        pid = Number(readFileSync(join(path, "pid"), "utf8"));
      } catch {
        // A lock without a pid is being created, or was left by a crash.
      }
      let alive = false;
      try {
        if (Number.isInteger(pid)) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {
        // The process that held it is gone.
      }
      const age = (() => { try { return Date.now() - statSync(path).mtimeMs; } catch { return 0; } })();
      if (alive || (!Number.isInteger(pid) && age < 10_000)) break;
      rmSync(path, { recursive: true, force: true });
    }
  }
  throw new Error(`Another ways evaluation is running in this repository (lock ${path}); wait for it to finish, or remove the lock if no ways process is running`);
}

/** A digest of the setup command and every lockfile in the commit: setup runs again only when it changes. */
export async function setupKey(git: GitRepository, commit: string, setup: readonly string[]): Promise<string> {
  const entries = (await git.run(["ls-tree", "-r", "--format=%(objectname) %(path)", commit])).split("\n").filter((line) => {
    const path = line.slice(line.indexOf(" ") + 1);
    return LOCKFILES.has(path.slice(path.lastIndexOf("/") + 1));
  });
  return sha256(JSON.stringify({ setup, entries: entries.sort() }));
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Checks `commit` out in the reusable clean worktree of this repository and
 * prepares its dependencies. `runSetup` runs the configured setup there and
 * says whether it passed; it is skipped when the cache key is unchanged.
 */
export async function cleanCheckout(git: GitRepository, commit: string, options: { setup?: readonly string[]; runSetup?: (dir: string) => Promise<boolean> }): Promise<Checkout & { setupCached: boolean }> {
  const dirs = gitDirs(git.cwd);
  const root = sandboxRoot(dirs.common, dirs.top);
  const dir = join(root, "checkout");
  const release = lock(join(root, "lock"));
  try {
    let valid = false;
    if (existsSync(join(dir, ".git"))) {
      try {
        valid = (await git.run(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"])) === (await git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      rmSync(dir, { recursive: true, force: true });
      await git.run(["worktree", "prune"]);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      // Hooks of the repository (a post-checkout, say) must not run for the evaluation checkout.
      await git.run(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--force", dir, commit]);
    }
    const run = (args: string[]): Promise<string> => git.run(["-C", dir, "-c", "core.hooksPath=/dev/null", ...args]);
    await run(["checkout", "-q", "--detach", "--force", commit]);
    await run(["clean", "-q", "-ffdx", ...DEPENDENCY_DIRS.flatMap((name) => ["-e", `/${name}`])]);
    let dependencies = "none";
    let setupCached = false;
    const stamp = join(root, "setup.json");
    if (options.setup && options.runSetup) {
      // A link left by an earlier run without setup would let the setup write into the agent's checkout.
      for (const name of DEPENDENCY_DIRS) if (isLink(join(dir, name))) rmSync(join(dir, name), { force: true });
      const key = await setupKey(git, commit, options.setup);
      let previous: string | undefined;
      try {
        previous = (JSON.parse(readFileSync(stamp, "utf8")) as { key?: string }).key;
      } catch {
        // First setup in this checkout.
      }
      if (previous === key) {
        setupCached = true;
        dependencies = "setup (cached: setup command and lockfiles unchanged)";
      } else {
        rmSync(stamp, { force: true });
        if (await options.runSetup(dir)) writeFileAtomic(stamp, JSON.stringify({ key, commit }));
        dependencies = "setup";
      }
    } else {
      rmSync(stamp, { force: true });
      const linked: string[] = [];
      for (const name of DEPENDENCY_DIRS) {
        const source = join(git.cwd, name);
        const target = join(dir, name);
        if (!existsSync(source) || isLink(source)) continue;
        if (existsSync(target) && !isLink(target)) {
          // A tracked directory of that name is part of the commit; one a setup left behind is replaced.
          if ((await run(["ls-files", "--", name])) !== "") continue;
          rmSync(target, { recursive: true, force: true });
        }
        if (!isLink(target)) symlinkSync(source, target, "dir");
        linked.push(name);
      }
      if (linked.length > 0) dependencies = `linked from the working tree: ${linked.join(", ")}`;
    }
    return { dir, commit, dependencies, setupCached, release };
  } catch (error) {
    release();
    throw error;
  }
}
