import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, isWorkId, MANIFEST_PATH, slugify, WORK_DIR } from "../domain/constants.js";
import type { ActiveWork } from "../domain/types.js";
import { clearRuns, currentBranchOf, gitDirs, readActive, writeActive, type GitDirs } from "../runtime/runtime.js";

/**
 * The Git commit hooks. This runs on every commit, so it only loads Node
 * built-ins and the runtime module and spawns git at most a few times.
 *
 * What breaks a guarantee, and is refused in every mode: a commit not made by
 * ways that adds, changes or deletes a work record under `.ways/work/` (the
 * criteria fixed at open, the evidence ways wrote, a review or a human
 * approval). In `enforce` mode a commit outside any active work is refused
 * too. Everything else is accepted; the hook only adds `Harness-Work`.
 */
export interface HookVerdict {
  accepted: boolean;
  /** Shown on stderr: the refusal, or a one-line note such as an automatic start. */
  message?: string;
}

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk"]);
const TRAILER = /^Harness-Work:\s*(\S+)\s*$/m;

function git(cwd: string, args: readonly string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trimEnd() };
}

function enforcement(top: string): "observe" | "enforce" | undefined {
  try {
    const config = JSON.parse(readFileSync(join(top, CONFIG_PATH), "utf8")) as { enforcement?: unknown };
    return config.enforcement === "enforce" ? "enforce" : "observe";
  } catch {
    return undefined;
  }
}

/** Staged paths with their status letter (A, M, D, ...), from one git call. */
function stagedChanges(dirs: GitDirs): Map<string, string> {
  const fields = git(dirs.top, ["diff", "--cached", "--name-status", "-z", "--no-renames"]).out.split("\0").filter(Boolean);
  const changes = new Map<string, string>();
  for (let index = 0; index + 1 < fields.length; index += 2) changes.set(fields[index + 1]!, fields[index]!);
  return changes;
}

/** Staged record files that do not come verbatim from a commit being merged, cherry-picked or rebased. */
function tamperedRecords(dirs: GitDirs, changes: ReadonlyMap<string, string>): string[] {
  const staged = [...changes.keys()].filter((path) => path.startsWith(`${WORK_DIR}/`));
  if (staged.length === 0) return [];
  const sources = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD"].filter((ref) => existsSync(join(dirs.gitDir, ref)));
  return staged.filter((path) => {
    const index = git(dirs.top, ["rev-parse", "-q", "--verify", `:${path}`]);
    return !sources.some((ref) => {
      const source = git(dirs.top, ["rev-parse", "-q", "--verify", `${ref}:${path}`]);
      return source.ok === index.ok && source.out === index.out;
    });
  });
}

/** Splits a message into its content and the trailing comment block Git strips. */
function splitComments(message: string): { content: string; comments: string } {
  const lines = message.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1]!.startsWith("#") || lines[end - 1]!.trim() === "")) end -= 1;
  return { content: lines.slice(0, end).join("\n"), comments: lines.slice(end).join("\n") };
}

export function addTrailer(message: string, id: string): string {
  const { content, comments } = splitComments(message);
  if (!content.trim() || TRAILER.test(content)) return message;
  const paragraphs = content.split(/\n\s*\n/);
  const last = paragraphs.at(-1) ?? "";
  const isTrailerBlock = paragraphs.length > 1 && last.split("\n").every((line) => /^[A-Za-z0-9-]+:\s/.test(line));
  const next = `${content}${isTrailerBlock ? "\n" : "\n\n"}Harness-Work: ${id}\n`;
  return comments ? `${next}${comments.startsWith("\n") ? "" : "\n"}${comments}` : next;
}

/**
 * The single open record in the working tree, for a checkout without a runtime
 * pointer (a fresh clone, another worktree). Read from files, without git; the
 * pointer itself is left to `ways done`, which knows the base.
 */
function openRecordInTree(top: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(join(top, WORK_DIR)).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  const open = names.filter((name) => {
    try {
      const record = JSON.parse(readFileSync(join(top, WORK_DIR, name), "utf8")) as { closed?: unknown; cancelled?: unknown };
      return !record.closed && !record.cancelled;
    } catch {
      return false;
    }
  }).map((name) => name.slice(0, -".json".length));
  return open.length === 1 && isWorkId(open[0]!) ? open[0] : undefined;
}

function autoStartId(dirs: GitDirs, message: string): string {
  const branch = currentBranchOf(dirs);
  if (branch && !DEFAULT_BRANCHES.has(branch)) {
    const fromBranch = slugify(branch);
    if (fromBranch) return fromBranch;
  }
  return slugify(splitComments(message).content.split("\n")[0] ?? "") ?? "change";
}

async function judge(cwd: string, messagePath: string, stage: "prepare" | "final"): Promise<HookVerdict> {
  if (process.env.WAYS_DISABLE === "1") return { accepted: true };
  // commit-msg after a traced prepare-commit-msg has nothing left to do: skip even resolving the repository.
  if (stage === "final" && TRAILER.test(splitComments(readFileSync(messagePath, "utf8")).content)) return { accepted: true };
  const dirs = gitDirs(cwd);
  const mode = enforcement(dirs.top);
  if (!mode) return { accepted: true };
  let changes: Map<string, string> | undefined;
  const staged = (): Map<string, string> => (changes ??= stagedChanges(dirs));
  if (stage === "prepare") {
    const tampered = tamperedRecords(dirs, staged());
    if (tampered.length > 0) {
      const list = tampered.join(" ");
      return {
        accepted: false,
        message: `ways: refused: this commit changes ${list}, which only ways writes (the criteria fixed at open, the evidence it ran, reviews and human approvals). Unstage it with \`git restore --staged ${list} && git restore ${list}\`; use \`ways done\`, \`ways review submit\` or \`ways approve\` instead. Integrating a branch that already contains the record with a squash? Commit with WAYS_DISABLE=1.`,
      };
    }
  }
  const message = readFileSync(messagePath, "utf8");
  if (TRAILER.test(splitComments(message).content)) return { accepted: true };
  let id = readActive(dirs.top)?.id ?? openRecordInTree(dirs.top);
  let note: string | undefined;
  if (!id) {
    // The commit that installs ways is not work of its own.
    if (staged().get(MANIFEST_PATH) === "A") return { accepted: true };
    if (mode === "enforce") {
      return { accepted: false, message: "ways: refused: no active work (enforcement: enforce). Start one with `ways start <id>` or `ways outcome open <id> --goal=... --criterion=AC1:...`, then commit again." };
    }
    // An empty message (the editor is still to come) is left alone; commit-msg traces it once written.
    if (!splitComments(message).content.trim()) return { accepted: true };
    const head = git(dirs.top, ["rev-parse", "-q", "--verify", "HEAD"]);
    if (!head.ok) return { accepted: true };
    const active: ActiveWork = { schemaVersion: 1, id: autoStartId(dirs, message), kind: "change", base: head.out, startedAt: new Date().toISOString(), origin: "commit" };
    await writeActive(dirs.top, active);
    clearRuns(dirs.top, active.id);
    id = active.id;
    note = `ways: this commit starts change ${active.id}; run \`ways done\` when it is finished.`;
  }
  const next = addTrailer(message, id);
  if (next !== message) writeFileSync(messagePath, next, "utf8");
  return { accepted: true, ...(note ? { message: note } : {}) };
}

/** `prepare-commit-msg <file> [source] [sha]`: refuses record tampering, then adds the trailer. */
export function prepareCommitMsg(cwd: string, messagePath: string): Promise<HookVerdict> {
  return judge(cwd, messagePath, "prepare");
}

/** `commit-msg <file>`: adds the trailer to a message written in the editor after prepare-commit-msg ran. */
export function commitMsg(cwd: string, messagePath: string): Promise<HookVerdict> {
  return judge(cwd, messagePath, "final");
}
