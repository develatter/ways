import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson, writeAtomic } from "../fs/files.js";
import { isWaysGuardEntry } from "./hook-file.js";
import { resolveWith, SLASH_NAMES } from "./render.js";
import type { AdapterIssue, AdapterSource, MergeResult, ProviderAdapter, RenderedFile } from "./types.js";

/**
 * Claude Code: commands in `.claude/commands/`, roles as subagents in
 * `.claude/agents/` (read roles get read-only tools), and a status line
 * merged into `.claude/settings.json`. Claude Code reads `CLAUDE.md`, which
 * bootstrap makes import `AGENTS.md`.
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

export function renderClaude(source: AdapterSource): RenderedFile[] {
  const files: RenderedFile[] = [];
  for (const command of source.commands) {
    files.push({
      path: `${CLAUDE_DIR}/commands/ways-${command.name}.md`,
      content: `${frontmatter([["description", command.description], ["argument-hint", command.usage]])}\n${resolveNames(command.body)}\n`,
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
  if (isObject(next.hooks) && Array.isArray(next.hooks.PreToolUse)) {
    const kept = (next.hooks.PreToolUse as unknown[]).filter((group) => !isWaysGuardEntry(group));
    if (kept.length !== next.hooks.PreToolUse.length) {
      const hooks: Settings = { ...next.hooks };
      if (kept.length > 0) hooks.PreToolUse = kept;
      else delete hooks.PreToolUse;
      if (Object.keys(hooks).length > 0) next.hooks = hooks;
      else delete next.hooks;
      notes.push("removed the retired ways guard hook");
    }
  }
  return { settings: next, notes };
}

async function mergeSettingsFile(cwd: string): Promise<MergeResult> {
  const { settings, notes } = mergeClaudeSettings(await readSettings(cwd));
  await writeAtomic(join(cwd, SETTINGS_PATH), stableJson(settings));
  return { files: [SETTINGS_PATH], notes };
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
  return [];
}

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  tier: "default",
  render: renderClaude,
  merge: mergeSettingsFile,
  verify: verifySettings,
};
