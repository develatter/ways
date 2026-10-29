import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, DOCUMENTALIST_ROLE, isWikiPath, isWorkId, MANIFEST_PATH, slugify, WIKI_DIR, WORK_DIR } from "../domain/constants.js";
import type { ActiveWork } from "../domain/types.js";
import { clearRuns, currentBranchOf, gitDirs, readActive, writeActive, type GitDirs } from "../runtime/runtime.js";

/**
 * The Git commit hooks. This runs on every commit, so it only loads Node
 * built-ins and the runtime module and spawns git at most a few times.
 *
 * What breaks a guarantee, and is refused in every mode: a commit not made by
 * ways that adds, changes or deletes a work record under `.ways/work/` (the
 * criteria fixed at open, the evidence ways wrote, a review or a human
 * approval), and, from a session launched as the documentalist (`WAYS_ROLE`),
 * a commit that touches anything outside `docs/wiki/`: the wiki is for people,
 * the memory under `.ways/knowledge` is for agents, and the role writes only
 * the first. In `enforce` mode a commit outside any active work is refused
 * too. Everything else is accepted; the hook only adds `Harness-Work` (and
 * `Harness-Role` for the documentalist, which `ways check --history` audits).
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

/** Git cuts everything from this line on (`git commit -v`). */
const SCISSORS = /^# -+ >8 -+$/;

/** Splits a message into its content and the trailing comment block (and verbose diff) Git strips. */
function splitComments(message: string): { content: string; comments: string } {
  const lines = message.split("\n");
  const scissors = lines.findIndex((line) => SCISSORS.test(line));
  let end = scissors === -1 ? lines.length : scissors;
  while (end > 0 && (lines[end - 1]!.startsWith("#") || lines[end - 1]!.trim() === "")) end -= 1;
  return { content: lines.slice(0, end).join("\n"), comments: lines.slice(end).join("\n") };
}

function addTrailerLine(message: string, line: string, present: RegExp): string {
  const { content, comments } = splitComments(message);
  if (!content.trim() || present.test(content)) return message;
  const paragraphs = content.split(/\n\s*\n/);
  const last = paragraphs.at(-1) ?? "";
  const isTrailerBlock = paragraphs.length > 1 && last.split("\n").every((entry) => /^[A-Za-z0-9-]+:\s/.test(entry));
  const next = `${content}${isTrailerBlock ? "\n" : "\n\n"}${line}\n`;
  return comments ? `${next}${comments.startsWith("\n") ? "" : "\n"}${comments}` : next;
}

export function addTrailer(message: string, id: string): string {
  return addTrailerLine(message, `Harness-Work: ${id}`, TRAILER);
}

const ROLE_TRAILER = /^Harness-Role:\s*\S+\s*$/m;

/** `Harness-Role: documentalist` on a commit made from a documentalist session. */
export function addRoleTrailer(message: string, role: string): string {
  return addTrailerLine(message, `Harness-Role: ${role}`, ROLE_TRAILER);
}

/** The role a session was launched for, from the environment ways set when it started the agent. */
function sessionRole(): string | undefined {
  return process.env.WAYS_ROLE === DOCUMENTALIST_ROLE ? DOCUMENTALIST_ROLE : undefined;
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

/** From the branch, else the subject; never the id of a record that already exists. */
function autoStartId(dirs: GitDirs, message: string): string {
  const branch = currentBranchOf(dirs);
  const base = (branch && !DEFAULT_BRANCHES.has(branch) ? slugify(branch) : undefined)
    ?? slugify(splitComments(message).content.split("\n")[0] ?? "") ?? "change";
  let id = base;
  for (let suffix = 2; existsSync(join(dirs.top, WORK_DIR, `${id}.json`)); suffix += 1) id = `${base.slice(0, 58)}-${suffix}`;
  return id;
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
  const role = sessionRole();
  if (stage === "prepare" && role) {
    const outside = [...staged().keys()].filter((path) => !isWikiPath(path)).sort();
    if (outside.length > 0) {
      return {
        accepted: false,
        message: `ways: refused: this commit comes from the ${role} session and changes ${outside.join(" ")}, outside ${WIKI_DIR}/. The documentalist writes only the wiki for humans; code, tests, configuration and .ways/knowledge (the agents' memory) are not its to change. Unstage them with \`git restore --staged ${outside.join(" ")}\` and commit only ${WIKI_DIR}/.`,
      };
    }
  }
  if (stage === "prepare") {
    const tampered = tamperedRecords(dirs, staged());
    if (tampered.length > 0) {
      const list = tampered.join(" ");
      return {
        accepted: false,
        message: `ways: refused: this commit changes ${list}, which only ways writes (the criteria fixed at open, the evidence it ran, reviews and human approvals). Unstage it with \`git restore --staged ${list} && git restore ${list}\`; use \`ways done\` and \`ways review\` instead (approvals are the human's: \`ways approve\`). Integrating a branch that already contains the record with a squash? Commit with WAYS_DISABLE=1.`,
      };
    }
  }
  const message = readFileSync(messagePath, "utf8");
  if (TRAILER.test(splitComments(message).content)) {
    const traced = role ? addRoleTrailer(message, role) : message;
    if (traced !== message) writeFileSync(messagePath, traced, "utf8");
    return { accepted: true };
  }
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
  let next = addTrailer(message, id);
  if (role) next = addRoleTrailer(next, role);
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
