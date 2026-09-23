import { chmod, lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST_PATH } from "../domain/constants.js";
import type { ManagedManifest } from "../domain/types.js";
import { validateManifest } from "../domain/validation.js";
import { sha256, stableJson, writeAtomic } from "../fs/files.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { piAdapter } from "./pi.js";
import { loadAdapterSource } from "./source.js";
import type { ProviderAdapter, RenderedFile } from "./types.js";

export const PROVIDERS: readonly ProviderAdapter[] = [claudeAdapter, codexAdapter, cursorAdapter, piAdapter];

export function providerById(id: string): ProviderAdapter {
  const adapter = PROVIDERS.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`Unknown provider: ${id}. Known: ${PROVIDERS.map((candidate) => candidate.id).join(", ")}`);
  return adapter;
}

export interface InstallResult {
  provider: string;
  files: string[];
  merged: string[];
  notes: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(cwd: string): Promise<ManagedManifest> {
  const value: unknown = JSON.parse(await readFile(join(cwd, MANIFEST_PATH), "utf8"));
  if (!validateManifest(value)) throw new Error("Installed manifest is invalid");
  return value;
}

export async function renderProvider(adapter: ProviderAdapter): Promise<RenderedFile[]> {
  return adapter.render(await loadAdapterSource());
}

async function writeRendered(cwd: string, files: RenderedFile[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of files) {
    const target = join(cwd, file.path);
    await writeAtomic(target, file.content, file.mode);
    if (file.mode !== undefined) await chmod(target, file.mode);
    hashes[file.path] = sha256(file.content);
  }
  return hashes;
}

/**
 * Renders a provider from the canonical source and records the owned files in
 * the manifest. Refuses to overwrite files it does not already own unless forced.
 */
export async function installAdapter(cwd: string, providerId: string, force = false): Promise<InstallResult> {
  const adapter = providerById(providerId);
  const manifest = await readManifest(cwd);
  const owned = new Set(Object.keys(manifest.adapters?.[adapter.id] ?? {}));
  const files = await renderProvider(adapter);
  if (!force) {
    for (const file of files) {
      if (!owned.has(file.path) && await exists(join(cwd, file.path))) throw new Error(`Refusing to overwrite ${file.path}; use --force`);
    }
  }
  const hashes = await writeRendered(cwd, files);
  for (const orphan of owned) {
    if (!(orphan in hashes)) await rm(join(cwd, orphan), { force: true });
  }
  const merged = adapter.merge ? await adapter.merge(cwd) : { files: [], notes: [] };
  // A re-render that changes nothing keeps the manifest byte-identical, so upgrades stay idempotent.
  if (stableJson(manifest.adapters?.[adapter.id] ?? null) !== stableJson(hashes)) manifest.generatedAt = new Date().toISOString();
  manifest.adapters = { ...(manifest.adapters ?? {}), [adapter.id]: hashes };
  await writeAtomic(join(cwd, MANIFEST_PATH), stableJson(manifest));
  return { provider: adapter.id, files: Object.keys(hashes), merged: merged.files, notes: merged.notes };
}

export async function installAllAdapters(cwd: string, force = false): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  for (const adapter of PROVIDERS) results.push(await installAdapter(cwd, adapter.id, force));
  return results;
}
