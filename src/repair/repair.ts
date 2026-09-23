import { join } from "node:path";
import type { RemediationRecord, SddPhase, WorkState } from "../domain/types.js";
import { workflowForState } from "../domain/workflow.js";
import { validateRemediation } from "../domain/validation.js";
import { STATE_PATH } from "../domain/constants.js";
import { GitRepository } from "../git/git.js";
import { auditHistory, commitsAfter, type HistoryCheckpoint } from "../integrity/history.js";
import { loadState, removeState, saveState } from "../state/store.js";
import { remediationRecordPath } from "../work/attempt.js";
import { assertSddConsistency } from "../work/sdd.js";
import { assertOutcomeConsistency } from "../work/outcome.js";

export interface RepairDiagnosis {
  consistent: boolean;
  message: string;
  state?: WorkState;
}

export async function diagnose(cwd: string): Promise<RepairDiagnosis> {
  const state = await loadState(cwd);
  if (!state) return { consistent: true, message: "No active state" };
  if (state.mode === "outcome") {
    try {
      await assertOutcomeConsistency(cwd, state);
      return { consistent: true, message: `Outcome work is consistent with Git (${state.stage})`, state };
    } catch (error) {
      return { consistent: false, message: error instanceof Error ? error.message : String(error), state };
    }
  }
  if (state.mode !== "sdd") return { consistent: true, message: `Active ${state.mode} work has valid state`, state };
  try {
    await assertSddConsistency(cwd, state);
    return { consistent: true, message: "SDD state and Git are consistent", state };
  } catch (error) {
    return { consistent: false, message: error instanceof Error ? error.message : String(error), state };
  }
}

async function checkpointsAtHead(git: GitRepository, state: WorkState): Promise<HistoryCheckpoint[]> {
  const replay = await auditHistory(git, await commitsAfter(git, state.baseCommit), state.id);
  if (replay.issues.length > 0) {
    throw new Error(`Git history cannot be adopted: ${replay.issues[0]!.message}`);
  }
  return replay.checkpoints.filter((checkpoint) => checkpoint.work === state.id);
}

async function remediationAt(git: GitRepository, checkpoint: HistoryCheckpoint): Promise<RemediationRecord> {
  const path = remediationRecordPath(checkpoint.work, checkpoint.attempt);
  const value: unknown = JSON.parse(await git.run(["show", `${checkpoint.commit.hash}:${path}`]));
  if (!validateRemediation(value)) throw new Error(`Remediation record at ${path} is invalid`);
  return value;
}

async function latestRemediation(git: GitRepository, checkpoints: readonly HistoryCheckpoint[], attempt: number): Promise<RemediationRecord | undefined> {
  const checkpoint = [...checkpoints].reverse().find((candidate) => candidate.kind === "remediation" && candidate.attempt === attempt);
  return checkpoint ? remediationAt(git, checkpoint) : undefined;
}

export async function adoptHead(cwd: string): Promise<WorkState | undefined> {
  const state = await loadState(cwd);
  if (!state || state.mode !== "sdd") throw new Error("Adopt-head requires active SDD state");
  const workflow = workflowForState(state);
  const git = new GitRepository(cwd);
  const checkpoints = await checkpointsAtHead(git, state);
  const checkpoint = checkpoints[checkpoints.length - 1];
  if (!checkpoint) throw new Error("No SDD checkpoint found in HEAD history");

  if (checkpoint.attempt === 0) delete state.attempt;
  else state.attempt = checkpoint.attempt;
  if (checkpoint.kind === "remediation") {
    const record = await remediationAt(git, checkpoint);
    state.phase = record.target;
    delete state.lastCompletedPhase;
    state.gateCommit = record.priorCheckpoint;
    state.remediation = {
      source: record.source, target: record.target, reason: record.reason, evidence: record.evidence,
      priorCheckpoint: record.priorCheckpoint, attempt: record.attempt, timestamp: record.timestamp,
    };
  } else {
    const next = workflow.nextPhase(checkpoint.phase);
    if (!next) {
      await removeState(cwd);
      return undefined;
    }
    state.lastCompletedPhase = checkpoint.phase as SddPhase;
    state.phase = next;
    state.gateCommit = await git.parent(checkpoint.commit.hash);
    const remediation = await latestRemediation(git, checkpoints, checkpoint.attempt);
    if (remediation) {
      state.remediation = {
        source: remediation.source, target: remediation.target, reason: remediation.reason, evidence: remediation.evidence,
        priorCheckpoint: remediation.priorCheckpoint, attempt: remediation.attempt, timestamp: remediation.timestamp,
      };
    } else {
      delete state.remediation;
    }
  }
  state.updatedAt = new Date().toISOString();
  await saveState(cwd, state);
  return state;
}

export async function restoreStateFromHead(cwd: string): Promise<WorkState | undefined> {
  const git = new GitRepository(cwd);
  try {
    const content = await git.run(["show", `HEAD:${STATE_PATH}`]);
    const path = join(cwd, STATE_PATH);
    const { writeAtomic } = await import("../fs/files.js");
    await writeAtomic(path, `${content}\n`);
    return loadState(cwd);
  } catch {
    await removeState(cwd);
    return undefined;
  }
}

export async function rollbackToLastGate(cwd: string, discard: boolean): Promise<string> {
  if (!discard) throw new Error("Rollback requires explicit --discard");
  const state = await loadState(cwd);
  if (!state || state.mode !== "sdd") throw new Error("Rollback requires active SDD state");
  const git = new GitRepository(cwd);
  const checkpoints = await checkpointsAtHead(git, state);
  const checkpoint = checkpoints[checkpoints.length - 1];
  if (!checkpoint) throw new Error("No completed gate or remediation checkpoint found");
  await git.run(["reset", "--hard", checkpoint.commit.hash]);
  await git.run(["clean", "-fd", "--", `.ways/sdd/${state.id}`]);
  await restoreStateFromHead(cwd);
  return checkpoint.commit.hash;
}
