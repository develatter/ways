import type { AdapterSource } from "./types.js";

export interface NameStyle {
  /** How the provider invokes a harness command, e.g. `/ways-quick` or `$ways-quick`. */
  command(name: string): string;
  /** How the provider names a harness role, e.g. `ways-reviewer`. */
  role(name: string): string;
}

export const SLASH_NAMES: NameStyle = { command: (name) => `/ways-${name}`, role: (name) => `ways-${name}` };

/** Resolves neutral `{{command:x}}` and `{{role:x}}` placeholders into provider names. */
export function resolveWith(text: string, style: NameStyle): string {
  return text.replace(/\{\{command:([a-z-]+)\}\}/g, (_, name: string) => style.command(name)).replace(/\{\{role:([a-z-]+)\}\}/g, (_, name: string) => style.role(name));
}

/** Providers whose skills carry no argument placeholder get the arguments spelled out. */
export function spellArguments(text: string): string {
  const argumentsText = "the arguments the human gave with this skill";
  return text.replace(/`([^`]*)\$ARGUMENTS([^`]*)`/g, (_match, before: string, after: string) => {
    const command = `${before.trimEnd()}${after}`;
    return command ? `\`${command}\` with ${argumentsText}` : argumentsText;
  }).replaceAll("$ARGUMENTS", argumentsText);
}

export function yamlFrontmatter(entries: Array<[string, string | boolean | undefined]>): string {
  const lines = entries.filter((entry): entry is [string, string | boolean] => entry[1] !== undefined && entry[1] !== "").map(([key, value]) => `${key}: ${typeof value === "string" ? quoteIfNeeded(value) : String(value)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function quoteIfNeeded(value: string): string {
  return /[:#"'\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
}

/** Names for skills shared in `.agents/skills`, which several agents read and invoke differently. */
export const NEUTRAL_NAMES: NameStyle = { command: (name) => `the ways-${name} skill`, role: (name) => `ways-${name}` };

export const AGENT_SKILLS_DIR = ".agents/skills";

/** The shared `.agents/skills/ways-<name>/SKILL.md` (pi, Codex): byte-identical whichever adapter writes it. */
export function renderAgentSkill(source: AdapterSource["commands"][number]): { path: string; content: string } {
  return { path: `${AGENT_SKILLS_DIR}/ways-${source.name}/SKILL.md`, content: renderSkill(source, NEUTRAL_NAMES) };
}

/** Agent Skills standard (agentskills.io) SKILL.md, used by Codex and Cursor for slash-style commands. */
export function renderSkill(source: AdapterSource["commands"][number], style: NameStyle, extra: Array<[string, string | boolean | undefined]> = []): string {
  const usage = source.usage ? `\nArguments: \`${source.usage}\`\n` : "";
  return `${yamlFrontmatter([["name", `ways-${source.name}`], ["description", source.description], ...extra])}${usage}\n${spellArguments(resolveWith(source.body, style))}\n`;
}
