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
/** Read roles get no shell: a Bash tool could write, and the reviewer's independence rests on being read-only. */
const READ_TOOLS = "Read, Grep, Glob";

function frontmatter(entries: Array<[string, string | undefined]>): string {
  const lines = entries.filter((entry): entry is [string, string] => Boolean(entry[1])).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Resolves neutral `{{command:x}}` and `{{role:x}}` placeholders into Claude names. */
export function resolveNames(text: string): string {
  return resolveWith(text, SLASH_NAMES);
}

/** Tools whose paths are logged. */
const WRITE_TOOLS = "Write|Edit|MultiEdit|NotebookEdit";
const HOOK_TIMEOUT_SECONDS = 10;

/**
 * The guard only needs to run on calls that could touch a work record or
 * switch the commit hooks off, so each handler carries an `if` permission
 * rule (Claude Code evaluates it before starting a process; it is
 * best-effort, and runs the hook when it cannot tell). Every other tool call
 * costs nothing. The commit hook stays the guarantee either way.
 */
/**
 * Common test, lint and type-check runners: when the agent runs a configured
 * check by hand, the hook suggests `ways run <check>` once per session. The
 * hook itself compares with the configured commands; these rules only keep
 * every other shell call from starting it.
 */
export const RUNNER_IF: readonly string[] = [
  "Bash(npm test*)", "Bash(npm run *)", "Bash(pnpm *)", "Bash(yarn *)", "Bash(bun *)", "Bash(npx *)",
  "Bash(pytest*)", "Bash(python -m *)", "Bash(python3 -m *)", "Bash(uv run *)", "Bash(poetry run *)", "Bash(ruff *)", "Bash(mypy *)", "Bash(tox*)",
  "Bash(cargo *)", "Bash(go test *)", "Bash(go vet *)", "Bash(make *)", "Bash(mvn *)", "Bash(./mvnw *)", "Bash(gradle *)", "Bash(./gradlew *)",
  "Bash(vitest*)", "Bash(jest*)", "Bash(tsc*)", "Bash(eslint*)",
];

const GUARD_IF: Readonly<Record<string, readonly string[]>> = {
  [WRITE_TOOLS]: ["Edit(**/.ways/work/**)", "Write(**/.ways/work/**)"],
  Bash: ["Bash(*.ways/work*)", "Bash(*WAYS_DISABLE*)", "Bash(git commit *)", "Bash(git -c *)", "Bash(git config *)", ...RUNNER_IF],
};

function handler(event: string, extra: Settings = {}): Settings {
  return { type: "command", command: `"$CLAUDE_PROJECT_DIR"/${AGENT_HOOK_PATH} claude ${event}`, timeout: HOOK_TIMEOUT_SECONDS, ...extra };
}

/** The hook groups ways adds to `.claude/settings.json`, by event. */
export const CLAUDE_HOOKS: Readonly<Record<string, Settings[]>> = {
  SessionStart: [{ hooks: [handler("SessionStart")] }],
  UserPromptSubmit: [{ hooks: [handler("UserPromptSubmit")] }],
  PreToolUse: Object.entries(GUARD_IF).map(([matcher, rules]) => ({ matcher, hooks: rules.map((rule) => handler("PreToolUse", { if: rule })) })),
  // Logging only: in the background, so an edit never waits for it.
  PostToolUse: [{ matcher: WRITE_TOOLS, hooks: [handler("PostToolUse", { async: true })] }],
  Stop: [{ hooks: [handler("Stop")] }],
  SessionEnd: [{ hooks: [handler("SessionEnd")] }],
  // The independent reviewer: ways hands it the review prompt and records its final answer itself.
  SubagentStart: [{ matcher: "ways-reviewer", hooks: [handler("SubagentStart")] }],
  SubagentStop: [{ matcher: "ways-reviewer", hooks: [handler("SubagentStop", { timeout: 60 })] }],
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
