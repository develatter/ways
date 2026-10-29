import { AGENT_HOOK_PATH } from "../domain/constants.js";
import { renderAgentSkill, resolveWith, SLASH_NAMES, yamlFrontmatter } from "./render.js";
import type { AdapterSource, ProviderAdapter, RenderedFile } from "./types.js";

/**
 * pi coding agent (`@earendil-works/pi-coding-agent`). Per the upstream docs
 * (1.4.0, read 2026-10-29): optional procedures become Agent Skills in
 * `.agents/skills/<name>/SKILL.md` (pi reads that directory; shared with
 * Codex), roles become `.pi/agents/<name>.md` for the subagent extension with
 * a `tools` restriction for read roles, and a project extension in
 * `.pi/extensions/ways/index.ts` shows the active work in the status bar and
 * connects pi's events to `ways hook` (pi has no command hooks):
 *
 *   session_start       → SessionStart      context kept for the first prompt
 *   before_agent_start  → UserPromptSubmit  returns { message } (hidden custom message)
 *   tool_call           → PreToolUse        returns { block: true, reason } when refused
 *   tool_result         → PostToolUse       appends the memory of the touched files
 *   agent_end           → Stop              sendMessage(..., { triggerTurn: true }) once
 *   session_shutdown    → SessionEnd
 *
 * pi has no path-scoped rules, so memory reaches it through tool results.
 * pi reads `AGENTS.md`. Project resources load only once the project is trusted.
 */
export const PI_DIR = ".pi";
const READ_TOOLS = "read, grep, find, ls";

export const PI_EXTENSION = `// Managed by ways. Shows the active ways work in pi's status bar and connects pi's
// events to the ways agent hooks (${AGENT_HOOK_PATH} pi <event>): what is in play before
// each prompt, the guard on tool calls, the memory of the files a tool touches, and a
// one-time note of what still blocks the work. Without ways installed it does nothing.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface WaysAnswer { context?: string; block?: string; message?: string; notify?: string }
interface Ctx { cwd?: string; hasUI?: boolean; ui?: { setStatus?(key: string, text: string): void; notify?(message: string, level?: string): void }; sessionManager?: { getSessionId?(): string } }

const roots = new Map<string, string | undefined>();
const FILE_TOOLS = new Set(["read", "edit", "write"]);

function gitRoot(cwd: string): string | undefined {
  if (!roots.has(cwd)) {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
    roots.set(cwd, top.status === 0 ? top.stdout.trim() : undefined);
  }
  return roots.get(cwd);
}

function waysStatus(cwd: string): string {
  const dirs = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (dirs.status !== 0) return "";
  for (const dir of dirs.stdout.trim().split("\\n")) {
    try {
      const active = JSON.parse(readFileSync(join(dir, "ways", "active.json"), "utf8")) as { id?: string; kind?: string };
      if (active.id) return \`ways: \${active.kind ?? "work"} \${active.id}\`;
    } catch {
      // No active work recorded in this Git directory.
    }
  }
  return "ways: idle";
}

/** Runs one ways agent hook; any failure means "nothing to say". */
export function waysHook(cwd: string, event: string, payload: Record<string, unknown>): Promise<WaysAnswer> {
  const top = gitRoot(cwd);
  const script = top ? join(top, "${AGENT_HOOK_PATH}") : "";
  if (!top || !existsSync(script)) return Promise.resolve({});
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("sh", [script, "pi", event], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve({}); });
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(out.trim() ? JSON.parse(out) as WaysAnswer : {}); } catch { resolve({}); }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ ...payload, cwd, hook_event_name: event }));
  });
}

function sessionOf(ctx: Ctx): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "unknown";
  } catch {
    return "unknown";
  }
}

export default function (pi: ExtensionAPI) {
  let pending = "";
  const on = pi.on.bind(pi) as unknown as (event: string, handler: (event: any, ctx: Ctx) => unknown) => void;
  const cwdOf = (ctx: Ctx): string => ctx.cwd ?? process.cwd();
  const refresh = (ctx: Ctx): void => {
    if (ctx.hasUI) ctx.ui?.setStatus?.("ways", waysStatus(cwdOf(ctx)));
  };
  on("session_start", async (event, ctx) => {
    refresh(ctx);
    pending = (await waysHook(cwdOf(ctx), "SessionStart", { session_id: sessionOf(ctx), source: event?.reason })).context ?? "";
  });
  on("turn_start", async (_event, ctx) => refresh(ctx));
  on("before_agent_start", async (event, ctx) => {
    const answer = await waysHook(cwdOf(ctx), "UserPromptSubmit", { session_id: sessionOf(ctx), prompt: typeof event?.prompt === "string" ? event.prompt : "" });
    const context = [pending, answer.context ?? ""].filter(Boolean).join("\\n\\n");
    pending = "";
    return context ? { message: { customType: "ways", content: context, display: false } } : undefined;
  });
  on("tool_call", async (event, ctx) => {
    // The guard only judges calls that could touch a work record or switch the commit hooks off.
    if (!/\\.ways|WAYS_DISABLE|hookspath/i.test(JSON.stringify(event?.input ?? ""))) return undefined;
    const answer = await waysHook(cwdOf(ctx), "PreToolUse", { session_id: sessionOf(ctx), tool_name: event?.toolName, tool_input: event?.input, tool_use_id: event?.toolCallId });
    return answer.block ? { block: true, reason: answer.block } : undefined;
  });
  on("tool_result", async (event, ctx) => {
    refresh(ctx);
    // Memory and the event log are about files: other tools cost nothing.
    if (!FILE_TOOLS.has(String(event?.toolName))) return undefined;
    const answer = await waysHook(cwdOf(ctx), "PostToolUse", { session_id: sessionOf(ctx), tool_name: event?.toolName, tool_input: event?.input, tool_use_id: event?.toolCallId, is_error: event?.isError === true });
    if (!answer.context || !Array.isArray(event?.content)) return undefined;
    return { content: [...event.content, { type: "text", text: answer.context }] };
  });
  on("agent_end", async (_event, ctx) => {
    const answer = await waysHook(cwdOf(ctx), "Stop", { session_id: sessionOf(ctx) });
    if (answer.notify && ctx.hasUI) ctx.ui?.notify?.(answer.notify, "warning");
    if (answer.message) pi.sendMessage({ customType: "ways", content: answer.message, display: true }, { triggerTurn: true });
  });
  on("session_shutdown", async (event, ctx) => {
    await waysHook(cwdOf(ctx), "SessionEnd", { session_id: sessionOf(ctx), reason: event?.reason });
  });
}
`;

export function renderPi(source: AdapterSource): RenderedFile[] {
  const files: RenderedFile[] = [];
  for (const command of source.commands) files.push(renderAgentSkill(command));
  for (const role of source.roles) {
    const front = yamlFrontmatter([["name", `ways-${role.name}`], ["description", role.description], ["tools", role.access === "read" ? READ_TOOLS : undefined]]);
    files.push({ path: `${PI_DIR}/agents/ways-${role.name}.md`, content: `${front}\n${resolveWith(role.body, SLASH_NAMES)}\n` });
  }
  files.push({ path: `${PI_DIR}/extensions/ways/index.ts`, content: PI_EXTENSION });
  return files;
}

export const piAdapter: ProviderAdapter = {
  id: "pi",
  tier: "default",
  render: renderPi,
};
