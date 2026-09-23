import { HARNESS_VERSION } from "../index.js";
import type { WorkState } from "../domain/types.js";
import { failedCheckDetails, runChecks } from "../check/check.js";
import { GitRepository } from "../git/git.js";
import { loadState, removeState, saveState } from "../state/store.js";
import { closeWork } from "./close.js";

function assertId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) throw new Error("Work id must be a 2-63 character lowercase slug");
}

export async function startQuick(cwd: string, id: string): Promise<WorkState> {
  assertId(id);
  if (await loadState(cwd)) throw new Error("Another mutating work is already active");
  const git = new GitRepository(cwd);
  await git.assertClean();
  const head = await git.head();
  const now = new Date().toISOString();
  const state: WorkState = {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    id,
    mode: "quick",
    status: "active",
    baseCommit: head,
    gateCommit: head,
    createdAt: now,
    updatedAt: now,
    tasks: [],
  };
  await saveState(cwd, state);
  return state;
}

export async function finishQuick(cwd: string, subject: string, _legacyMemoryDisposition?: "updated" | "unchanged"): Promise<string> {
  const state = await loadState(cwd);
  if (!state || state.mode !== "quick" || state.status !== "active") throw new Error("No active quick work");
  if (!subject.trim()) throw new Error("A concise commit message is required");

  const checks = await runChecks(cwd, false, undefined, { services: true });
  if (checks.issues.length > 0) throw new Error(checks.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  const namedFailures = failedCheckDetails(checks);
  if (namedFailures.length > 0) throw new Error(namedFailures.join("\n"));
  if (!checks.checks && checks.testExitCode !== 0) throw new Error(`Tests failed with exit code ${checks.testExitCode}`);

  return closeWork(cwd, subject.trim(), { work: state.id, state: "completed" });
}

export async function cancelQuick(cwd: string): Promise<void> {
  const state = await loadState(cwd);
  if (!state || state.mode !== "quick") throw new Error("No active quick work");
  await removeState(cwd);
}
