import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadAdapterSource } from "../adapters/source.js";
import { runWithInput } from "../check/process.js";
import { AGENT_HOOK_PATH, DOCUMENTALIST_ROLE, isWikiPath, WIKI_DIR } from "../domain/constants.js";
import { appendEvent, type EventResult, type EventType, type WaysEvent } from "../events/bus.js";
import { GitRepository } from "../git/git.js";
import { tokenize } from "../hooks/guard.js";
import { currentBranchOf, gitDirs, readActive } from "../runtime/runtime.js";
import { buildWikiBrief } from "./brief.js";
import { checkWiki, isIndex, renderReport } from "./check.js";
import { loadWikiConfig, type WikiConfig } from "./config.js";
import { readPages } from "./pages.js";
import { stampPage } from "./stamp.js";

/**
 * `ways wiki update`: launches the documentalist. ways builds the brief itself
 * (what is stale, missing and broken, from `ways wiki check`), starts the
 * agent as a new process with only the tools a documentalist needs, and does
 * not take its word for what it touched: before and after, it compares the
 * working tree and HEAD, and anything outside docs/wiki/ fails the run. The
 * hashes of the pages it changed are recorded by ways afterwards.
 *
 * Fences, from the outside in: the tool list and permissions the agent is
 * started with; the PreToolUse guard and the commit hook, which know the role
 * from `WAYS_ROLE`; this comparison; and CI (`ways check --history`, which
 * refuses a `Harness-Role: documentalist` commit that left docs/wiki/).
 */
const WIKI_TIMEOUT_MS = 30 * 60_000;
export const WIKI_INSTRUCTION = "Update the wiki as described above. Answer with a few lines: the pages you changed and your open doubts.";

export type WikiAgent = "claude" | "pi" | "command";

export interface WikiLaunch {
  agent: WikiAgent;
  /** Shown to the human and logged as the event's agent: claude, pi, or the command's program. */
  label: string;
  /** argv without the prompt, which goes on stdin. */
  command: string[];
  session: string;
  prompt: string;
  /** What the agent may use, for the human to read. */
  tools: string[];
}

const CLAUDE_ALLOWED = ["Read", "Grep", "Glob", `Edit(${WIKI_DIR}/**)`, `Write(${WIKI_DIR}/**)`, "Bash(ways wiki check*)", "Bash(npx --no-install ways wiki check*)", "Bash(git log*)", "Bash(git diff*)", "Bash(git show*)"];
const CLAUDE_DENIED = ["Edit(.ways/**)", "Write(.ways/**)", "NotebookEdit", "WebFetch", "WebSearch", "Bash(git commit*)", "Bash(git add*)", "Bash(git push*)"];
const PI_TOOLS = ["read", "grep", "find", "ls", "edit", "write"];

/** Claude Code also runs ways' guard for every write and shell call of this session, which the project's own hooks only do for work records. */
function guardSettings(): string {
  const command = `"$CLAUDE_PROJECT_DIR"/${AGENT_HOOK_PATH} claude PreToolUse`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash", hooks: [{ type: "command", command, timeout: 10 }] }] } });
}

/** The role's text, as the packaged documentalist role has it. */
export async function documentalistRole(): Promise<string> {
  const role = (await loadAdapterSource()).roles.find((candidate) => candidate.name === DOCUMENTALIST_ROLE);
  if (!role) throw new Error(`The ${DOCUMENTALIST_ROLE} role is missing from this installation of ways (assets/adapters/roles)`);
  return role.body;
}

/** Which agent and how it is started; nothing runs here. */
export function planLaunch(top: string, choice: string | undefined, config: WikiConfig, prompt: string, env: NodeJS.ProcessEnv = process.env): WikiLaunch {
  let agent: WikiAgent | undefined;
  let argv: string[] | undefined;
  if (choice === "claude" || choice === "pi") agent = choice;
  else if (choice !== undefined && choice !== "command") {
    argv = tokenize(choice).filter((token) => token.kind === "word").map((token) => token.value);
    if (argv.length === 0) throw new Error(`--agent must be claude, pi or a command to run, got "${choice}"`);
    agent = "command";
  } else agent = choice === "command" ? "command" : config.agent ?? (env.CLAUDECODE ? "claude" : env.PI_CODING_AGENT ? "pi" : undefined);
  if (!agent) throw new Error('Which agent writes the wiki? Run `ways wiki update --agent=claude`, `--agent=pi` or `--agent="<command>"` (it gets the brief on stdin), or set "agent" in .ways/wiki.json');
  if (agent === "command") {
    argv ??= config.command;
    if (!argv || argv.length === 0) throw new Error('No command to run: pass `ways wiki update --agent="<command>"`, or set "command": ["my-agent"] in .ways/wiki.json');
    return { agent, label: basename(argv[0]!), command: argv, session: `wiki-${randomUUID().slice(0, 8)}`, prompt, tools: ["whatever the command allows (ways checks what it changed afterwards)"] };
  }
  if (agent === "pi") {
    return { agent, label: "pi", command: ["pi", "-p", "--no-session", "--tools", PI_TOOLS.join(","), WIKI_INSTRUCTION], session: `wiki-${randomUUID().slice(0, 8)}`, prompt, tools: PI_TOOLS };
  }
  const session = randomUUID();
  // The variadic options come first; --session-id takes one value, so the instruction after it stays a positional.
  const command = ["claude", "-p", "--output-format", "json", "--permission-mode", "dontAsk", "--no-session-persistence", "--tools", "Read,Grep,Glob,Edit,Write,Bash", "--allowedTools", CLAUDE_ALLOWED.join(","), "--disallowedTools", CLAUDE_DENIED.join(",")];
  if (existsSync(join(top, AGENT_HOOK_PATH))) command.push("--settings", guardSettings());
  command.push("--session-id", session, WIKI_INSTRUCTION);
  return { agent, label: "claude", command, session, prompt, tools: CLAUDE_ALLOWED };
}

interface Snapshot {
  head: string | undefined;
  /** Uncommitted paths outside the wiki, with a hash of their content. */
  dirty: Map<string, string>;
  /** Wiki pages with a hash of their text. */
  pages: Map<string, string>;
}

function sha1(content: Buffer | string): string {
  return createHash("sha1").update(content).digest("hex");
}

async function snapshot(top: string): Promise<Snapshot> {
  const git = new GitRepository(top);
  let head: string | undefined;
  try {
    head = await git.head();
  } catch {
    head = undefined;
  }
  const dirty = new Map<string, string>();
  for (const path of await git.dirtyPaths()) {
    if (isWikiPath(path)) continue;
    try {
      dirty.set(path, sha1(await readFile(join(top, path))));
    } catch {
      dirty.set(path, "deleted");
    }
  }
  const pages = new Map((await readPages(top)).map((page) => [page.path, sha1(page.text)]));
  return { head, dirty, pages };
}

/** Paths outside docs/wiki/ that the run changed: uncommitted edits, new files, and anything it committed. */
export async function outOfScope(top: string, before: Snapshot, after: Snapshot): Promise<string[]> {
  const touched = new Set<string>();
  for (const [path, hash] of after.dirty) if (before.dirty.get(path) !== hash) touched.add(path);
  if (before.head && after.head && before.head !== after.head) {
    const changed = await new GitRepository(top).run(["diff", "--name-only", "--no-renames", "-z", before.head, after.head, "--"]);
    for (const path of changed.split("\0").filter(Boolean)) if (!isWikiPath(path)) touched.add(path);
  }
  return [...touched].sort();
}

function dirsEvent(top: string): Pick<WaysEvent, "worktree" | "branch" | "work"> {
  const dirs = gitDirs(top);
  return { worktree: dirs.top, branch: currentBranchOf(dirs) ?? null, work: readActive(dirs.top)?.id ?? null };
}

/** The session on the event bus, so the board shows the documentalist. A bus that cannot be written never fails the run. */
function emit(top: string, launch: WikiLaunch, type: EventType, result: EventResult, started: number, detail?: string): void {
  try {
    appendEvent(gitDirs(top), { v: 1, ts: new Date().toISOString(), session: launch.session, agent: launch.label, type, hook: "wiki", role: DOCUMENTALIST_ROLE, ...dirsEvent(top), result, ms: Date.now() - started, ...(detail ? { detail } : {}) });
  } catch {
    // Observation only.
  }
}

function finalText(launch: WikiLaunch, stdout: string): string {
  if (launch.agent === "claude") {
    try {
      const parsed = JSON.parse(stdout) as { result?: unknown };
      if (typeof parsed.result === "string") return parsed.result.trim();
    } catch {
      // Not the JSON envelope.
    }
  }
  return stdout.trim();
}

export interface UpdateOptions {
  agent?: string;
  dryRun?: boolean;
}

/** Quotes a word for display only; the command itself never goes through a shell. */
function shown(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export async function updateWiki(cwd: string, options: UpdateOptions, say: (line: string) => void = console.log): Promise<number> {
  const top = gitDirs(cwd).top;
  const pages = await readPages(top);
  if (pages.length === 0) throw new Error("There is no wiki to update (docs/wiki is empty or missing); run `ways wiki init` first");
  const { config, problems } = await loadWikiConfig(top);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const report = await checkWiki(top);
  const brief = await buildWikiBrief(top, report);
  if (brief.empty && !options.dryRun) {
    say("The wiki is up to date: nothing is stale, missing or broken, so no agent was launched.");
    return 0;
  }
  const prompt = `${await documentalistRole()}\n\n${brief.text}`;
  const launch = planLaunch(top, options.agent, config, prompt);
  if (options.dryRun) {
    say(prompt.trimEnd());
    say("");
    say(`# Would run (the prompt above goes on stdin; environment WAYS_ROLE=${DOCUMENTALIST_ROLE}):`);
    say(launch.command.map(shown).join(" "));
    say(`# The agent may use: ${launch.tools.join(", ")}. Afterwards ways compares the working tree and HEAD: anything outside ${WIKI_DIR}/ fails the run.`);
    return 0;
  }

  const started = Date.now();
  const before = await snapshot(top);
  say(`Launching the documentalist (${launch.label}); it may write only under ${WIKI_DIR}/. This can take a few minutes.`);
  emit(top, launch, "session.started", "ok", started, "wiki update");
  let output;
  try {
    output = await runWithInput(launch.command, top, launch.prompt, {
      timeoutMs: WIKI_TIMEOUT_MS,
      env: { ...process.env, WAYS_ROLE: DOCUMENTALIST_ROLE, WAYS_SESSION: launch.session, WAYS_AGENT: launch.label },
      unavailable: (error, program) => new Error(`Cannot start the documentalist \`${program}\`: ${error.message}. Install it, choose another with \`ways wiki update --agent=claude|pi|"<command>"\`, or see \`ways wiki update --dry-run\` for what would run`),
    });
  } catch (error) {
    emit(top, launch, "agent.stopped", "error", started, "cannot start");
    emit(top, launch, "session.ended", "error", started, "cannot start");
    throw error;
  }
  const after = await snapshot(top);
  const strays = await outOfScope(top, before, after);
  if (strays.length > 0) {
    emit(top, launch, "agent.stopped", "refused", started, "outside docs/wiki");
    emit(top, launch, "session.ended", "refused", started, "outside docs/wiki");
    say(`The documentalist changed files outside ${WIKI_DIR}/, which it may not touch:`);
    for (const path of strays) say(`  ${path}`);
    say(`Nothing was kept or stamped. Look at them with \`git status\`; undo with \`git restore -- <path>\` (and delete new files). The wiki pages it wrote are left as they are.`);
    return 1;
  }
  if (output.code !== 0) {
    emit(top, launch, "agent.stopped", "error", started, `exit ${output.code ?? "signal"}`);
    emit(top, launch, "session.ended", "error", started, `exit ${output.code ?? "signal"}`);
    const tail = `${output.stdout}\n${output.stderr}`.trim().split("\n").slice(-8).join("\n");
    say(`The documentalist (${launch.label}) exited ${output.code ?? "by a signal"}. Its last output:\n${tail || "(none)"}`);
    return 1;
  }

  // The agent wrote prose; ways writes the hashes, over what is there now.
  const changed = [...after.pages].filter(([path, hash]) => before.pages.get(path) !== hash).map(([path]) => path);
  const stamped: string[] = [];
  const written = await readPages(top);
  for (const path of changed) {
    const page = written.find((candidate) => candidate.path === path);
    if (!page || isIndex(page)) continue;
    try {
      await stampPage(top, path);
      stamped.push(path);
    } catch (error) {
      say(`  not stamped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const answer = finalText(launch, output.stdout);
  if (answer) say(answer.split("\n").slice(0, 40).join("\n"));
  say(`${changed.length} page(s) changed, ${stamped.length} stamped.`);
  const final = await checkWiki(top);
  emit(top, launch, "agent.stopped", "ok", started, `${changed.length} page(s)`);
  emit(top, launch, "session.ended", "ok", started, final.issues.length === 0 ? "wiki ok" : `${final.issues.length} problem(s) left`);
  say(renderReport(final));
  if (changed.length > 0) say("Review the diff of docs/wiki/ and commit it; ways changed nothing else.");
  return final.issues.length === 0 ? 0 : 1;
}
