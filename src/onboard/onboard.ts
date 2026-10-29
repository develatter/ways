import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadAdapterSource } from "../adapters/source.js";
import { PROPOSAL_END, PROPOSAL_START, withProposal } from "../bootstrap/agents-md.js";
import { runWithInput } from "../check/process.js";
import { loadConfig } from "../config/config.js";
import { AGENT_HOOK_PATH, AGENTS_PROPOSAL_PATH, CHECKS_PATH, isOnboarderPath, KNOWLEDGE_DIR, MAP_NOTES_PATH, ONBOARDER_ROLE } from "../domain/constants.js";
import { CHECK_NAMES, type CheckName, type HarnessConfig } from "../domain/types.js";
import { writeAtomic } from "../fs/files.js";
import { appendEvent, type EventResult, type EventType } from "../events/bus.js";
import { GitRepository } from "../git/git.js";
import { tokenize } from "../hooks/guard.js";
import { inspectOkf, type OkfDocument } from "../knowledge/okf.js";
import { detectProject } from "../map/detect.js";
import { mapFiles, normalizeNotePath, readMapNotes, topFolders, writeMap, writeMapNotes } from "../map/map.js";
import { checkMemory } from "../memory/memory.js";
import { changedSources, isSeeded, stampSeeded } from "../memory/verify.js";
import { readChecksFile, writeChecksFile } from "../run/checks-file.js";
import { describeValidation, detectedCandidates, recordChecks, validateCandidates, type Candidate, type Rejected } from "../run/validate.js";
import { currentBranchOf, gitDirs, readActive, type GitDirs } from "../runtime/runtime.js";
import { onboardingPolicy, readOnboarding, writeOnboarding, type OnboardingSummary } from "./state.js";

/**
 * `ways onboard`: the first session's three layers. ways does the
 * deterministic part itself (MAP.md, the checks it can detect, each run once
 * to validate it) and launches the onboarder for what only reading the
 * history and docs can give: folder purposes, a few facts, check commands to
 * propose and additions to AGENTS.md. The onboarder runs as a new process
 * limited to its paths (tools it is started with, the guard and the commit
 * hook by `WAYS_ROLE`), and afterwards ways compares the tree: anything
 * outside its paths fails the run and nothing is marked done. Then ways
 * stamps the facts (sources' hashes, unverified), drops those that fail
 * `ways memory check`, runs every proposed check and keeps only those that
 * work, and moves the AGENTS.md proposal into its marked block.
 *
 * It never starts an agent silently: an agent spends the human's quota, so
 * with the `ask` policy it needs `--yes` (or a yes at the terminal).
 */
const ONBOARD_TIMEOUT_MS = 30 * 60_000;
/** The memory is short: an onboarding keeps at most this many new facts. */
export const MAX_SEEDED = 15;
export const ONBOARD_INSTRUCTION = "Onboard this repository as described above. Answer with a few lines: what you wrote and what you could not confirm.";

export type OnboardAgent = "claude" | "pi" | "command" | "none";

export interface OnboardLaunch {
  agent: OnboardAgent;
  label: string;
  command: string[];
  session: string;
  tools: string[];
  model?: string;
}

const WRITABLE = [MAP_NOTES_PATH, CHECKS_PATH, AGENTS_PROPOSAL_PATH, `${KNOWLEDGE_DIR}/**`];
const CLAUDE_ALLOWED = ["Read", "Grep", "Glob", ...WRITABLE.flatMap((path) => [`Edit(${path})`, `Write(${path})`]), "Bash(git log*)", "Bash(git show*)", "Bash(git diff*)", "Bash(git ls-files*)", "Bash(ways memory check*)", "Bash(npx --no-install ways memory check*)"];
const CLAUDE_DENIED = ["NotebookEdit", "WebFetch", "WebSearch", "Bash(git commit*)", "Bash(git add*)", "Bash(git push*)", "Edit(AGENTS.md)", "Write(AGENTS.md)"];
const PI_TOOLS = ["read", "grep", "find", "ls", "edit", "write"];

function guardSettings(): string {
  const command = `"$CLAUDE_PROJECT_DIR"/${AGENT_HOOK_PATH} claude PreToolUse`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash", hooks: [{ type: "command", command, timeout: 10 }] }] } });
}

/** Which agent onboards, and how it is started; nothing runs here. `none` when there is no agent to start. */
export function planOnboard(top: string, choice: string | undefined, config: Pick<HarnessConfig, "onboarder">, env: NodeJS.ProcessEnv = process.env): OnboardLaunch {
  const preset = config.onboarder;
  let agent: OnboardAgent | undefined;
  let argv: string[] | undefined;
  if (choice === "claude" || choice === "pi" || choice === "none") agent = choice;
  else if (choice !== undefined) {
    argv = tokenize(choice).filter((token) => token.kind === "word").map((token) => token.value);
    if (argv.length === 0) throw new Error(`--agent must be claude, pi, none or a command to run, got "${choice}"`);
    agent = "command";
  } else if (preset?.command) {
    agent = "command";
    argv = preset.command;
  } else agent = preset?.agent ?? (env.CLAUDECODE ? "claude" : env.PI_CODING_AGENT ? "pi" : "none");
  const model = preset?.model;
  const session = agent === "claude" ? randomUUID() : `onboard-${randomUUID().slice(0, 8)}`;
  if (agent === "none") return { agent, label: "none", command: [], session, tools: [] };
  if (agent === "command") return { agent, label: basename(argv![0]!), command: argv!, session, tools: ["whatever the command allows (ways checks what it changed afterwards)"] };
  if (agent === "pi") return { agent, label: "pi", command: ["pi", "-p", "--no-session", "--tools", PI_TOOLS.join(","), ...(model ? ["--model", model] : []), ONBOARD_INSTRUCTION], session, tools: PI_TOOLS, ...(model ? { model } : {}) };
  const command = ["claude", "-p", "--output-format", "json", "--permission-mode", "dontAsk", "--no-session-persistence", "--tools", "Read,Grep,Glob,Edit,Write,Bash", "--allowedTools", CLAUDE_ALLOWED.join(","), "--disallowedTools", CLAUDE_DENIED.join(","), ...(model ? ["--model", model] : [])];
  if (existsSync(join(top, AGENT_HOOK_PATH))) command.push("--settings", guardSettings());
  command.push("--session-id", session, ONBOARD_INSTRUCTION);
  return { agent, label: "claude", command, session, tools: CLAUDE_ALLOWED, ...(model ? { model } : {}) };
}

export async function onboarderRole(): Promise<string> {
  const role = (await loadAdapterSource()).roles.find((candidate) => candidate.name === ONBOARDER_ROLE);
  if (!role) throw new Error(`The ${ONBOARDER_ROLE} role is missing from this installation of ways (assets/adapters/roles)`);
  return role.body;
}

/** The deterministic brief: what MAP.md has, which folders have no purpose, which facts exist (and which went stale), which checks are missing. */
export async function buildOnboardBrief(top: string, options: { refresh?: boolean } = {}): Promise<{ text: string; files: number; folders: string[]; staleFacts: string[] }> {
  const files = await mapFiles(top);
  const detection = detectProject(top, files);
  const notes = readMapNotes(top);
  const folders = topFolders(files);
  const unnamed = folders.filter((folder) => !notes[folder] && !notes[folder.replace(/\/$/, "")]);
  const documents = (await inspectOkf(top, { validateSources: false })).documents;
  const staleFacts: string[] = [];
  for (const document of documents.filter(isSeeded)) if ((await changedSources(top, document, files)).length > 0) staleFacts.push(document.id);
  const checks = readChecksFile(top).checks;
  const missing = CHECK_NAMES.filter((name) => !checks[name]);
  const lines = [
    "# Onboarding brief (built by ways)",
    "",
    `Repository: ${detection.name}; ${files.length} files; stack: ${detection.stacks.map((stack) => `${stack.id} (${stack.tool})`).join(", ") || "not recognised"}. MAP.md is already generated from it: read it first and do not repeat it.`,
    "",
    `Folders without a purpose in ${MAP_NOTES_PATH}: ${unnamed.length > 0 ? unnamed.join(", ") : "none"}${Object.keys(notes).length > 0 ? `. Existing notes: ${Object.keys(notes).length} (keep them; fix only what is wrong)` : ""}.`,
    `Facts in ${KNOWLEDGE_DIR}: ${documents.length > 0 ? documents.map((document) => document.id).join(", ") : "none"}. Do not duplicate them.${options.refresh && staleFacts.length > 0 ? ` Their sources changed, check and update these: ${staleFacts.join(", ")}.` : ""}`,
    `Checks validated by ways: ${Object.keys(checks).join(", ") || "none"}. Missing: ${missing.join(", ") || "none"}; propose a command for a missing one only if you saw it used (CI, Makefile, docs).`,
    `Seed at most ${MAX_SEEDED} facts in this run (aim for 8 to 15 that matter); ways drops what fails \`ways memory check\` and keeps at most ${MAX_SEEDED}.`,
    "",
    "Fact file example (.ways/knowledge/pitfalls/money-in-cents.md):",
    "---",
    "type: pitfall",
    "title: Amounts are integer cents, never floats",
    "paths: [\"src/billing/**\"]",
    "sources:",
    "  - resource: /src/billing/money.ts",
    "  - resource: /docs/decisions/0004-money.md",
    "---",
    "Store and compute amounts as integer cents (`Money.cents`); a float sum broke invoices in #212. Convert only at the edges (`formatMoney`).",
    "",
  ];
  return { text: lines.join("\n"), files: files.length, folders: unnamed, staleFacts };
}

interface Snapshot {
  head: string | undefined;
  dirty: Map<string, string>;
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
    try {
      dirty.set(path, createHash("sha1").update(await readFile(join(top, path))).digest("hex"));
    } catch {
      dirty.set(path, "deleted");
    }
  }
  return { head, dirty };
}

/** Paths the run changed: uncommitted edits, new or deleted files, and anything it committed. */
async function changedBy(top: string, before: Snapshot, after: Snapshot): Promise<{ changed: string[]; committed: boolean }> {
  const changed = new Set<string>();
  for (const [path, hash] of after.dirty) if (before.dirty.get(path) !== hash) changed.add(path);
  for (const path of before.dirty.keys()) if (!after.dirty.has(path)) changed.add(path);
  const committed = Boolean(before.head && after.head && before.head !== after.head);
  if (committed) {
    const diff = await new GitRepository(top).run(["diff", "--name-only", "--no-renames", "-z", before.head!, after.head!, "--"]);
    for (const path of diff.split("\0").filter(Boolean)) changed.add(path);
  }
  return { changed: [...changed].sort(), committed };
}

function emit(dirs: GitDirs, launch: OnboardLaunch, type: EventType, result: EventResult, started: number, detail?: string): void {
  try {
    appendEvent(dirs, { v: 1, ts: new Date().toISOString(), session: launch.session, agent: launch.label, type, hook: "onboard", role: ONBOARDER_ROLE, worktree: dirs.top, branch: currentBranchOf(dirs) ?? null, work: readActive(dirs.top)?.id ?? null, result, ms: Date.now() - started, ...(detail ? { detail } : {}) });
  } catch {
    // Observation only.
  }
}

function finalText(launch: OnboardLaunch, stdout: string): string {
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

function shown(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

async function conceptFiles(top: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(top, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(`${dir}/${entry.name}`, `${relative}/`);
      else if (entry.name.endsWith(".md") && entry.name !== "index.md" && entry.name !== "log.md") found.push(`${KNOWLEDGE_DIR}/${relative}`);
    }
  };
  await walk(KNOWLEDGE_DIR, "");
  return found.sort();
}

export interface OnboardOptions {
  agent?: string;
  yes?: boolean;
  refresh?: boolean;
  dryRun?: boolean;
  /** Asks the human at a terminal; resolves to their answer. */
  confirm?: (question: string) => Promise<boolean>;
}

export interface OnboardResult {
  status: "done" | "pending" | "failed" | "needs-consent" | "up-to-date" | "dry-run";
  exitCode: number;
  summary?: OnboardingSummary;
  lines: string[];
  strays?: string[];
}

/**
 * Notes the onboarder wrote, kept only for paths that exist and as one line
 * each; MAP.md is regenerated from them.
 */
async function tidyNotes(top: string): Promise<{ kept: number; dropped: string[] }> {
  const raw = readMapNotes(top);
  const files = await mapFiles(top);
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) folders.add(`${parts.slice(0, depth).join("/")}/`);
  }
  const notes: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [path, note] of Object.entries(raw)) {
    const key = normalizeNotePath(path, folders);
    if (folders.has(key) || files.includes(key)) notes[key] = note.length > 160 ? `${note.slice(0, 159)}…` : note;
    else dropped.push(path);
  }
  if (Object.keys(raw).length > 0 || existsSync(join(top, MAP_NOTES_PATH))) writeMapNotes(top, notes);
  return { kept: Object.keys(notes).length, dropped };
}

/** Facts the run added: stamped, and dropped (with the reason) when ways cannot use them or there are too many. */
async function settleFacts(top: string, added: readonly string[], fresh: ReadonlySet<string>): Promise<{ kept: string[]; dropped: string[] }> {
  const dropped: string[] = [];
  // Only a file the run created is ever deleted; an existing fact it edited and broke is reported instead.
  const drop = async (path: string, why: string): Promise<void> => {
    if (fresh.has(path)) {
      await rm(join(top, path), { force: true });
      dropped.push(`${path} (${why})`);
    } else dropped.push(`${path} was edited and is now invalid, left for the human to fix (${why})`);
  };
  const candidates = [...added].sort();
  const extra = candidates.filter((path) => fresh.has(path)).slice(MAX_SEEDED);
  for (const path of extra) await drop(path, `more than ${MAX_SEEDED} facts in one onboarding: the memory is short`);
  const kept: string[] = [];
  for (const path of candidates.filter((candidate) => !extra.includes(candidate))) {
    try {
      await stampSeeded(top, path);
      kept.push(path);
    } catch (error) {
      await drop(path, error instanceof Error ? error.message : String(error));
    }
  }
  // What `ways memory check` refuses in a seeded fact is dropped: no sources, sources or paths that name nothing, bad frontmatter.
  const check = await checkMemory(top);
  for (const issue of check.issues) {
    const path = `${KNOWLEDGE_DIR}/${issue.path.split("#")[0]}`;
    if (!kept.includes(path)) continue;
    kept.splice(kept.indexOf(path), 1);
    await drop(path, issue.message);
  }
  return { kept, dropped };
}

export async function onboard(cwd: string, options: OnboardOptions = {}, say: (line: string) => void = console.log): Promise<OnboardResult> {
  const dirs = gitDirs(cwd);
  const top = dirs.top;
  const config = await loadConfig(top);
  const lines: string[] = [];
  const out = (line: string): void => {
    lines.push(line);
    say(line);
  };
  const state = readOnboarding(top);
  if (state?.status === "done" && !options.refresh && !options.dryRun) {
    out("This repository is already onboarded (.ways/onboarding.json). `ways onboard --refresh` updates stale facts and missing folder purposes.");
    return { status: "up-to-date", exitCode: 0, lines };
  }
  const launch = planOnboard(top, options.agent, config);
  const brief = await buildOnboardBrief(top, { refresh: options.refresh ?? false });
  const prompt = `${await onboarderRole()}\n\n${brief.text}`;
  if (options.dryRun) {
    out(prompt.trimEnd());
    out("");
    out(launch.agent === "none" ? "# No agent would be started (none found): only the deterministic part would run." : `# Would run (the prompt above goes on stdin; environment WAYS_ROLE=${ONBOARDER_ROLE}):\n${launch.command.map(shown).join(" ")}`);
    return { status: "dry-run", exitCode: 0, lines };
  }

  // Consent first, before anything runs: an agent spends the human's quota.
  if (launch.agent !== "none" && onboardingPolicy(top) !== "auto" && !options.yes) {
    const question = `ways onboard will start ${launch.label}${launch.model ? ` (model ${launch.model})` : ""}, which may read the ${brief.files} files of this repository and its history and write only MAP notes, memory, proposed checks and an AGENTS.md proposal; it spends your agent quota and usually takes a few minutes. Start it?`;
    const agreed = options.confirm ? await options.confirm(question) : false;
    if (!agreed) {
      out(question.replace(/ Start it\?$/, ""));
      out("Not started: it needs the human's yes. Ask them (`ways ask \"Run ways onboard now?\" --options=yes,no`), then run `ways onboard --yes`; or set \"onboarding\": \"auto\" (or \"off\") in .ways/config.json. `--agent=none` runs only the part that needs no agent.");
      return { status: "needs-consent", exitCode: 2, lines };
    }
  }

  // The deterministic part: it needs no agent.
  await writeMap(top);
  const configured = new Set(Object.keys(readChecksFile(top).checks));
  const detected = detectedCandidates(detectProject(top, await mapFiles(top)).candidates).filter((candidate) => !configured.has(candidate.name));
  const rejected: Rejected[] = [];
  const accepted: string[] = [];
  const validate = async (candidates: Candidate[], what: string): Promise<void> => {
    if (candidates.length === 0) return;
    out(`Running ${what} once each to validate them…`);
    const validation = await validateCandidates(dirs, candidates, { onRun: (candidate) => out(`  running ${candidate.name}: ${candidate.command.join(" ")}`) });
    for (const line of describeValidation(validation)) out(line);
    await recordChecks(top, validation.accepted);
    accepted.push(...validation.accepted.map((entry) => entry.name));
    rejected.push(...validation.rejected);
  };
  await validate(detected, "the detected checks that are not configured yet");

  const missing: string[] = [];
  let agentLines = "";
  let facts: string[] = [];
  let droppedFacts: string[] = [];
  let notes = { kept: Object.keys(readMapNotes(top)).length, dropped: [] as string[] };
  let proposal = false;
  if (launch.agent === "none") {
    missing.push("no agent was found to write folder purposes and facts: run `ways onboard --agent=claude` (or pi, or \"<command>\") from a shell where it is installed");
  } else {
    const started = Date.now();
    const before = await snapshot(top);
    const factsBefore = new Set(await conceptFiles(top));
    out(`Launching the onboarder (${launch.label}); it may write only ${WRITABLE.join(", ")}. This can take a few minutes.`);
    emit(dirs, launch, "session.started", "ok", started, options.refresh ? "onboard --refresh" : "onboard");
    let output;
    try {
      output = await runWithInput(launch.command, top, prompt, {
        timeoutMs: ONBOARD_TIMEOUT_MS,
        env: { ...process.env, WAYS_ROLE: ONBOARDER_ROLE, WAYS_SESSION: launch.session, WAYS_AGENT: launch.label },
        unavailable: (error, program) => new Error(`Cannot start the onboarder \`${program}\`: ${error.message}. Install it, choose another with \`ways onboard --agent=claude|pi|"<command>"\`, or \`--agent=none\` for the deterministic part only`),
      });
    } catch (error) {
      emit(dirs, launch, "session.ended", "error", started, "cannot start");
      throw error;
    }
    const after = await snapshot(top);
    const { changed, committed } = await changedBy(top, before, after);
    const strays = changed.filter((path) => !isOnboarderPath(path));
    if (strays.length > 0 || committed) {
      emit(dirs, launch, "session.ended", "refused", started, "outside its paths");
      out(`The onboarder ${committed ? "committed, which it may not do, and " : ""}changed files outside what it may write:`);
      for (const path of strays) out(`  ${path}`);
      out("Onboarding is not marked done and nothing it wrote was stamped. Look with `git status`; undo with `git restore -- <path>` (and delete new files), then run `ways onboard` again.");
      return { status: "failed", exitCode: 1, lines, strays };
    }
    if (output.code !== 0) {
      emit(dirs, launch, "session.ended", "error", started, `exit ${output.code ?? "signal"}`);
      const tail = `${output.stdout}\n${output.stderr}`.trim().split("\n").slice(-8).join("\n");
      out(`The onboarder (${launch.label}) exited ${output.code ?? "by a signal"}; onboarding is not marked done. Its last output:\n${tail || "(none)"}`);
      return { status: "failed", exitCode: 1, lines };
    }
    agentLines = finalText(launch, output.stdout);
    notes = await tidyNotes(top);
    const now = await conceptFiles(top);
    const added = now.filter((path) => !factsBefore.has(path) || changed.includes(path));
    ({ kept: facts, dropped: droppedFacts } = await settleFacts(top, added, new Set(now.filter((path) => !factsBefore.has(path)))));
    // Proposed checks: run each; only what works is written.
    const file = readChecksFile(top);
    const proposals = Object.entries(file.proposed ?? {}).map(([name, entry]) => ({ name: name as CheckName, command: entry!.command, source: "proposed by the onboarder" }));
    if (file.proposed) {
      delete file.proposed;
      writeChecksFile(top, file);
    }
    await validate(proposals.filter((candidate) => !accepted.includes(candidate.name)), "the checks the onboarder proposed");
    if (existsSync(join(top, AGENTS_PROPOSAL_PATH))) {
      const text = (await readFile(join(top, AGENTS_PROPOSAL_PATH), "utf8")).trim();
      if (text && existsSync(join(top, "AGENTS.md"))) {
        const current = await readFile(join(top, "AGENTS.md"), "utf8");
        const next = withProposal(current, text.replaceAll(PROPOSAL_START, "").replaceAll(PROPOSAL_END, ""));
        if (next.split("\n").length > 100) missing.push(`the AGENTS.md proposal would make it longer than 100 lines; it is left in ${AGENTS_PROPOSAL_PATH} for the human`);
        else {
          await writeAtomic(join(top, "AGENTS.md"), next);
          await rm(join(top, AGENTS_PROPOSAL_PATH), { force: true });
          proposal = true;
        }
      }
    }
    emit(dirs, launch, "session.ended", "ok", started, `${facts.length} fact(s), ${notes.kept} note(s)`);
  }

  // Everything the layers depend on must validate before onboarding is done.
  await writeMap(top);
  const { syncRules } = await import("../context/rules.js");
  await syncRules(top);
  const memory = await checkMemory(top);
  const map = await writeMap(top, { check: true });
  if (memory.issues.length > 0) missing.push(`the memory has ${memory.issues.length} problem(s): \`ways memory check\``);
  if (map.drift.reasons.length > 0) missing.push(`MAP.md: ${map.drift.reasons.join("; ")}`);
  const documents: OkfDocument[] = (await inspectOkf(top, { validateSources: false })).documents;
  const unverified = documents.filter((document) => isSeeded(document) && !document.frontmatter.verified).map((document) => document.id);
  const summary: OnboardingSummary = {
    agent: launch.label,
    mapNotes: notes.kept,
    facts: facts.map((path) => path.slice(KNOWLEDGE_DIR.length + 1).replace(/\.md$/, "")),
    unverified,
    checks: Object.keys(readChecksFile(top).checks),
    rejected: rejected.map((entry) => ({ check: entry.name, command: entry.command, reason: entry.reason })),
    missing: [...missing, ...droppedFacts.map((entry) => `fact dropped: ${entry}`), ...notes.dropped.map((path) => `note dropped (no such path): ${path}`)],
    agentsProposal: proposal,
  };
  const done = launch.agent !== "none" && memory.issues.length === 0 && map.drift.reasons.length === 0;
  writeOnboarding(top, { schemaVersion: 1, status: done ? "done" : "pending", at: new Date().toISOString(), summary });
  if (agentLines) out(agentLines.split("\n").slice(0, 30).join("\n"));
  out(`MAP.md: ${summary.mapNotes} folder purpose(s). Memory: ${summary.facts.length} new fact(s), ${unverified.length} unverified (a person confirms each with \`ways memory confirm <id>\`). Checks: ${summary.checks.join(", ") || "none"}${rejected.length > 0 ? `; rejected: ${rejected.map((entry) => entry.name).join(", ")}` : ""}.${proposal ? " AGENTS.md: a proposal in its marked block." : ""}`);
  for (const entry of summary.missing) out(`  not done: ${entry}`);
  out(done ? "Onboarding done (.ways/onboarding.json). Review the diff (MAP.md, .ways/, AGENTS.md) and commit it." : "Onboarding is still pending: see what is not done above.");
  return { status: done ? "done" : "pending", exitCode: 0, summary, lines };
}
