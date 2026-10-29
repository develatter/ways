import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WIKI_CONFIG_PATH } from "../domain/constants.js";
import { normalizeGlob } from "../memory/glob.js";

/**
 * `.ways/wiki.json`: which agent writes the wiki, and what the wiki is
 * expected to cover. Every field is optional; without the file the wiki is
 * checked for structure, links and freshness, and no coverage is demanded.
 *
 *   { "agent": "claude" | "pi" | "command",
 *     "command": ["my-agent", "--flag"],          // the brief arrives on stdin
 *     "scope": { "modules": ["src/<any>/"],       // directories (a trailing /) or files the pages must cite
 *                "commands": "ways" | ["name"] } } // CLI commands that need a mention
 */
export interface WikiConfig {
  agent?: "claude" | "pi" | "command";
  command?: string[];
  scope: { modules: string[]; commands: "ways" | string[] };
}

export interface LoadedWikiConfig {
  config: WikiConfig;
  present: boolean;
  /** Why the file is not usable as written; the defaults apply to what is wrong. */
  problems: string[];
}

export const DEFAULT_WIKI_CONFIG: WikiConfig = { scope: { modules: [], commands: [] } };

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "") ? value as string[] : undefined;
}

export async function loadWikiConfig(cwd: string): Promise<LoadedWikiConfig> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, WIKI_CONFIG_PATH), "utf8");
  } catch {
    return { config: structuredClone(DEFAULT_WIKI_CONFIG), present: false, problems: [] };
  }
  const config: WikiConfig = structuredClone(DEFAULT_WIKI_CONFIG);
  const problems: string[] = [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { config, present: true, problems: [`${WIKI_CONFIG_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { config, present: true, problems: [`${WIKI_CONFIG_PATH} must be a JSON object`] };
  const input = value as Record<string, unknown>;
  if (input.agent !== undefined) {
    if (input.agent === "claude" || input.agent === "pi" || input.agent === "command") config.agent = input.agent;
    else problems.push(`${WIKI_CONFIG_PATH}: "agent" must be "claude", "pi" or "command"`);
  }
  if (input.command !== undefined) {
    const command = strings(input.command);
    if (command && command.length > 0) config.command = command;
    else problems.push(`${WIKI_CONFIG_PATH}: "command" must be a non-empty array of strings, e.g. ["my-agent", "--flag"]`);
  }
  const scope = input.scope;
  if (scope !== undefined) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) problems.push(`${WIKI_CONFIG_PATH}: "scope" must be an object`);
    else {
      const { modules, commands } = scope as Record<string, unknown>;
      if (modules !== undefined) {
        const list = strings(modules);
        try {
          if (!list) throw new Error('"scope.modules" must be an array of repository-relative globs');
          config.scope.modules = list.map((glob) => (glob.endsWith("/") ? `${normalizeGlob(glob.replace(/\/+$/, ""))}/` : normalizeGlob(glob)));
        } catch (error) {
          problems.push(`${WIKI_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (commands !== undefined) {
        if (commands === "ways") config.scope.commands = "ways";
        else if (strings(commands)) config.scope.commands = commands as string[];
        else problems.push(`${WIKI_CONFIG_PATH}: "scope.commands" must be "ways" or an array of command names`);
      }
    }
  }
  return { config, present: true, problems };
}
