import { isAbsolute, posix, relative, resolve } from "node:path";
import { knownRole, ROLE_SCOPES, WORK_DIR, type RoleScope } from "../domain/constants.js";
import type { Enforcement } from "../domain/types.js";

/**
 * The PreToolUse guard. It refuses only what would break a guarantee, before
 * the agent spends effort on it:
 *
 * - every mode: a tool call that writes, moves or deletes a work record under
 *   `.ways/work/` (the criteria fixed at open, the evidence ways ran, reviews,
 *   approvals). The commit hook refuses such a commit anyway; refusing the
 *   edit itself saves the round trip.
 * - `enforce` only: a shell command that switches the commit hooks off
 *   (`WAYS_DISABLE=1`, another `core.hooksPath`).
 * - a role ways launched (`WAYS_ROLE`): a write outside its scope. The
 *   documentalist (`ways wiki update`) writes only `docs/wiki/`: the wiki is
 *   for people and the memory (`.ways/knowledge`) is for agents. The
 *   onboarder (`ways onboard`) writes only the map notes, the memory, the
 *   project evals and its AGENTS.md proposal. Both launchers also compare the
 *   tree afterwards.
 *
 * Shell commands are read with a small tokenizer, not executed. Redirections
 * that duplicate descriptors (`2>&1`, `>&2`) or go to `/dev/null` are not
 * writes; reading a record (`cat`, `jq`, `git show`, `cp` from it) is allowed.
 * Anything it cannot read is allowed: CI audits records, so this is early
 * feedback, not the last line.
 */
export interface GuardInput {
  tool: string;
  toolInput: unknown;
  /** Worktree root. */
  top: string;
  /** Directory the agent runs in; relative tool paths resolve against it. */
  cwd: string;
  enforcement: Enforcement;
  /** The job the session was launched for (`WAYS_ROLE`), if any. */
  role?: string;
}

export interface GuardVerdict {
  /** Why the call is refused, written for the agent; absent when allowed. */
  deny?: string;
  code?: "record-write" | "hooks-bypass" | "role-scope";
  /** Repository-relative paths the call names, for the event log. */
  paths: string[];
}

const FILE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "apply_patch", "str_replace_based_edit_tool"]);
const SHELL_TOOLS = new Set(["bash", "shell", "run_terminal_cmd", "exec_command"]);

/** A tool path, relative to the worktree with `/` separators; undefined when outside it. */
export function repoPath(top: string, cwd: string, path: string): string | undefined {
  if (!path || path.includes("\0")) return undefined;
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const inside = relative(top, absolute).replaceAll("\\", "/");
  if (!inside || inside === ".." || inside.startsWith("../") || isAbsolute(inside)) return undefined;
  return inside;
}

/** Paths named by a file tool's input (`file_path`, `notebook_path`, `path`). */
export function toolPaths(toolInput: unknown, top: string, cwd: string): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const input = toolInput as Record<string, unknown>;
  const raw = [input.file_path, input.notebook_path, input.path].filter((value): value is string => typeof value === "string");
  return [...new Set(raw.map((path) => repoPath(top, cwd, path)).filter((path): path is string => path !== undefined))];
}

function isRecordPath(path: string): boolean {
  return path === WORK_DIR || path.startsWith(`${WORK_DIR}/`);
}

interface Token {
  kind: "word" | "op" | "redirect" | "dup";
  value: string;
}

/** Splits a shell command into words, control operators and redirections; quotes and escapes are honoured. */
export function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let quoted = false;
  const flush = (): void => {
    if (word || quoted) tokens.push({ kind: "word", value: word });
    word = "";
    quoted = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "'") {
      const end = command.indexOf("'", index + 1);
      word += command.slice(index + 1, end === -1 ? command.length : end);
      quoted = true;
      index = end === -1 ? command.length : end;
    } else if (character === '"') {
      let index2 = index + 1;
      while (index2 < command.length && command[index2] !== '"') {
        if (command[index2] === "\\" && index2 + 1 < command.length) index2 += 1;
        word += command[index2];
        index2 += 1;
      }
      quoted = true;
      index = index2;
    } else if (character === "\\" && index + 1 < command.length) {
      word += command[index + 1];
      index += 1;
    } else if (/\s/.test(character)) {
      if (character === "\n") {
        flush();
        tokens.push({ kind: "op", value: ";" });
      } else flush();
    } else if (character === ">" || (character === "&" && command[index + 1] === ">")) {
      // `[n]>`, `>>`, `>|`, `&>`, `[n]>&m`: a pending all-digit word is the descriptor, not an argument.
      if (/^\d+$/.test(word)) word = "";
      flush();
      let operator = character;
      if (character === "&") {
        operator += ">";
        index += 1;
      }
      while (command[index + 1] === ">" || command[index + 1] === "|") {
        operator += command[index + 1];
        index += 1;
      }
      if (command[index + 1] === "&") {
        index += 1;
        let target = "";
        while (index + 1 < command.length && /[\w-]/.test(command[index + 1]!)) target += command[++index];
        tokens.push({ kind: "dup", value: target });
        continue;
      }
      tokens.push({ kind: "redirect", value: operator });
    } else if (";|&()".includes(character)) {
      flush();
      let operator = character;
      if ((character === "&" || character === "|") && command[index + 1] === character) operator += command[++index];
      tokens.push({ kind: "op", value: operator });
    } else {
      word += character;
    }
  }
  flush();
  return tokens;
}

interface ShellReading {
  /** Paths a command writes, moves or deletes, as written. */
  writes: string[];
  /** Why the command switches the commit hooks off, if it does. */
  bypass?: string;
}

const WRAPPERS = new Set(["sudo", "command", "exec", "nohup", "time", "nice", "xargs"]);

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** What a shell command writes, moves or deletes, and whether it disables the commit hooks. */
export function readShell(command: string): ShellReading {
  const tokens = tokenize(command);
  const writes: string[] = [];
  let bypass: string | undefined;
  const segments: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "op") segments.push([]);
    else segments.at(-1)!.push(token);
  }
  // `cd` changes where later relative paths point; `dir` is relative to the agent's cwd unless absolute.
  let dir = "";
  const at = (path: string): string => posix.isAbsolute(path) || !dir ? path : posix.join(dir, path);
  for (const segment of segments) {
    const words: string[] = [];
    const redirected: string[] = [];
    for (let index = 0; index < segment.length; index += 1) {
      const token = segment[index]!;
      if (token.kind === "redirect") {
        const target = segment[index + 1];
        if (target?.kind === "word") {
          if (target.value !== "/dev/null") redirected.push(target.value);
          index += 1;
        }
      } else if (token.kind === "word") words.push(token.value);
    }
    const before = writes.length;
    writes.push(...redirected);
    let start = 0;
    for (;;) {
      const word = words[start];
      if (word === undefined) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        if (/^WAYS_DISABLE=1$/.test(word)) bypass = "WAYS_DISABLE=1";
        if (/^WAYS_ROLE=/.test(word)) bypass = "changing WAYS_ROLE";
        start += 1;
      } else if (word === "env" || WRAPPERS.has(basename(word))) start += 1;
      else if (word.startsWith("-") && start > 0) start += 1;
      else break;
    }
    const name = basename(words[start] ?? "");
    const args = words.slice(start + 1);
    const operands = args.filter((arg) => !arg.startsWith("-"));
    if (name === "export" && args.some((arg) => arg === "WAYS_DISABLE=1")) bypass = "WAYS_DISABLE=1";
    // A session launched for a job (WAYS_ROLE) keeps it: the commit hook reads the role from the environment.
    if ((name === "export" && args.some((arg) => /^WAYS_ROLE(=|$)/.test(arg))) || (name === "unset" && args.includes("WAYS_ROLE")) || words.some((word, index) => word === "WAYS_ROLE" && words[index - 1] === "-u")) bypass = "changing WAYS_ROLE";
    if (["tee", "rm", "rmdir", "unlink", "truncate", "shred", "mv"].includes(name)) writes.push(...operands);
    else if (["cp", "install", "ln", "rsync"].includes(name) && operands.length > 0) writes.push(operands.at(-1)!);
    else if ((name === "sed" || name === "perl") && args.some((arg) => /^(-[a-zA-Z]*i|--in-place)/.test(arg))) writes.push(...operands);
    else if (name === "dd") writes.push(...args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3)));
    else if (name === "git") {
      const hooksPath = args.findIndex((arg, index) => (arg === "-c" && /^core\.hookspath=/i.test(args[index + 1] ?? "")) || /^core\.hookspath=/i.test(arg));
      if (hooksPath >= 0) bypass = "git -c core.hooksPath";
      const sub = args.filter((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c" && args[index - 1] !== "-C");
      if (sub[0] === "config" && sub.some((arg) => /^core\.hookspath$/i.test(arg)) && (sub.length > 2 || args.some((arg) => arg.startsWith("--unset")))) bypass = "git config core.hooksPath";
      if (sub[0] === "rm") writes.push(...sub.slice(1));
    }
    for (let index = before; index < writes.length; index += 1) writes[index] = at(writes[index]!);
    if (name === "cd" || name === "pushd") {
      const target = operands[0];
      // `cd`, `cd -` or `cd ~`: a target this reading cannot know, so later relative writes are not judged.
      dir = target === undefined || target === "-" || target.startsWith("~") ? "/\0unknown" : posix.isAbsolute(target) ? target : posix.join(dir || ".", target);
    }
  }
  return { writes, ...(bypass ? { bypass } : {}) };
}

const RECORD_REFUSAL = (paths: string[]): string => `ways: refused: ${paths.join(", ")} ${paths.length === 1 ? "is a work record" : "are work records"}: the criteria fixed at open, the evidence ways ran, reviews and human approvals. Only ways writes ${WORK_DIR}/, and a commit that changes it is refused in every mode. Evidence comes from \`ways done\`; a review from \`ways review\` (an independent reviewer whose verdict ways records itself); an approval from the human running \`ways approve\`.`;

const BYPASS_REFUSAL = (how: string, role: string | undefined): string => `ways: refused: ${how} ${how.startsWith("changing") ? "gets around" : "switches off"} the ways commit hooks, and ${role ? `the ${role} may not do that` : "enforcement is `enforce` in this repository"}. Commit without it; if the hook refuses a commit, its message says why and what to run.`;

const ROLE_REFUSAL = (paths: string[], scope: RoleScope): string => `ways: refused: ${paths.join(", ")} is outside ${scope.where}, and you are ${scope.what}; if something needs changing elsewhere, say so in your final answer.`;

/** Paths a file tool names, as written, that a role may not write: outside the repository or outside its scope. */
function outsideScope(toolInput: unknown, top: string, cwd: string, scope: RoleScope): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const input = toolInput as Record<string, unknown>;
  const raw = [input.file_path, input.notebook_path, input.path].filter((value): value is string => typeof value === "string");
  return [...new Set(raw.filter((path) => {
    const inside = repoPath(top, cwd, path);
    return inside === undefined || !scope.allowed(inside);
  }))];
}

export function guard(input: GuardInput): GuardVerdict {
  const tool = input.tool.toLowerCase();
  const role = knownRole(input.role);
  const scope = role === undefined ? undefined : ROLE_SCOPES[role];
  if (FILE_TOOLS.has(tool)) {
    const paths = toolPaths(input.toolInput, input.top, input.cwd);
    const records = paths.filter(isRecordPath);
    if (records.length > 0) return { deny: RECORD_REFUSAL(records), code: "record-write", paths };
    const outside = scope ? outsideScope(input.toolInput, input.top, input.cwd, scope) : [];
    return outside.length > 0 && scope ? { deny: ROLE_REFUSAL(outside, scope), code: "role-scope", paths } : { paths };
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = (input.toolInput as { command?: unknown } | null)?.command;
    if (typeof command !== "string") return { paths: [] };
    const reading = readShell(command);
    const written = [...new Set(reading.writes.map((path) => repoPath(input.top, input.cwd, path)).filter((path): path is string => path !== undefined))];
    const records = written.filter(isRecordPath);
    if (records.length > 0) return { deny: RECORD_REFUSAL(records), code: "record-write", paths: records };
    if (reading.bypass && (input.enforcement === "enforce" || role)) return { deny: BYPASS_REFUSAL(reading.bypass, role), code: "hooks-bypass", paths: [] };
    const outside = scope ? written.filter((path) => !scope.allowed(path)) : [];
    if (outside.length > 0 && scope) return { deny: ROLE_REFUSAL(outside, scope), code: "role-scope", paths: outside };
    return { paths: [] };
  }
  return { paths: toolPaths(input.toolInput, input.top, input.cwd) };
}
