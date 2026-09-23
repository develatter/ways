import { readFile } from "node:fs/promises";
import { MANIFEST_PATH, STATE_PATH } from "../domain/constants.js";
import type { RemediationRecord, WorkState } from "../domain/types.js";
import { validateApproval, validateRemediation, validateState, validateValidationFailure } from "../domain/validation.js";
import { GitRepository, parseTrailers } from "../git/git.js";
import { loadState } from "../state/store.js";
import { approvalBinds, approvalPath, requiresApproval } from "../work/approve.js";
import { attemptNumber, attemptPhasePath, attemptReviewPath, isPriorAttemptArtifact, remediationRecordPath, validationFailureRecordPath } from "../work/attempt.js";
import { remediationEvidenceFailure } from "../work/remediation.js";
import { validationFailureRecordFailure, validationFailureReplayFailure } from "../work/validation-failure.js";
import { committedMismatch } from "../work/sdd.js";
import { closeCommitExtraPaths, OUTCOME_PHASES, outcomeCloseFailure, outcomeEvaluationPath, outcomeMemoryReviewPath, outcomeReviewPath } from "../work/outcome.js";

export interface HookVerdict {
  accepted: boolean;
  reason: string;
}

const CLOSING_STATES = new Set(["completed", "cancelled"]);

async function headState(git: GitRepository): Promise<WorkState | undefined> {
  try {
    const value: unknown = JSON.parse(await git.run(["show", `HEAD:${STATE_PATH}`]));
    return validateState(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function stagesStateDeletion(git: GitRepository): Promise<boolean> {
  const output = await git.run(["diff", "--cached", "--name-only", "--diff-filter=D", "--", STATE_PATH]);
  return output.split("\n").includes(STATE_PATH);
}

/** A certification of a supervised human gate must carry a matching approval artifact in the same commit. */
async function stagedApprovalFailure(git: GitRepository, work: WorkState, committed: WorkState | undefined, phase: string): Promise<string | undefined> {
  const path = approvalPath(work.id, phase, work.attempt);
  let value: unknown;
  try {
    value = JSON.parse(await git.run(["show", `:${path}`]));
  } catch {
    return `certification of human gate ${phase} must stage a human approval at ${path}`;
  }
  if (!validateApproval(value)) return `staged approval at ${path} is invalid`;
  // The approval was written against the gate recorded by the state committed at HEAD.
  return approvalBinds(value, { workId: work.id, phase, gateCommit: committed?.gateCommit ?? await git.head(), attempt: work.attempt });
}

/** The close gate removes the SDD folder, so its approval must be present at HEAD's working tree and staged for deletion. */
async function deletedApprovalFailure(git: GitRepository, work: WorkState): Promise<string | undefined> {
  const path = approvalPath(work.id, "close", work.attempt);
  const deleted = (await git.run(["diff", "--cached", "--name-only", "--diff-filter=D", "--", path])).split("\n").includes(path);
  if (!deleted) return `closing commit must stage the deletion of a committed approval at ${path}`;
  let value: unknown;
  try {
    value = JSON.parse(await git.run(["show", `HEAD:${path}`]));
  } catch {
    return `approval at ${path} is not committed at HEAD`;
  }
  if (!validateApproval(value)) return `approval at ${path} is invalid`;
  return approvalBinds(value, { workId: work.id, phase: "close", gateCommit: work.gateCommit, attempt: work.attempt });
}

function trailerAttemptMatches(value: string | undefined, attempt: number | undefined): boolean {
  const expected = attemptNumber(attempt);
  return expected === 0 ? value === undefined || value === "0" : value === String(expected);
}

async function stagedRemediationFailure(git: GitRepository, active: WorkState, committed: WorkState | undefined): Promise<string | undefined> {
  const remediation = active.remediation;
  const attempt = attemptNumber(active.attempt);
  if (!committed || committed.mode !== "sdd" || !remediation || attempt === 0 || remediation.attempt !== attempt) {
    return "remediation state is incomplete";
  }
  if ((committed.phase !== "review" && committed.phase !== "validate") || remediation.source !== committed.phase
    || active.phase !== remediation.target || attempt !== attemptNumber(committed.attempt) + 1
    || remediation.priorCheckpoint !== await git.head() || active.gateCommit !== remediation.priorCheckpoint) {
    return "remediation state does not form the next legal transition";
  }
  const path = remediationRecordPath(active.id, attempt);
  const added = (await git.run(["diff", "--cached", "--name-only", "--diff-filter=A", "--", path])).split("\n").includes(path);
  let record: RemediationRecord | undefined;
  try {
    const value: unknown = JSON.parse(await git.run(["show", `:${path}`]));
    if (validateRemediation(value)) record = value;
  } catch {
    // Report a stable failure below.
  }
  if (!added || !record || record.workId !== active.id || record.source !== remediation.source || record.target !== remediation.target
    || record.attempt !== attempt || record.priorCheckpoint !== remediation.priorCheckpoint
    || JSON.stringify(record.evidence) !== JSON.stringify(remediation.evidence)
    || record.reason !== remediation.reason || record.timestamp !== remediation.timestamp) {
    return `must stage matching remediation evidence at ${path}`;
  }
  const tree = await git.run(["write-tree"]);
  return remediationEvidenceFailure(git, record, await git.head(), tree);
}

async function stagedPriorArtifactFailure(git: GitRepository, active: WorkState, allowed: ReadonlySet<string> = new Set()): Promise<string | undefined> {
  const attempt = attemptNumber(active.attempt);
  if (attempt === 0) return undefined;
  const changed = (await git.run(["diff", "--cached", "--name-only", "HEAD"])).split("\n").filter(Boolean);
  const protectedPath = changed.find((path) => !allowed.has(path) && isPriorAttemptArtifact(path, active.id, attempt));
  return protectedPath ? `prior SDD artifact is immutable: ${protectedPath}` : undefined;
}

function remediationTransitionArtifacts(active: WorkState): Set<string> {
  const remediation = active.remediation!;
  const sourceAttempt = attemptNumber(active.attempt) - 1;
  const allowed = new Set([remediationRecordPath(active.id, attemptNumber(active.attempt))]);
  // Legacy review remediation captures its submitted review and phase context
  // in the transition. Recorded validation failures were committed earlier.
  if (remediation.source === "review") {
    allowed.add(attemptPhasePath(active.id, sourceAttempt, remediation.source));
    allowed.add(attemptReviewPath(active.id, sourceAttempt));
  }
  return allowed;
}

async function headHasManifest(git: GitRepository): Promise<boolean> {
  try {
    await git.run(["cat-file", "-e", `HEAD:${MANIFEST_PATH}`]);
    return true;
  } catch {
    return false;
  }
}

/** Isolation is required: outside its own transitions, an outcome work only accepts integrated task commits. */
async function outcomeCommitFailure(git: GitRepository, active: WorkState, trailers: ReturnType<typeof parseTrailers>): Promise<string | undefined> {
  if (trailers.phase === OUTCOME_PHASES.open) {
    if (trailers.state !== "opened") return "opening commits carry Harness-State: opened";
    return await headState(git) ? "the work is already open" : undefined;
  }
  if (trailers.phase === OUTCOME_PHASES.execute) {
    if (trailers.state !== "completed" || active.stage !== "evaluate") return "execution is certified only by ways outcome evaluate";
    try {
      const evaluation = JSON.parse(await git.run(["show", `:${outcomeEvaluationPath(active.id, active.attempt)}`])) as { inputCommit?: string; passed?: boolean };
      if (evaluation.inputCommit !== await git.head() || evaluation.passed !== true) return "execution certification needs a passing evaluation of HEAD";
    } catch {
      return "execution certification must stage its evaluation";
    }
    return undefined;
  }
  if (active.stage !== "execute") return "the evaluated increment is frozen; close it or cancel the work";
  return trailers.task ? undefined : "isolation is required; commit in a task worktree (ways task prepare) and integrate it";
}

export async function judgeCommitMessage(cwd: string, message: string): Promise<HookVerdict> {
  const trailers = parseTrailers(message);
  const git = new GitRepository(cwd);

  const active = await loadState(cwd);
  if (active) {
    if (trailers.work === active.id) {
      const committed = await headState(git);
      const opening = trailers.state === "opened" && !committed;
      const mismatch = opening ? undefined : committedMismatch(committed, active);
      if (mismatch) return { accepted: false, reason: `${mismatch}; run ways repair` };
      if (!trailerAttemptMatches(trailers.attempt, active.attempt)) {
        return { accepted: false, reason: `Commit attempt does not match active remediation attempt ${attemptNumber(active.attempt)}` };
      }
      if (trailers.state === "validation-failed") {
        if (trailers.phase !== "validate" || active.phase !== "validate") {
          return { accepted: false, reason: "Validation failure trailers do not match the active validate phase" };
        }
        const path = validationFailureRecordPath(active.id, active.attempt);
        const changed = (await git.run(["diff", "--cached", "--name-only", "HEAD"])).split("\n").filter(Boolean);
        if (changed.length !== 1 || changed[0] !== path) {
          return { accepted: false, reason: `Validation failure must stage only ${path}` };
        }
        try {
          const value: unknown = JSON.parse(await git.run(["show", `:${path}`]));
          if (!validateValidationFailure(value) || validationFailureRecordFailure(value) || value.workId !== active.id
            || value.attempt !== attemptNumber(active.attempt) || value.inputCommit !== await git.head()
            || value.inputTree !== await git.run(["rev-parse", "HEAD^{tree}"])) {
            return { accepted: false, reason: "Validation failure record does not bind the current committed input" };
          }
          const replayFailure = await validationFailureReplayFailure(git, value);
          if (replayFailure) return { accepted: false, reason: replayFailure };
        } catch {
          return { accepted: false, reason: "Validation failure record is unreadable" };
        }
      } else if (trailers.state?.startsWith("remediated")) {
        const remediation = active.remediation;
        if (!trailers.state.startsWith("remediated-") || !remediation || trailers.phase !== remediation.source || trailers.state !== `remediated-${remediation.target}`) {
          return { accepted: false, reason: "Remediation trailers do not match active remediation state" };
        }
        const failure = await stagedRemediationFailure(git, active, committed);
        if (failure) return { accepted: false, reason: `Remediation of ${active.id}: ${failure}` };
        const immutable = await stagedPriorArtifactFailure(git, active, remediationTransitionArtifacts(active));
        if (immutable) return { accepted: false, reason: immutable };
      } else {
        const failure = await stagedPriorArtifactFailure(git, active);
        if (failure) return { accepted: false, reason: failure };
      }
      if (active.mode === "outcome") {
        const failure = await outcomeCommitFailure(git, active, trailers);
        if (failure) return { accepted: false, reason: `Outcome ${active.id}: ${failure}` };
        return { accepted: true, reason: `Commit traced to active outcome work ${active.id}` };
      }
      const certified = active.lastCompletedPhase;
      const certifying = trailers.state === "completed" && certified !== undefined && trailers.phase === certified;
      if (certifying && requiresApproval({ ...active, phase: certified })) {
        const failure = await stagedApprovalFailure(git, active, committed, trailers.phase!);
        if (failure) return { accepted: false, reason: `Human gate ${trailers.phase} of ${active.id}: ${failure}` };
      }
      return { accepted: true, reason: `Commit traced to active ${active.mode} work ${active.id}` };
    }
    return { accepted: false, reason: `Active ${active.mode} work is ${active.id}; commit through the harness so it carries Harness-Work: ${active.id}` };
  }

  const closing = await headState(git);
  if (closing) {
    const traced = trailers.work === closing.id && trailers.state !== undefined && CLOSING_STATES.has(trailers.state);
    const phased = closing.mode === "outcome"
      ? trailers.state === "cancelled" || trailers.phase === OUTCOME_PHASES.close
      : closing.mode !== "sdd" || trailers.state === "cancelled" || trailers.phase === "close";
    if (traced && phased && trailerAttemptMatches(trailers.attempt, closing.attempt) && await stagesStateDeletion(git)) {
      if (closing.mode === "outcome" && trailers.phase === OUTCOME_PHASES.close) {
        const extra = closeCommitExtraPaths((await git.run(["diff", "--cached", "--name-only", "HEAD"])).split("\n").filter(Boolean), closing.id, closing.attempt);
        if (extra.length > 0) return { accepted: false, reason: `Close of outcome ${closing.id} may only record its review: ${extra.join(", ")}` };
        const staged = async (path: string): Promise<unknown> => {
          try {
            return JSON.parse(await git.run(["show", `:${path}`]));
          } catch {
            return undefined;
          }
        };
        const failure = await outcomeCloseFailure(git, closing.id, await git.head(), await staged(outcomeReviewPath(closing.id, closing.attempt)),
          closing.attempt ?? 0, await staged(outcomeMemoryReviewPath(closing.id, closing.attempt)));
        if (failure) return { accepted: false, reason: `Close of outcome ${closing.id} refused: ${failure}` };
      }
      if (trailers.phase === "close" && requiresApproval({ ...closing, phase: "close" })) {
        const failure = await deletedApprovalFailure(git, closing);
        if (failure) return { accepted: false, reason: `Human gate close of ${closing.id}: ${failure}` };
      }
      return { accepted: true, reason: `Closing commit for ${closing.id}` };
    }
    return { accepted: false, reason: `HEAD still records work ${closing.id}; only its closing commit, deleting ${STATE_PATH}, may follow. Run ways repair diagnose` };
  }

  if (!await headHasManifest(git)) return { accepted: true, reason: "Bootstrap commit accepted" };
  return { accepted: false, reason: "No active work. Open one first, for example: ways quick start <id>" };
}

export async function runCommitMsgHook(cwd: string, messagePath: string): Promise<HookVerdict> {
  const raw = await readFile(messagePath, "utf8");
  const message = raw.split("\n").filter((line) => !line.startsWith("#")).join("\n");
  return judgeCommitMessage(cwd, message);
}
