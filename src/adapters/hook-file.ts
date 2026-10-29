import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson, writeAtomic } from "../fs/files.js";
import type { AdapterIssue, MergeResult } from "./types.js";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function readJsonObject(cwd: string, path: string): Promise<JsonObject> {
  try {
    const value: unknown = JSON.parse(await readFile(join(cwd, path), "utf8"));
    if (isObject(value)) return value;
    throw new Error(`${path} must contain a JSON object`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export interface HookEntry {
  matcher?: string;
  command?: string;
  [key: string]: unknown;
}

function hookGroups(file: JsonObject): JsonObject {
  if (file.hooks === undefined) return {};
  if (!isObject(file.hooks)) throw new Error("hooks must contain a JSON object");
  return file.hooks;
}

function eventEntries(hooks: JsonObject, event: string): unknown[] {
  const entries = hooks[event];
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new Error(`hooks.${event} must contain an array`);
  return entries;
}

/**
 * Merges harness hook entries into a provider's `hooks.<event>` arrays without
 * touching entries the user owns. `present` decides whether an existing entry
 * already is the harness one, so repeated merges are idempotent.
 */
export function mergeHookEntries(file: JsonObject, wanted: Record<string, HookEntry[]>, present: (entry: unknown, wanted: HookEntry) => boolean): JsonObject {
  const next: JsonObject = { ...file };
  const hooks: JsonObject = { ...hookGroups(next) };
  for (const [event, entries] of Object.entries(wanted)) {
    const existing = [...eventEntries(hooks, event)];
    for (const entry of entries) {
      if (!existing.some((candidate) => present(candidate, entry))) existing.push(entry);
    }
    hooks[event] = existing;
  }
  next.hooks = hooks;
  return next;
}

export function hasHookEntries(file: JsonObject, wanted: Record<string, HookEntry[]>, present: (entry: unknown, wanted: HookEntry) => boolean): boolean {
  const hooks = hookGroups(file);
  return Object.entries(wanted).every(([event, entries]) => {
    const existing = eventEntries(hooks, event);
    return entries.every((entry) => existing.some((candidate) => present(candidate, entry)));
  });
}

export async function mergeHookFile(cwd: string, path: string, wanted: Record<string, HookEntry[]>, present: (entry: unknown, wanted: HookEntry) => boolean, seed: JsonObject = {}): Promise<MergeResult> {
  const current = await readJsonObject(cwd, path);
  const merged = mergeHookEntries({ ...seed, ...current }, wanted, present);
  await writeAtomic(join(cwd, path), stableJson(merged));
  return { files: [path], notes: [] };
}

/**
 * Removes the entries `ours` recognises from every `hooks.<event>` array and
 * drops arrays it empties; user entries stay. Used to retire the 0.2 guard.
 * Returns undefined when the file does not exist or nothing changed.
 */
export async function removeHookEntries(cwd: string, path: string, ours: (entry: unknown) => boolean): Promise<MergeResult | undefined> {
  let file: JsonObject;
  try {
    await readFile(join(cwd, path));
    file = await readJsonObject(cwd, path);
  } catch {
    return undefined;
  }
  if (!isObject(file.hooks)) return undefined;
  const hooks: JsonObject = { ...file.hooks };
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !ours(entry));
    if (kept.length === entries.length) continue;
    changed = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (!changed) return undefined;
  const next: JsonObject = { ...file, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  await writeAtomic(join(cwd, path), stableJson(next));
  return { files: [path], notes: [`removed the retired ways guard hook from ${path}`] };
}

/** A hook entry (or group) whose command runs a ways guard script. */
export function isWaysGuardEntry(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  if (typeof entry.command === "string" && entry.command.includes("ways-guard.sh")) return true;
  return Array.isArray(entry.hooks) && entry.hooks.length > 0 && entry.hooks.every((hook) => isObject(hook) && typeof hook.command === "string" && hook.command.includes("ways-guard.sh"));
}

export async function verifyHookFile(cwd: string, path: string, provider: string, wanted: Record<string, HookEntry[]>, present: (entry: unknown, wanted: HookEntry) => boolean): Promise<AdapterIssue[]> {
  let file: JsonObject;
  try {
    file = await readJsonObject(cwd, path);
  } catch {
    return [{ code: "adapter-settings-invalid", path, message: `${provider} hook file is unreadable` }];
  }
  if (!hasHookEntries(file, wanted, present)) {
    return [{ code: "adapter-guard-missing", path, message: `guard hook is not configured; run ways adapter install ${provider}` }];
  }
  return [];
}
