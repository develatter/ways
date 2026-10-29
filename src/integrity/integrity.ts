import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_PATH, KNOWLEDGE_DIR, MANIFEST_PATH } from "../domain/constants.js";
import type { IntegrityIssue, ManagedManifest } from "../domain/types.js";
import { validateConfig, validateManifest, validationDetails } from "../domain/validation.js";
import { sha256 } from "../fs/files.js";
import { inspectOkf } from "../knowledge/okf.js";
import { providerById } from "../adapters/install.js";
import { CLAUDE_MD_IMPORT, CLAUDE_MD_PATH, claudeMdImportsAgents } from "../bootstrap/claude-md.js";

export type { IntegrityIssue } from "../domain/types.js";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * What must hold before any check result is trusted: the harness files are
 * the ones ways installed, the configuration is valid, CLAUDE.md still loads
 * AGENTS.md, and the memory is well formed. Fast; no command runs.
 */
export async function checkIntegrity(cwd: string): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];

  let manifest: ManagedManifest | undefined;
  try {
    const value = await readJson(join(cwd, MANIFEST_PATH));
    if (validateManifest(value)) manifest = value;
    else issues.push({ code: "invalid-manifest", path: MANIFEST_PATH, message: "Manifest does not match its schema; run `ways upgrade --apply`" });
  } catch {
    issues.push({ code: "missing-manifest", path: MANIFEST_PATH, message: "Managed manifest is missing or unreadable; run `ways bootstrap`" });
  }

  try {
    const config = await readJson(join(cwd, CONFIG_PATH));
    if ((config as { schemaVersion?: unknown } | null)?.schemaVersion === 1) {
      issues.push({ code: "outdated-config", path: CONFIG_PATH, message: "Configuration was written by ways 0.2; run `ways upgrade --apply`" });
    } else if (!validateConfig(config)) {
      issues.push({ code: "invalid-config", path: CONFIG_PATH, message: `Configuration does not match its schema: ${validationDetails("config", config).errors.join("; ")}` });
    }
  } catch {
    issues.push({ code: "missing-config", path: CONFIG_PATH, message: "Configuration is missing or unreadable; run `ways bootstrap`" });
  }

  if (manifest) {
    const expectations: Array<[string, string, string]> = Object.entries(manifest.managedFiles).map(([path, hash]) => [path, hash, "managed-file"]);
    for (const files of Object.values(manifest.adapters ?? {})) {
      for (const [path, hash] of Object.entries(files)) expectations.push([path, hash, "adapter-file"]);
    }
    for (const [relative, expected, kind] of expectations) {
      const label = kind === "adapter-file" ? "Adapter" : "Managed";
      try {
        if (sha256(await readFile(join(cwd, relative))) !== expected) {
          issues.push({ code: `${kind}-modified`, path: relative, message: `${label} file differs from what ways installed; restore it or run \`ways upgrade --apply --overwrite=${relative}\`` });
        }
      } catch {
        issues.push({ code: `${kind}-missing`, path: relative, message: `${label} file is missing; run \`ways upgrade --apply\`` });
      }
    }
  }

  // Claude Code reads CLAUDE.md, not AGENTS.md: with its adapter installed, the import must be there.
  if (manifest?.adapters?.claude) {
    try {
      const claudePath = join(cwd, CLAUDE_MD_PATH);
      if ((await lstat(claudePath)).isSymbolicLink()) {
        if (await readlink(claudePath) !== "AGENTS.md") issues.push({ code: "invalid-claude-md", path: CLAUDE_MD_PATH, message: `CLAUDE.md must import AGENTS.md: replace it with a line containing ${CLAUDE_MD_IMPORT}` });
      } else if (!claudeMdImportsAgents(await readFile(claudePath, "utf8"))) {
        issues.push({ code: "invalid-claude-md", path: CLAUDE_MD_PATH, message: `CLAUDE.md must import AGENTS.md: add a line containing ${CLAUDE_MD_IMPORT}` });
      }
    } catch {
      issues.push({ code: "missing-claude-md", path: CLAUDE_MD_PATH, message: `CLAUDE.md is missing: create it with the single line ${CLAUDE_MD_IMPORT} (or rerun \`ways bootstrap\`)` });
    }
  }

  const okf = await inspectOkf(cwd);
  for (const issue of okf.issues) {
    const path = issue.path === KNOWLEDGE_DIR ? KNOWLEDGE_DIR : `${KNOWLEDGE_DIR}/${issue.path}`;
    issues.push({ code: issue.code, path, message: issue.message });
  }

  for (const provider of Object.keys(manifest?.adapters ?? {})) {
    try {
      const adapter = providerById(provider);
      if (adapter.verify) issues.push(...await adapter.verify(cwd));
    } catch (error) {
      issues.push({ code: "adapter-unknown", path: MANIFEST_PATH, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return issues;
}
