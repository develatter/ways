import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { AdapterSource, CommandSource, RoleSource } from "./types.js";

export const MAX_ROLE_LINES = 6;

export function adapterAssetPath(relative = ""): string {
  return fileURLToPath(new URL(`../../assets/adapters/${relative}`, import.meta.url));
}

interface Parsed {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(content: string, path: string): Parsed {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`${path}: missing frontmatter`);
  const value: unknown = parse(match[1] ?? "");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: frontmatter must be a mapping`);
  return { frontmatter: value as Record<string, unknown>, body: content.slice(match[0].length).trim() };
}

function requireString(frontmatter: Record<string, unknown>, key: string, path: string): string {
  const value = frontmatter[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path}: frontmatter requires ${key}`);
  return value.trim();
}

async function markdownFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".md")).sort().map((name) => join(dir, name));
}

export function nonEmptyLines(body: string): string[] {
  return body.split("\n").filter((line) => line.trim().length > 0);
}

export async function loadAdapterSource(root = adapterAssetPath()): Promise<AdapterSource> {
  const commands: CommandSource[] = [];
  for (const path of await markdownFiles(join(root, "commands"))) {
    const { frontmatter, body } = parseFrontmatter(await readFile(path, "utf8"), path);
    const command: CommandSource = { name: basename(path, ".md"), description: requireString(frontmatter, "description", path), body };
    if (typeof frontmatter.usage === "string" && frontmatter.usage.trim()) command.usage = frontmatter.usage.trim();
    commands.push(command);
  }

  const roles: RoleSource[] = [];
  for (const path of await markdownFiles(join(root, "roles"))) {
    const { frontmatter, body } = parseFrontmatter(await readFile(path, "utf8"), path);
    const access = frontmatter.access;
    if (access !== "read" && access !== "write") throw new Error(`${path}: access must be read or write`);
    if (nonEmptyLines(body).length > MAX_ROLE_LINES) throw new Error(`${path}: role prompt exceeds ${MAX_ROLE_LINES} non-empty lines`);
    roles.push({ name: basename(path, ".md"), description: requireString(frontmatter, "description", path), access, body });
  }

  return {
    commands,
    roles,
    statusline: await readFile(join(root, "statusline.sh"), "utf8"),
  };
}
