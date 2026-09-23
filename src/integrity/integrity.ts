import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_PATH, KNOWLEDGE_DIR, MANIFEST_PATH, STATE_PATH, STATUS_PATH } from "../domain/constants.js";
import type { ManagedManifest, WorkState } from "../domain/types.js";
import { validateConfig, validateManifest, validateRemediation, validateState } from "../domain/validation.js";
import { sha256 } from "../fs/files.js";
import { inspectOkf } from "../knowledge/okf.js";
import { GitRepository } from "../git/git.js";
import { providerById } from "../adapters/install.js";
import { readStatus, statusMatches } from "../state/status.js";
import { commitsAfter } from "./history.js";
import { isPriorAttemptArtifact, remediationRecordPath, remediationTransitionCommit, validationFailureRecordPath } from "../work/attempt.js";
import { remediationEvidenceFailure } from "../work/remediation.js";
import { committedValidationFailureFailure } from "../work/validation-failure.js";
import { assertSddConsistency } from "../work/sdd.js";
import { assertOutcomeConsistency } from "../work/outcome.js";

export interface IntegrityIssue {
  code: string;
  path: string;
  message: string;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

export async function checkIntegrity(cwd: string): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  const configPath = join(cwd, CONFIG_PATH);
  const manifestPath = join(cwd, MANIFEST_PATH);

  let manifest: ManagedManifest | undefined;
  try {
    const value = await readJson(manifestPath);
    if (validateManifest(value)) manifest = value;
    else issues.push({ code: "invalid-manifest", path: MANIFEST_PATH, message: "Manifest does not match its schema" });
  } catch {
    issues.push({ code: "missing-manifest", path: MANIFEST_PATH, message: "Managed manifest is missing or unreadable" });
  }

  try {
    if (!validateConfig(await readJson(configPath))) {
      issues.push({ code: "invalid-config", path: CONFIG_PATH, message: "Configuration does not match its schema" });
    }
  } catch {
    issues.push({ code: "missing-config", path: CONFIG_PATH, message: "Configuration is missing or unreadable" });
  }

  if (manifest) {
    const expectations: Array<[string, string, string]> = Object.entries(manifest.managedFiles).map(([path, hash]) => [path, hash, "managed-file"]);
    for (const files of Object.values(manifest.adapters ?? {})) {
      for (const [path, hash] of Object.entries(files)) expectations.push([path, hash, "adapter-file"]);
    }
    for (const [relative, expected, kind] of expectations) {
      const path = join(cwd, relative);
      const label = kind === "adapter-file" ? "Adapter" : "Managed";
      try {
        const actual = sha256(await readFile(path));
        if (actual !== expected) issues.push({ code: `${kind}-modified`, path: relative, message: `${label} file hash differs from the manifest` });
      } catch {
        issues.push({ code: `${kind}-missing`, path: relative, message: `${label} file is missing` });
      }
    }
  }

  try {
    const target = await readlink(join(cwd, "CLAUDE.md"));
    if (target !== "AGENTS.md") issues.push({ code: "invalid-symlink", path: "CLAUDE.md", message: "CLAUDE.md must target AGENTS.md" });
  } catch {
    issues.push({ code: "missing-symlink", path: "CLAUDE.md", message: "CLAUDE.md symlink is missing" });
  }

  let activeState: WorkState | undefined;
  if (await isFile(join(cwd, STATE_PATH))) {
    try {
      const value = await readJson(join(cwd, STATE_PATH));
      if (validateState(value)) activeState = value;
      else issues.push({ code: "invalid-state", path: STATE_PATH, message: "Active state does not match its schema" });
    } catch {
      issues.push({ code: "invalid-state", path: STATE_PATH, message: "Active state is unreadable" });
    }
  }

  if (!statusMatches(await readStatus(cwd), activeState)) {
    issues.push({ code: "status-divergence", path: STATUS_PATH, message: "Status artifact does not mirror the active state" });
  }

  if (activeState) {
    try {
      const git = new GitRepository(cwd);
      const head = await git.head();
      const activeCommits = await commitsAfter(git, activeState.baseCommit);
      for (const commit of activeCommits) {
        if (commit.trailers.work !== activeState.id) {
          issues.push({ code: "work-untraced", path: commit.hash.slice(0, 12), message: `Commit "${commit.subject}" is not traced to work ${activeState.id}` });
        }
      }
      if (activeState.mode === "sdd") {
        await assertSddConsistency(cwd, activeState);
        if (activeState.phase === "validate") {
          const validationPath = validationFailureRecordPath(activeState.id, activeState.attempt);
          let recorded = false;
          try {
            await git.run(["cat-file", "-e", `HEAD:${validationPath}`]);
            recorded = true;
          } catch {
            // No failure record exists until `ways sdd validate` fails.
          }
          if (recorded) {
            const failure = await committedValidationFailureFailure(git, activeState.id, activeState.attempt ?? 0, head);
            if (failure) throw new Error(failure);
          }
        }
        if (activeState.remediation && activeState.attempt) {
          const path = remediationRecordPath(activeState.id, activeState.attempt);
          const transition = await remediationTransitionCommit(git, activeState.id, activeState.remediation, head);
          const value: unknown = JSON.parse(await git.run(["show", `${transition}:${path}`]));
          if (!validateRemediation(value) || value.workId !== activeState.id || value.attempt !== activeState.attempt
            || value.source !== activeState.remediation.source || value.target !== activeState.remediation.target
            || value.priorCheckpoint !== activeState.remediation.priorCheckpoint || value.reason !== activeState.remediation.reason
            || value.timestamp !== activeState.remediation.timestamp
            || JSON.stringify(value.evidence) !== JSON.stringify(activeState.remediation.evidence)) {
            throw new Error("Active remediation evidence does not match state");
          }
          const evidenceFailure = await remediationEvidenceFailure(git, value, activeState.remediation.priorCheckpoint, transition);
          if (evidenceFailure) throw new Error(evidenceFailure);
          const changed = new Set([
            ...(await git.run(["diff", "--name-only"])).split("\n"),
            ...(await git.run(["diff", "--cached", "--name-only"])).split("\n"),
            ...(await git.run(["ls-files", "--others", "--exclude-standard"])).split("\n"),
          ].filter(Boolean));
          const priorMutation = [...changed].find((candidate) => isPriorAttemptArtifact(candidate, activeState.id, activeState.attempt!));
          if (priorMutation) {
            issues.push({ code: "prior-artifact-mutated", path: priorMutation, message: "Prior SDD attempt artifacts are immutable" });
          }
        }
      } else if (activeState.mode === "outcome") {
        await assertOutcomeConsistency(cwd, activeState);
      } else if (activeState.mode === "quick" && head !== activeState.baseCommit) {
        const commit = await git.lastCommit();
        if (commit.trailers.work !== activeState.id || commit.trailers.state !== "downgraded-quick") {
          issues.push({ code: "state-git-divergence", path: STATE_PATH, message: "Work HEAD changed outside a gate" });
        }
      } else if (activeState.mode === "plan" && head !== activeState.baseCommit) {
        const commit = await git.lastCommit();
        if (commit.trailers.work !== activeState.id || commit.trailers.state !== "proposed") {
          issues.push({ code: "state-git-divergence", path: STATE_PATH, message: "Plan HEAD is not its proposal commit" });
        }
      }
    } catch {
      issues.push({ code: "state-git-divergence", path: STATE_PATH, message: "Unable to reconcile state with Git" });
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
