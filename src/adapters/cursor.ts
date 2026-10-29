import { isWaysGuardEntry, removeHookEntries } from "./hook-file.js";
import { renderSkill, resolveWith, SLASH_NAMES, yamlFrontmatter } from "./render.js";
import type { AdapterSource, ProviderAdapter, RenderedFile } from "./types.js";

/**
 * Cursor (editor and cursor-agent CLI), best effort (opt-in with
 * `--agents=cursor`). Per cursor.com/docs (2026-09): commands become skills in
 * `.cursor/skills/<name>/SKILL.md` with `disable-model-invocation` so they only
 * run as `/name`; roles become `.cursor/agents/<name>.md` with `readonly: true`
 * for read roles. Cursor reads `AGENTS.md` at the project root.
 */
export const CURSOR_DIR = ".cursor";
const HOOKS_PATH = `${CURSOR_DIR}/hooks.json`;

export function renderCursor(source: AdapterSource): RenderedFile[] {
  const files: RenderedFile[] = [];
  for (const command of source.commands) {
    files.push({ path: `${CURSOR_DIR}/skills/ways-${command.name}/SKILL.md`, content: renderSkill(command, SLASH_NAMES, [["disable-model-invocation", true]]) });
  }
  for (const role of source.roles) {
    const front = yamlFrontmatter([["name", `ways-${role.name}`], ["description", role.description], ["model", "inherit"], ["readonly", role.access === "read" ? true : undefined]]);
    files.push({ path: `${CURSOR_DIR}/agents/ways-${role.name}.md`, content: `${front}\n${resolveWith(role.body, SLASH_NAMES)}\n` });
  }
  return files;
}

export const cursorAdapter: ProviderAdapter = {
  id: "cursor",
  tier: "best-effort",
  render: renderCursor,
  merge: async (cwd) => await removeHookEntries(cwd, HOOKS_PATH, isWaysGuardEntry) ?? { files: [], notes: [] },
};
