import { readFileSync } from "node:fs";
import type { BriefSection, SectionId } from "../context/brief.js";
import { CONFIG_PATH } from "../domain/constants.js";
import type { Enforcement } from "../domain/types.js";
import { appendEvent, pruneEvents, readRecentSessionEvents, type EventResult, type EventType, type WaysEvent } from "../events/bus.js";
import { currentBranchOf, gitDirs, readActive, type GitDirs } from "../runtime/runtime.js";
import { guard, toolPaths } from "./guard.js";
import { formatOutput, normalizePayload, type AgentEvent, type AgentId, type HookDecision, type HookPayload } from "./providers.js";
import { digest, readSession, writeSession, type SessionState } from "./session.js";

/**
 * `ways hook <event> --agent=<id>`: the coding-agent hooks. One process per
 * event, so it loads only Node built-ins and small modules; the brief and the
 * memory cache avoid git and yaml unless the repository changed.
 *
 * It never breaks a session: any internal error is logged as a `hook.error`
 * event and the hook answers nothing with exit 0. The only refusal is the
 * PreToolUse guard's, for what would break a guarantee.
 */
export interface AgentHookResult {
  stdout: string;
  exitCode: 0;
}

/** `WAYS_PROFILE=1` prints milliseconds since process start at each phase, on stderr (never seen by the agent). */
const PROFILE = process.env.WAYS_PROFILE === "1";

export function mark(phase: string): void {
  if (PROFILE) process.stderr.write(`ways profile ${performance.now().toFixed(1)} ms ${phase}\n`);
}

/** Agents whose own path-scoped rules (`.claude/rules`) already load memory when a file is read or edited. */
const PATH_RULES: ReadonlySet<AgentId> = new Set(["claude", "cursor"]);
const MAX_TOUCHED = 64;
const MEMORY_PER_TOOL = 3;

function enforcementOf(top: string): Enforcement | undefined {
  try {
    const config = JSON.parse(readFileSync(`${top}/${CONFIG_PATH}`, "utf8")) as { enforcement?: unknown };
    return config.enforcement === "enforce" ? "enforce" : "observe";
  } catch {
    return undefined;
  }
}

/** Paths the session's tool calls named, most recent first. */
function touchedPaths(dirs: GitDirs, session: string): string[] {
  const seen = new Set<string>();
  const events = readRecentSessionEvents(dirs, session);
  for (let index = events.length - 1; index >= 0 && seen.size < MAX_TOUCHED; index -= 1) {
    const event = events[index]!;
    if (event.worktree !== dirs.top || (event.type !== "tool.started" && event.type !== "tool.finished")) continue;
    for (const path of event.paths ?? []) seen.add(path);
  }
  return [...seen];
}

const CLEARED: Record<string, string> = {
  problem: "Problem: resolved.",
  work: "Work: none active now (closed or cancelled).",
  failing: "Failing: nothing (the last `ways done` passed or the work changed).",
  waiting: "Waiting on: nothing.",
  next: "Next: nothing pending from ways.",
};

/**
 * The brief, whole (SessionStart) or only what changed since this session last
 * heard it (UserPromptSubmit). Memory facts are injected once per session.
 */
async function contextFor(dirs: GitDirs, payload: HookPayload, state: SessionState, full: boolean): Promise<string | undefined> {
  const { buildBrief, renderSections } = await import("../context/brief.js");
  mark("brief module loaded");
  const brief = await buildBrief(dirs, { touched: touchedPaths(dirs, payload.session) });
  mark("brief built");
  if (!brief.installed) return undefined;
  const sections = brief.sections.filter((section) => {
    if (section.id.startsWith("memory:")) return !state.memory.includes(section.id.slice("memory:".length));
    return full || state.sections[section.id] !== digest(section.text);
  });
  const present = new Set<string>(brief.sections.map((section) => section.id));
  const cleared: BriefSection[] = full ? [] : Object.keys(state.sections).filter((id) => !present.has(id) && CLEARED[id]).map((id) => ({ id: id as SectionId, text: CLEARED[id]! }));
  const text = renderSections([...cleared, ...sections]);
  const next: Record<string, string> = {};
  for (const section of brief.sections) if (!section.id.startsWith("memory:")) next[section.id] = digest(section.text);
  state.sections = next;
  for (const section of sections) {
    // Only what fitted in the budget counts as told.
    if (section.id.startsWith("memory:") && text.includes(section.text)) state.memory.push(section.id.slice("memory:".length));
  }
  return text || undefined;
}

/** Memory for the paths a tool call just named, for agents without path rules. */
async function memoryForTool(dirs: GitDirs, paths: readonly string[], state: SessionState): Promise<string | undefined> {
  if (paths.length === 0) return undefined;
  const { loadMemory } = await import("../context/memory.js");
  const { relevantMemory, renderMemory } = await import("../context/brief.js");
  const fresh = relevantMemory(await loadMemory(dirs), { touched: paths, uncommitted: [], changed: [] }, Number.POSITIVE_INFINITY)
    .filter((concept) => !state.memory.includes(concept.path)).slice(0, MEMORY_PER_TOOL);
  if (fresh.length === 0) return undefined;
  for (const concept of fresh) state.memory.push(concept.path);
  return [`ways memory for ${paths.join(", ")}:`, ...fresh.map(renderMemory)].join("\n");
}

async function stopReminder(dirs: GitDirs, payload: HookPayload, state: SessionState): Promise<HookDecision> {
  if (payload.stopActive) return {};
  const { buildBrief } = await import("../context/brief.js");
  const brief = await buildBrief(dirs);
  const fresh = brief.blockers.filter((blocker) => !state.reminded.includes(blocker.key));
  if (fresh.length === 0) return {};
  state.reminded.push(...fresh.map((blocker) => blocker.key));
  const agent = fresh.filter((blocker) => blocker.who === "agent");
  const human = fresh.filter((blocker) => blocker.who === "human");
  const decision: HookDecision = {};
  if (agent.length > 0) decision.remind = `ways (said once): ${agent.map((blocker) => blocker.text).join("; ")}.${brief.next ? ` Next: ${brief.next}.` : ""} If you are stopping on purpose, say so to the human.`;
  if (human.length > 0) decision.notify = `ways: ${human.map((blocker) => blocker.text).join("; ")}.`;
  return decision;
}

const TYPES: Record<AgentEvent, EventType> = {
  SessionStart: "session.started",
  UserPromptSubmit: "prompt.submitted",
  PreToolUse: "tool.started",
  PostToolUse: "tool.finished",
  Stop: "agent.stopped",
  SessionEnd: "session.ended",
};

export async function runAgentHook(event: AgentEvent, agent: AgentId, stdin: string, cwd: string): Promise<AgentHookResult> {
  const started = performance.now();
  mark(`${event} start`);
  let dirs: GitDirs | undefined;
  let payload: HookPayload = { session: "unknown", stopActive: false };
  let base: Omit<WaysEvent, "result" | "ms" | "ts"> | undefined;
  try {
    payload = normalizePayload(stdin.trim() ? JSON.parse(stdin) : {});
    try {
      dirs = gitDirs(payload.cwd ?? cwd);
    } catch {
      return { stdout: "", exitCode: 0 };
    }
    const enforcement = enforcementOf(dirs.top);
    // ways is not installed in this repository: say nothing, log nothing.
    if (!enforcement) return { stdout: "", exitCode: 0 };
    base = {
      v: 1,
      session: payload.session,
      agent,
      type: TYPES[event],
      hook: event,
      worktree: dirs.top,
      branch: currentBranchOf(dirs) ?? null,
      work: readActive(dirs.top)?.id ?? null,
      ...(payload.tool ? { tool: payload.tool } : {}),
    };
    const state = readSession(dirs, payload.session, agent, dirs.top);
    let decision: HookDecision = {};
    let result: EventResult = "ok";
    let paths: string[] = [];
    let detail: string | undefined;
    let save = false;
    if (event === "SessionStart") {
      pruneEvents(dirs);
      state.sections = {};
      state.memory = [];
      const context = await contextFor(dirs, payload, state, true);
      if (context) decision.context = context;
      detail = payload.source;
      save = true;
    } else if (event === "UserPromptSubmit") {
      const context = await contextFor(dirs, payload, state, false);
      if (context) decision.context = context;
      save = true;
    } else if (event === "PreToolUse") {
      const verdict = guard({ tool: payload.tool ?? "", toolInput: payload.toolInput, top: dirs.top, cwd: payload.cwd ?? cwd, enforcement });
      paths = verdict.paths;
      if (verdict.deny) {
        decision.deny = verdict.deny;
        result = "denied";
        detail = verdict.code;
        base.type = "tool.denied";
      }
    } else if (event === "PostToolUse") {
      paths = toolPaths(payload.toolInput, dirs.top, payload.cwd ?? cwd);
      if (payload.toolFailed) result = "error";
      if (!PATH_RULES.has(agent)) {
        const context = await memoryForTool(dirs, paths, state);
        if (context) {
          decision.context = context;
          save = true;
        }
      }
    } else if (event === "Stop") {
      decision = await stopReminder(dirs, payload, state);
      save = decision.remind !== undefined || decision.notify !== undefined;
    } else if (event === "SessionEnd") {
      detail = payload.reason;
    }
    if (save) writeSession(dirs, state);
    const injected = (decision.context ?? "").length + (decision.remind ?? "").length;
    if (result === "ok") result = decision.remind || decision.notify ? "reminded" : decision.context ? "injected" : event === "SessionStart" || event === "UserPromptSubmit" ? "silent" : "ok";
    appendEvent(dirs, { ...base, ts: new Date().toISOString(), result, ms: Math.round(performance.now() - started), ...(paths.length > 0 ? { paths } : {}), ...(detail ? { detail } : {}), ...(injected > 0 ? { chars: injected } : {}) });
    mark(`${event} done`);
    return { stdout: formatOutput(agent, event, decision), exitCode: 0 };
  } catch (error) {
    try {
      if (dirs) {
        appendEvent(dirs, {
          ...(base ?? { v: 1, session: payload.session, agent, hook: event, worktree: dirs.top, branch: null, work: null }),
          type: "hook.error",
          ts: new Date().toISOString(),
          result: "error",
          detail: error instanceof Error ? error.message : String(error),
          ms: Math.round(performance.now() - started),
        } as WaysEvent);
      }
    } catch {
      // Even the log failed: still never break the session.
    }
    return { stdout: "", exitCode: 0 };
  }
}
