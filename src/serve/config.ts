import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The human's own settings for the board, outside any repository:
 * `~/.config/ways/registry.json` lists the repositories one `ways serve`
 * shows (each `ways serve` adds the one it runs in), and
 * `~/.config/ways/config.json` may set `{"lang": "es"}`. `WAYS_CONFIG_DIR`
 * or `XDG_CONFIG_HOME` move the directory.
 */
export const LANGS = ["en", "es"] as const;
export type Lang = (typeof LANGS)[number];

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.WAYS_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ways");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "registry.json");
}

export function readRegistry(env: NodeJS.ProcessEnv = process.env): string[] {
  const value = readJson(registryPath(env)) as { repos?: unknown } | undefined;
  return Array.isArray(value?.repos) ? value.repos.filter((entry): entry is string => typeof entry === "string" && entry.startsWith("/")) : [];
}

/** Adds repositories (absolute paths of their main worktree) to the registry; returns the whole list. */
export function register(paths: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const current = readRegistry(env);
  const next = [...new Set([...current, ...paths.map((path) => resolve(path))])];
  if (next.length !== current.length) {
    const path = registryPath(env);
    mkdirSync(configDir(env), { recursive: true });
    writeFileSync(`${path}.tmp-${process.pid}`, `${JSON.stringify({ repos: next }, null, 2)}\n`);
    renameSync(`${path}.tmp-${process.pid}`, path);
  }
  return next;
}

export function userLang(env: NodeJS.ProcessEnv = process.env): Lang | undefined {
  const value = (readJson(join(configDir(env), "config.json")) as { lang?: unknown } | undefined)?.lang;
  return (LANGS as readonly unknown[]).includes(value) ? value as Lang : undefined;
}
