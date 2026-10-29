import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH } from "../domain/constants.js";

/**
 * When an agent runs a configured check by hand (`pytest`, `npm test`,
 * `npx eslint .`), ways suggests `ways run <check>` once per session: the
 * same run, a summary instead of the whole output. It never blocks. This is
 * on the hook path: one small JSON read, no git, no yaml.
 */
const CHECKS = ["test", "lint", "typecheck", "build", "e2e"] as const;

/** The words that name a runner, without the launchers in front: `npx --no-install vitest run` → `vitest run`, `python3 -m pytest` → `pytest`, `npm run test` → `npm test`. */
export function normalizeWords(words: readonly string[]): string[] {
  let rest = [...words];
  while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) rest.shift();
  if (rest[0] === "npx" || rest[0] === "pnpx" || rest[0] === "bunx") {
    rest.shift();
    while (rest[0]?.startsWith("-")) rest.shift();
  }
  if ((rest[0] === "poetry" || rest[0] === "uv") && rest[1] === "run") rest = rest.slice(2);
  if (/^python(?:3(?:\.\d+)?)?$/.test(rest[0] ?? "") && rest[1] === "-m") rest = rest.slice(2);
  if (/^(npm|pnpm|yarn|bun)$/.test(rest[0] ?? "") && rest[1] === "run" && rest[2] !== undefined) rest = [rest[0]!, ...rest.slice(2)];
  return rest.map((word) => word.replace(/^\.\//, ""));
}

function configured(top: string): Array<{ name: string; command: string[] }> {
  try {
    const config = JSON.parse(readFileSync(join(top, CONFIG_PATH), "utf8")) as { testCommand?: unknown; commands?: Record<string, unknown> };
    const valid = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((word) => typeof word === "string");
    if (config.commands && typeof config.commands === "object") return CHECKS.flatMap((name) => valid(config.commands![name]) ? [{ name, command: config.commands![name] as string[] }] : []);
    return valid(config.testCommand) ? [{ name: "test", command: config.testCommand }] : [];
  } catch {
    return [];
  }
}

/** The plain words of each command in a shell line (split at `&&`, `||`, `;` and `|`), quotes removed. */
function segments(line: string): string[][] {
  return line.split(/&&|\|\||[;|\n]/).map((part) => [...part.trim().matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!)).filter((words) => words.length > 0);
}

/** The configured check a shell command runs by hand, if any. `ways` itself never counts. */
export function checkRunBy(top: string, line: string): { name: string; command: string[] } | undefined {
  if (/\bways\b/.test(line)) return undefined;
  const checks = configured(top).map((check) => ({ ...check, words: normalizeWords(check.command) }));
  for (const words of segments(line)) {
    const typed = normalizeWords(words);
    const found = checks.find((check) => check.words.length > 0 && check.words.every((word, index) => typed[index] === word));
    if (found) return { name: found.name, command: found.command };
  }
  return undefined;
}

export function runHintText(check: { name: string; command: string[] }): string {
  return `ways (said once): \`npx ways run ${check.name}\` runs the same \`${check.command.join(" ")}\` and returns a summary (each failure on one line, new or already failing at the base) instead of the whole output, with the full log kept (\`npx ways run --show <id>\`); extra arguments go after \`--\`.`;
}
