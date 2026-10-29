import { resolveWith, SLASH_NAMES, yamlFrontmatter } from "./render.js";
import type { AdapterSource, ProviderAdapter, RenderedFile } from "./types.js";

/**
 * pi coding agent (`@earendil-works/pi-coding-agent`). Per the upstream docs
 * (2026-09): commands become prompt templates in `.pi/prompts/<name>.md`
 * (frontmatter `description`, `argument-hint`; `$ARGUMENTS` supported), roles
 * become `.pi/agents/<name>.md` for the subagent extension with a `tools`
 * restriction for read roles, and the status line comes from a project
 * extension in `.pi/extensions/ways/index.ts` through `ctx.ui.setStatus`. pi
 * reads `AGENTS.md`. Project resources load only once the project is trusted.
 */
export const PI_DIR = ".pi";
const READ_TOOLS = "read, grep, find, ls";

const EXTENSION = `// Managed by ways. Shows the active ways work in pi's status bar.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function (pi: ExtensionAPI) {
  const refresh = async (_event: unknown, ctx: { hasUI: boolean; ui: { setStatus(key: string, text: string): void } }) => {
    if (ctx.hasUI) ctx.ui.setStatus("ways", waysStatus(process.cwd()));
  };
  pi.on("session_start", refresh);
  pi.on("turn_start", refresh);
  pi.on("tool_result", async (event, ctx) => {
    await refresh(event, ctx);
    return undefined;
  });
}
`;

export function renderPi(source: AdapterSource): RenderedFile[] {
  const files: RenderedFile[] = [];
  for (const command of source.commands) {
    const front = yamlFrontmatter([["description", command.description], ["argument-hint", command.usage]]);
    files.push({ path: `${PI_DIR}/prompts/ways-${command.name}.md`, content: `${front}\n${resolveWith(command.body, SLASH_NAMES)}\n` });
  }
  for (const role of source.roles) {
    const front = yamlFrontmatter([["name", `ways-${role.name}`], ["description", role.description], ["tools", role.access === "read" ? READ_TOOLS : undefined]]);
    files.push({ path: `${PI_DIR}/agents/ways-${role.name}.md`, content: `${front}\n${resolveWith(role.body, SLASH_NAMES)}\n` });
  }
  files.push({ path: `${PI_DIR}/extensions/ways/index.ts`, content: EXTENSION });
  return files;
}

export const piAdapter: ProviderAdapter = {
  id: "pi",
  tier: "default",
  render: renderPi,
};
