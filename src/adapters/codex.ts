import { isWaysGuardEntry, removeHookEntries } from "./hook-file.js";
import { renderSkill, resolveWith, type NameStyle } from "./render.js";
import type { AdapterSource, ProviderAdapter, RenderedFile } from "./types.js";

/**
 * OpenAI Codex CLI, best effort (opt-in with `--agents=codex`). Per the
 * official docs (2026-09): project prompts are not supported, so commands
 * become repository skills in `.agents/skills/<name>/SKILL.md` invoked with
 * `$name`; roles become `.codex/agents/<name>.toml` with
 * `sandbox_mode = "read-only"` for read roles. Codex reads `AGENTS.md`.
 */
export const CODEX_DIR = ".codex";
const SKILLS_DIR = ".agents/skills";
const HOOKS_PATH = `${CODEX_DIR}/hooks.json`;
const NAMES: NameStyle = { command: (name) => `$ways-${name}`, role: (name) => `ways-${name}` };

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlMultiline(value: string): string {
  return `"""\n${value.replaceAll('"""', '\\"\\"\\"')}\n"""`;
}

export function renderCodex(source: AdapterSource): RenderedFile[] {
  const files: RenderedFile[] = [];
  for (const command of source.commands) {
    files.push({ path: `${SKILLS_DIR}/ways-${command.name}/SKILL.md`, content: renderSkill(command, NAMES) });
  }
  for (const role of source.roles) {
    const lines = [
      `name = ${tomlString(`ways-${role.name}`)}`,
      `description = ${tomlString(role.description)}`,
      ...(role.access === "read" ? ['sandbox_mode = "read-only"'] : []),
      `developer_instructions = ${tomlMultiline(resolveWith(role.body, NAMES))}`,
    ];
    files.push({ path: `${CODEX_DIR}/agents/ways-${role.name}.toml`, content: `${lines.join("\n")}\n` });
  }
  return files;
}

export const codexAdapter: ProviderAdapter = {
  id: "codex",
  tier: "best-effort",
  render: renderCodex,
  merge: async (cwd) => await removeHookEntries(cwd, HOOKS_PATH, isWaysGuardEntry) ?? { files: [], notes: [] },
};
