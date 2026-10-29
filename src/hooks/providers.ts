/**
 * The thin layer between `ways hook <event>` and each agent's hook contract:
 * what comes in on stdin and what goes out on stdout. Everything else in the
 * agent hook is provider-neutral. tests/agent-hook-contract.test.ts pins both
 * directions with fixtures of real payloads.
 *
 * Claude Code (code.claude.com/docs/en/hooks, read 2026-10-29): JSON on stdin
 * with `session_id`, `cwd`, `hook_event_name` and per-event fields (`source`,
 * `prompt`, `tool_name`, `tool_input`, `tool_response`, `stop_hook_active`,
 * `reason`; inside a subagent also `agent_id` and `agent_type`; SubagentStop
 * adds `last_assistant_message`). Exit 0 with JSON on stdout:
 * `hookSpecificOutput.additionalContext` (SessionStart, UserPromptSubmit,
 * PreToolUse, PostToolUse, SubagentStart; capped by Claude Code at 10,000
 * characters; on PreToolUse ways uses it only for the one `ways run` hint),
 * `hookSpecificOutput.permissionDecision: "deny"` with
 * `permissionDecisionReason` (PreToolUse), top-level `decision: "block"` with
 * `reason` (Stop and SubagentStop: the agent continues with the reason) and
 * `systemMessage` (shown to the user). Empty stdout means nothing to say.
 *
 * pi has no command hooks: the ways extension (`.pi/extensions/ways`) maps
 * pi events onto these names, sends the same snake_case payload, and applies
 * the small JSON answer `formatOutput` gives for `pi`.
 *
 * Codex and Cursor are best effort: Codex documents Claude-compatible hook
 * payloads and outputs, and Cursor runs Claude Code's project hooks, so both
 * get the Claude format. Neither is installed by default.
 */
export const AGENT_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd", "SubagentStart", "SubagentStop"] as const;
export type AgentEvent = (typeof AGENT_EVENTS)[number];

export const AGENT_IDS = ["claude", "pi", "codex", "cursor"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentEvent(value: string): value is AgentEvent {
  return (AGENT_EVENTS as readonly string[]).includes(value);
}

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export interface HookPayload {
  session: string;
  cwd?: string;
  /** SessionStart: startup, resume, clear, compact (Claude); startup, reload, new, resume, fork (pi). */
  source?: string;
  /** Length only: prompts are never stored. */
  promptChars?: number;
  tool?: string;
  toolInput?: unknown;
  toolFailed?: boolean;
  /** Stop: the agent is already continuing because of a stop hook. */
  stopActive: boolean;
  /** SessionEnd reason. */
  reason?: string;
  /** Claude Code: the subagent a tool call or SubagentStart/Stop belongs to. */
  agentId?: string;
  agentType?: string;
  /** SubagentStop: the subagent's final answer. Read for the reviewer's verdict, never logged. */
  lastMessage?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads a provider payload; tolerant of missing fields, never throws on shape. */
export function normalizePayload(value: unknown): HookPayload {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response as Record<string, unknown> : undefined;
  const payload: HookPayload = { session: text(input.session_id) ?? text(input.sessionId) ?? "unknown", stopActive: input.stop_hook_active === true };
  const cwd = text(input.cwd);
  if (cwd) payload.cwd = cwd;
  const source = text(input.source);
  if (source) payload.source = source;
  if (typeof input.prompt === "string") payload.promptChars = input.prompt.length;
  const tool = text(input.tool_name);
  if (tool) payload.tool = tool;
  if (input.tool_input !== undefined) payload.toolInput = input.tool_input;
  if (input.is_error === true || response?.is_error === true || response?.success === false || response?.interrupted === true) payload.toolFailed = true;
  const reason = text(input.reason);
  if (reason) payload.reason = reason;
  const agentId = text(input.agent_id);
  if (agentId) payload.agentId = agentId;
  const agentType = text(input.agent_type);
  if (agentType) payload.agentType = agentType;
  if (typeof input.last_assistant_message === "string") payload.lastMessage = input.last_assistant_message;
  return payload;
}

/** What ways decided, provider-neutral. */
export interface HookDecision {
  /** Context for the model. */
  context?: string;
  /** PreToolUse: refuse the call with this reason (shown to the model). */
  deny?: string;
  /** Stop: keep the agent going once, with this reason. */
  remind?: string;
  /** Shown to the human, not the model. */
  notify?: string;
}

export function isEmpty(decision: HookDecision): boolean {
  return !decision.context && !decision.deny && !decision.remind && !decision.notify;
}

/** The stdout the agent expects; empty when there is nothing to say. */
export function formatOutput(agent: AgentId, event: AgentEvent, decision: HookDecision): string {
  if (isEmpty(decision)) return "";
  if (agent === "pi") {
    const out: Record<string, string> = {};
    if (decision.context) out.context = decision.context;
    if (decision.deny) out.block = decision.deny;
    if (decision.remind) out.message = decision.remind;
    if (decision.notify) out.notify = decision.notify;
    return `${JSON.stringify(out)}\n`;
  }
  const out: Record<string, unknown> = {};
  if (event === "PreToolUse" && decision.deny) {
    out.hookSpecificOutput = { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: decision.deny };
  } else if (decision.context && (event === "SessionStart" || event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse" || event === "SubagentStart")) {
    out.hookSpecificOutput = { hookEventName: event, additionalContext: decision.context };
  }
  if ((event === "Stop" || event === "SubagentStop") && decision.remind) {
    out.decision = "block";
    out.reason = decision.remind;
  }
  if (decision.notify) out.systemMessage = decision.notify;
  return Object.keys(out).length > 0 ? `${JSON.stringify(out)}\n` : "";
}
