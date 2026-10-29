import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_MD_CONTENT, CLAUDE_MD_PATH, withAgentsImport } from "../bootstrap/claude-md.js";
import { AGENT_HOOK_PATH } from "../domain/constants.js";
import { stableJson, writeAtomic } from "../fs/files.js";
import { isWaysGuardEntry } from "./hook-file.js";
import { resolveWith, SLASH_NAMES } from "./render.js";
import type { AdapterIssue, AdapterSource, MergeResult, ProviderAdapter, RenderedFile } from "./types.js";

/**
 * Claude Code: optional procedures as skills in `.claude/skills/` (Claude Code
 * merged commands into skills and does not read `.agents/skills`), roles as
 * subagents in `.claude/agents/` (read roles get read-only tools), and in
 * `.claude/settings.json` a status line and the agent hooks: every event runs
 * `.ways/hooks/agent-hook claude <event>`. Path-scoped memory rules are
 * written to `.claude/rules/` (see src/context/rules.ts). Claude Code reads
 * `CLAUDE.md`, which bootstrap makes import `AGENTS.md`.
 */
export const CLAUDE_DIR = ".claude";
const STATUSLINE_PATH = `${CLAUDE_DIR}/ways-statusline.sh`;
const SETTINGS_PATH = `${CLAUDE_DIR}/settings.json`;
const READ_TOOLS = "Read, Grep, Glob, Bash";

function frontmatter(entries: Array<[string, string | undefined]>): string {
  const lines = entries.filter((entry): entry is [string, string] => Boolean(entry[1])).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Resolves neutral `{{command:x}}` and `{{role:x}}` placeholders into Claude names. */
export function resolveNames(text: string): string {
  return resolveWith(text, SLASH_NAMES);
}

/** Tools the guard looks at (writes and the shell) and those whose paths are logged (writes). */
const GUARDED_TOOLS = "Write|Edit|MultiEdit|NotebookEdit|Bash";
const WRITE_TOOLS = "Write|Edit|MultiEdit|NotebookEdit";
const HOOK_TIMEOUT_SECONDS = 10;

function hookGroup(event: string, matcher?: string): Settings {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: `"$CLAUDE_PROJECT_DIR"/${AGENT_HOOK_PATH} claude ${event}`, timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

/** The hook groups ways adds to `.claude/settings.json`, by event. */
export const CLAUDE_HOOKS: Readonly<Record<string, Settings[]>> = {
  SessionStart: [hookGroup("SessionStart")],
  UserPromptSubmit: [hookGroup("UserPromptSubmit")],
  PreToolUse: [hookGroup("PreToolUse", GUARDED_TOOLS)],
  PostToolUse: [hookGroup("PostToolUse", WRITE_TOOLS)],
  Stop: [hookGroup("Stop")],
  SessionEnd: [hookGroup("SessionEnd")],
};

/** A hook group whose every command is the ways agent hook. */
export function isWaysAgentGroup(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) return false;
  return group.hooks.every((hook) => isObject(hook) && typeof hook.command === "string" && hook.command.includes(AGENT_HOOK_PATH));
}

export function renderClaude(source: AdapterSource): RenderedFile[] {
  const files: RenderedFile[] = [];
  for (const command of source.commands) {
    files.push({
      path: `${CLAUDE_DIR}/skills/ways-${command.name}/SKILL.md`,
      content: `${frontmatter([["name", `ways-${command.name}`], ["description", command.description], ["argument-hint", command.usage]])}\n${resolveNames(command.body)}\n`,
    });
  }
  for (const role of source.roles) {
    const readOnly: Array<[string, string | undefined]> = role.access === "read" ? [["tools", READ_TOOLS], ["permissionMode", "plan"]] : [];
    files.push({
      path: `${CLAUDE_DIR}/agents/ways-${role.name}.md`,
      content: `${frontmatter([["name", `ways-${role.name}`], ["description", role.description], ...readOnly])}\n${resolveNames(role.body)}\n`,
    });
  }
  files.push({ path: STATUSLINE_PATH, content: resolveNames(source.statusline), mode: 0o755 });
  return files;
}

type Settings = Record<string, unknown>;

function isObject(value: unknown): value is Settings {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readSettings(cwd: string): Promise<Settings> {
  try {
    const value: unknown = JSON.parse(await readFile(join(cwd, SETTINGS_PATH), "utf8"));
    if (isObject(value)) return value;
    throw new Error(`${SETTINGS_PATH} must contain a JSON object`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Adds the status line; one the user already has is wrapped, so the ways
 * status is appended to it. The 0.2 guard hook is removed. Every other key is
 * preserved verbatim.
 */
export function mergeClaudeSettings(settings: Settings): { settings: Settings; notes: string[] } {
  const next: Settings = { ...settings };
  const notes: string[] = [];
  const statusLine = next.statusLine;
  const current = isObject(statusLine) && typeof statusLine.command === "string" ? statusLine.command : undefined;
  if (current === undefined || current === STATUSLINE_PATH) {
    next.statusLine = { type: "command", command: STATUSLINE_PATH };
  } else if (!current.startsWith(`${STATUSLINE_PATH} `)) {
    next.statusLine = { ...(statusLine as Settings), type: "command", command: `${STATUSLINE_PATH} ${shellQuote(current)}` };
    notes.push(`wrapped existing statusLine (${current}); the ways status is appended after it`);
  }
  if (next.hooks !== undefined && !isObject(next.hooks)) throw new Error(`${SETTINGS_PATH}: hooks must contain a JSON object`);
  const hooks: Settings = { ...(next.hooks ?? {}) };
  if (Array.isArray(hooks.PreToolUse) && (hooks.PreToolUse as unknown[]).some(isWaysGuardEntry)) notes.push("removed the retired ways guard hook");
  // The ways groups are replaced as a whole, so a re-merge picks up new matchers; the user's groups stay, in order.
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`${SETTINGS_PATH}: hooks.${event} must contain an array`);
    hooks[event] = groups.filter((group) => !isWaysGuardEntry(group) && !isWaysAgentGroup(group));
  }
  for (const [event, groups] of Object.entries(CLAUDE_HOOKS)) hooks[event] = [...(hooks[event] as unknown[] | undefined ?? []), ...groups];
  for (const [event, groups] of Object.entries(hooks)) if ((groups as unknown[]).length === 0) delete hooks[event];
  next.hooks = hooks;
  return { settings: next, notes };
}

/** Claude Code reads CLAUDE.md: it must import AGENTS.md. A symlink to AGENTS.md is left alone. */
async function ensureClaudeMd(cwd: string): Promise<boolean> {
  const path = join(cwd, CLAUDE_MD_PATH);
  try {
    if ((await lstat(path)).isSymbolicLink()) return false;
  } catch {
    await writeAtomic(path, CLAUDE_MD_CONTENT);
    return true;
  }
  const current = await readFile(path, "utf8");
  const next = withAgentsImport(current);
  if (next === current) return false;
  await writeAtomic(path, next);
  return true;
}

async function mergeSettingsFile(cwd: string): Promise<MergeResult> {
  const { settings, notes } = mergeClaudeSettings(await readSettings(cwd));
  await writeAtomic(join(cwd, SETTINGS_PATH), stableJson(settings));
  // Rules follow the memory, not the harness version, so they are not hashed in the manifest.
  const { syncRules } = await import("../context/rules.js");
  const rules = await syncRules(cwd, { always: true });
  return { files: [SETTINGS_PATH, ...rules.written, ...(await ensureClaudeMd(cwd) ? [CLAUDE_MD_PATH] : [])], notes };
}

async function verifySettings(cwd: string): Promise<AdapterIssue[]> {
  let settings: Settings;
  try {
    settings = await readSettings(cwd);
  } catch {
    return [{ code: "adapter-settings-invalid", path: SETTINGS_PATH, message: "Claude settings are unreadable" }];
  }
  if (!isObject(settings.statusLine) || typeof settings.statusLine.command !== "string") {
    return [{ code: "adapter-statusline-missing", path: SETTINGS_PATH, message: "statusLine is not configured; run ways adapter install claude" }];
  }
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const missing = Object.keys(CLAUDE_HOOKS).filter((event) => !(Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(isWaysAgentGroup)));
  if (missing.length > 0) {
    return [{ code: "adapter-hooks-missing", path: SETTINGS_PATH, message: `the ways agent hooks are missing for ${missing.join(", ")}; run \`ways adapter install claude\`` }];
  }
  return [];
}

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  tier: "default",
  render: renderClaude,
  merge: mergeSettingsFile,
  verify: verifySettings,
};
