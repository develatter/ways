import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, isWorkId, MANIFEST_PATH, slugify, WORK_DIR } from "../domain/constants.js";
import type { ActiveWork } from "../domain/types.js";
import { clearRuns, gitDirs, readActive, writeActive, type GitDirs } from "../runtime/runtime.js";

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

/** Staged record files that do not come verbatim from a commit being merged, cherry-picked or rebased. */
function tamperedRecords(dirs: GitDirs): string[] {
  const staged = git(dirs.top, ["diff", "--cached", "--name-only", "-z", "--no-renames"]).out.split("\0").filter((path) => path.startsWith(`${WORK_DIR}/`));
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

/** An outcome left open at HEAD by a harness commit, found without parsing every record. */
function openOutcomeAtHead(top: string): ActiveWork | undefined {
  const last = git(top, ["log", "-1", "--format=%B%x00%H"]);
  if (!last.ok) return undefined;
  const [body = "", head = ""] = last.out.split("\0");
  const id = TRAILER.exec(body)?.[1];
  if (!id || !isWorkId(id)) return undefined;
  try {
    const record = JSON.parse(readFileSync(join(top, WORK_DIR, `${id}.json`), "utf8")) as { kind?: string; openedAt?: string; closed?: unknown; cancelled?: unknown };
    if (record.closed || record.cancelled || (record.kind !== "outcome" && record.kind !== "change")) return undefined;
    return { schemaVersion: 1, id, kind: record.kind, base: head.trim(), startedAt: record.openedAt ?? new Date().toISOString(), origin: "outcome" };
  } catch {
    return undefined;
  }
}

function autoStartId(top: string, message: string): string {
  const branch = git(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.ok && branch.out && !DEFAULT_BRANCHES.has(branch.out)) {
    const fromBranch = slugify(branch.out);
    if (fromBranch) return fromBranch;
  }
  return slugify(splitComments(message).content.split("\n")[0] ?? "") ?? "change";
}

async function judge(cwd: string, messagePath: string, stage: "prepare" | "final"): Promise<HookVerdict> {
  if (process.env.WAYS_DISABLE === "1") return { accepted: true };
  const dirs = gitDirs(cwd);
  const mode = enforcement(dirs.top);
  if (!mode) return { accepted: true };
  if (stage === "prepare") {
    const tampered = tamperedRecords(dirs);
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
  let active = readActive(dirs.top);
  let note: string | undefined;
  if (!active) {
    active = openOutcomeAtHead(dirs.top);
    if (active) await writeActive(dirs.top, active);
  }
  if (!active) {
    // The commit that installs ways is not work of its own.
    if (!git(dirs.top, ["cat-file", "-e", `HEAD:${MANIFEST_PATH}`]).ok) return { accepted: true };
    if (mode === "enforce") {
      return { accepted: false, message: "ways: refused: no active work (enforcement: enforce). Start one with `ways start <id>` or `ways outcome open <id> --goal=... --criterion=AC1:...`, then commit again." };
    }
    if (stage === "final" || !splitComments(message).content.trim()) return { accepted: true };
    const head = git(dirs.top, ["rev-parse", "-q", "--verify", "HEAD"]);
    if (!head.ok) return { accepted: true };
    active = { schemaVersion: 1, id: autoStartId(dirs.top, message), kind: "change", base: head.out, startedAt: new Date().toISOString(), origin: "commit" };
    await writeActive(dirs.top, active);
    clearRuns(dirs.top, active.id);
    note = `ways: this commit starts change ${active.id}; run \`ways done\` when it is finished.`;
  }
  const next = addTrailer(message, active.id);
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
