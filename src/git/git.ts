import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommitTrailers {
  /** The work a commit belongs to; added by the commit hook, never by hand. */
  work?: string;
  /** Set only on commits the harness makes for a work record: opened, verifying, reviewed, closed, cancelled. */
  state?: string;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
  trailers: CommitTrailers;
}

export interface GitTreeEntry {
  mode: string;
  type: "blob" | "commit";
  object: string;
  path: string;
}

export class GitError extends Error {
  constructor(message: string, readonly stderr = "") {
    super(message);
    this.name = "GitError";
  }
}

export class GitRepository {
  constructor(readonly cwd: string) {}

  async run(args: readonly string[], env?: NodeJS.ProcessEnv, sanitizeGitEnv = false): Promise<string> {
    try {
      const baseEnvironment = sanitizeGitEnv
        ? Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
        : process.env;
      const { stdout } = await execFileAsync("git", [...args], {
        cwd: this.cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        env: { ...baseEnvironment, ...(env ?? {}) },
      });
      return stdout.trimEnd();
    } catch (error) {
      const failure = error as { message?: string; stderr?: string };
      throw new GitError(failure.message ?? `git ${args.join(" ")} failed`, failure.stderr ?? "");
    }
  }

  async runBuffer(args: readonly string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile("git", [...args], { cwd: this.cwd, encoding: "buffer", maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new GitError(error.message, stderr.toString("utf8")));
          return;
        }
        resolve(stdout);
      });
    });
  }

  async root(): Promise<string> {
    return this.run(["rev-parse", "--show-toplevel"]);
  }

  async head(): Promise<string> {
    return this.run(["rev-parse", "HEAD"]);
  }

  async parent(commit = "HEAD"): Promise<string> {
    return this.run(["rev-parse", `${commit}^`]);
  }

  async resolveRef(ref: string): Promise<string> {
    return this.run(["rev-parse", "--verify", `${ref}^{commit}`]);
  }

  async parents(commit = "HEAD"): Promise<string[]> {
    const fields = (await this.run(["show", "-s", "--format=%P", commit])).split(/\s+/).filter(Boolean);
    return fields;
  }

  async isMergeCommit(commit = "HEAD"): Promise<boolean> {
    return (await this.parents(commit)).length > 1;
  }

  async mergeBase(left: string, right: string): Promise<string> {
    return this.run(["merge-base", left, right]);
  }

  async changedPathsBetween(from: string, to: string): Promise<string[]> {
    const output = await this.run(["diff", "--no-renames", "--name-only", "-z", from, to, "--"]);
    return output.split("\0").filter(Boolean).sort();
  }

  /** Compute Git's proposed merged tree without creating a commit or changing the worktree. */
  async mergedTree(left: string, right: string): Promise<string> {
    const output = await this.run(["merge-tree", "--write-tree", left, right]);
    const tree = output.split("\n", 1)[0] ?? "";
    if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new GitError(`Unexpected merge-tree result: ${output}`);
    return tree;
  }

  async treeId(ref = "HEAD"): Promise<string> {
    return this.run(["rev-parse", "--verify", `${ref}^{tree}`]);
  }

  async treeEntries(ref = "HEAD"): Promise<GitTreeEntry[]> {
    const output = await this.run(["ls-tree", "-rz", "--full-tree", "--format=%(objectmode) %(objecttype) %(objectname)%x09%(path)", ref]);
    const entries: GitTreeEntry[] = [];
    for (const record of output.split("\0").filter(Boolean)) {
      const match = record.match(/^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/);
      if (!match?.[1] || !match[2] || !match[3] || !match[4]) throw new GitError(`Unexpected ls-tree record: ${record}`);
      entries.push({ mode: match[1], type: match[2] as "blob" | "commit", object: match[3], path: match[4] });
    }
    return entries;
  }

  async objectBytes(object: string): Promise<Buffer> {
    return this.runBuffer(["cat-file", "-p", object]);
  }

  async pathExists(ref: string, path: string): Promise<boolean> {
    try {
      await this.run(["cat-file", "-e", `${ref}:${path}`]);
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<string[]> {
    const output = await this.run(["status", "--porcelain=v1"]);
    return output ? output.split("\n") : [];
  }

  /** Unstaged, untracked and already staged (for example a resolved merge) paths; staged deletions commit as they are. */
  async changedPaths(): Promise<string[]> {
    const unstaged = await this.run(["ls-files", "--modified", "--deleted", "--others", "--exclude-standard"]);
    const staged = await this.run(["diff", "--cached", "--name-only", "--diff-filter=d"]);
    return [...new Set(`${unstaged}\n${staged}`.split("\n").filter(Boolean))].sort();
  }

  async assertClean(): Promise<void> {
    const changes = await this.status();
    if (changes.length > 0) {
      throw new GitError(`Worktree is not clean:\n${changes.join("\n")}`);
    }
  }

  async commitInfo(ref = "HEAD"): Promise<CommitInfo> {
    const output = await this.run(["show", "-s", "--format=%H%x00%s%x00%b", ref]);
    const [hash = "", subject = "", body = ""] = output.split("\0");
    return { hash, subject, body, trailers: parseTrailers(body) };
  }

  async lastCommit(): Promise<CommitInfo> {
    return this.commitInfo("HEAD");
  }

  async isAncestor(ancestor: string, descendant = "HEAD"): Promise<boolean> {
    try {
      await this.run(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  /** Uncommitted paths: modified, staged and untracked (ignored files excluded). */
  async dirtyPaths(): Promise<string[]> {
    const output = await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const paths: string[] = [];
    const records = output.split("\0");
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.length < 4) continue;
      paths.push(record.slice(3));
      // A rename or copy is followed by its source path.
      if (record[0] === "R" || record[0] === "C") index += 1;
    }
    return [...new Set(paths)].sort();
  }

  /**
   * A commit the harness makes for its own record: only `paths`, with its
   * trailers, and with the repository's hooks disabled so the commit hook,
   * which refuses hand-made record commits, never sees it.
   */
  async harnessCommit(paths: readonly string[], subject: string, trailers: CommitTrailers): Promise<string> {
    if (paths.length === 0) throw new GitError("Refusing to commit without explicit paths");
    await this.run(["add", "--", ...paths]);
    const args = ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", subject];
    const trailerBody = formatTrailers(trailers);
    if (trailerBody) args.push("-m", trailerBody);
    await this.run([...args, "--only", "--", ...paths]);
    return this.head();
  }
}

const TRAILER_NAMES: Record<string, keyof CommitTrailers> = {
  "Harness-Work": "work",
  "Harness-State": "state",
};

/** Reads the trailer block: the last paragraph of the message, as `git interpret-trailers` does. */
export function parseTrailers(body: string): CommitTrailers {
  const result: CommitTrailers = {};
  const paragraphs = body.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  const block = paragraphs.at(-1) ?? "";
  for (const line of block.split("\n")) {
    const match = line.match(/^([A-Za-z-]+):\s*(.+)$/);
    if (!match) continue;
    const key = match[1] ? TRAILER_NAMES[match[1]] : undefined;
    const value = match[2]?.trim();
    if (key && value) result[key] = value;
  }
  return result;
}

export function formatTrailers(trailers: CommitTrailers): string {
  const entries: Array<[string, string | undefined]> = [
    ["Harness-Work", trailers.work],
    ["Harness-State", trailers.state],
  ];
  return entries.filter((entry): entry is [string, string] => Boolean(entry[1])).map(([key, value]) => `${key}: ${value}`).join("\n");
}
