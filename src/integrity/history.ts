import { MANIFEST_PATH } from "../domain/constants.js";
import type { RemediationRecord, RemediationTarget, SddPhase } from "../domain/types.js";
import { sddWorkflow } from "../domain/workflow.js";
import { validateRemediation } from "../domain/validation.js";
import { loadConfig } from "../config/config.js";
import { GitRepository, type CommitInfo } from "../git/git.js";
import { loadState } from "../state/store.js";
import { attemptPhasePath, attemptReviewPath, isPriorAttemptArtifact, remediationRecordPath } from "../work/attempt.js";
import { remediationEvidenceFailure } from "../work/remediation.js";
import { committedValidationFailureFailure } from "../work/validation-failure.js";
import { outcomeHistoryIssues } from "../work/outcome.js";
import type { IntegrityIssue } from "./integrity.js";

export interface HistoryOptions {
  since?: string;
  to?: string;
}

export interface HistoryCheckpoint {
  work: string;
  attempt: number;
  kind: "certification" | "remediation";
  commit: CommitInfo;
  phase: SddPhase;
  target?: RemediationTarget;
}


export async function manifestIntroduction(git: GitRepository): Promise<string | undefined> {
  const output = await git.run(["log", "--format=%H", "--diff-filter=A", "--", MANIFEST_PATH]);
  const hashes = output.split("\n").filter(Boolean);
  return hashes[hashes.length - 1];
}

async function resolveAnchor(cwd: string, git: GitRepository, since?: string): Promise<string | undefined> {
  if (since) return git.run(["rev-parse", "--verify", `${since}^{commit}`]);
  try {
    const config = await loadConfig(cwd);
    if (config.historySince) return git.run(["rev-parse", "--verify", `${config.historySince}^{commit}`]);
  } catch {
    // Missing config is reported by checkIntegrity.
  }
  return manifestIntroduction(git);
}

export async function commitsAfter(git: GitRepository, anchor: string, to = "HEAD"): Promise<CommitInfo[]> {
  const output = await git.run(["rev-list", "--topo-order", "--reverse", `${anchor}..${to}`]);
  const commits: CommitInfo[] = [];
  for (const hash of output.split("\n").filter(Boolean)) commits.push(await git.commitInfo(hash));
  return commits;
}

interface ReplayState {
  attempt: number;
  nextPhase: SddPhase;
  validationFailed: boolean;
}

function issue(issues: IntegrityIssue[], commit: CommitInfo, code: string, message: string): void {
  issues.push({ code, path: commit.hash.slice(0, 12), message });
}

function parsedAttempt(value: string | undefined): number | undefined {
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const attempt = Number(value);
  return Number.isSafeInteger(attempt) ? attempt : undefined;
}

/** Replay ordered SDD history. A set is insufficient because repeated and backward gates are invalid. */
export function replayCommits(commits: readonly CommitInfo[], activeId?: string): { issues: IntegrityIssue[]; checkpoints: HistoryCheckpoint[] } {
  const workflow = sddWorkflow();
  const issues: IntegrityIssue[] = [];
  const checkpoints: HistoryCheckpoint[] = [];
  const replay = new Map<string, ReplayState>();
  const opened = new Map<string, string>();

  for (const commit of commits) {
    const { work, phase, state } = commit.trailers;
    // Harness-Work alone traces a commit: inline implementation and semantic-memory
    // commits are not SDD transitions, so they carry no state or task. SDD commits
    // are still replayed strictly below; unrecognized states are ignored.
    if (!work) {
      issue(issues, commit, "history-untraced", `Commit "${commit.subject}" lacks a Harness-Work trailer`);
      continue;
    }
    if (state === "opened") opened.set(work, commit.hash.slice(0, 12));
    else if (state === "completed" || state === "cancelled") opened.delete(work);

    const current = replay.get(work) ?? { attempt: 0, nextPhase: workflow.initialPhase, validationFailed: false };
    if (commit.trailers.task && parsedAttempt(commit.trailers.attempt) !== current.attempt) {
      issue(issues, commit, "history-attempt-mismatch", `Task commit for ${work} does not belong to remediation attempt ${current.attempt}`);
      continue;
    }
    if (state === "approved" && (phase !== current.nextPhase || parsedAttempt(commit.trailers.attempt) !== current.attempt)) {
      issue(issues, commit, "history-attempt-mismatch", `Approval commit for ${work} does not belong to the current phase and remediation attempt`);
      continue;
    }
    if (state === "validation-failed") {
      const attempt = parsedAttempt(commit.trailers.attempt);
      if (phase !== "validate" || attempt === undefined || attempt !== current.attempt || current.nextPhase !== "validate" || current.validationFailed) {
        issue(issues, commit, "history-invalid-validation-failure", `Validation failure record for ${work} is not in validate of attempt ${current.attempt}`);
      } else {
        replay.set(work, { ...current, validationFailed: true });
      }
      continue;
    }
    const remediationMatch = state?.match(/^remediated-(.+)$/);
    if (state?.startsWith("remediated") && !remediationMatch) {
      issue(issues, commit, "history-invalid-remediation", `Remediation transition for ${work} has a malformed Harness-State trailer`);
      continue;
    }
    if (remediationMatch) {
      const target = remediationMatch[1] as RemediationTarget;
      const attempt = parsedAttempt(commit.trailers.attempt);
      if (phase !== current.nextPhase || !workflow.canRemediate(phase, target)
        || attempt === undefined || attempt !== current.attempt + 1) {
        issue(issues, commit, "history-invalid-remediation", `Remediation transition for ${work} is not a legal ${current.nextPhase} attempt ${current.attempt + 1} transition`);
        continue;
      }
      replay.set(work, { attempt, nextPhase: target, validationFailed: false });
      checkpoints.push({ work, attempt, kind: "remediation", commit, phase: phase as SddPhase, target });
      continue;
    }

    if (state !== "completed" || !workflow.isPhase(phase)) continue;
    const attempt = parsedAttempt(commit.trailers.attempt);
    const completed = phase;
    if (current.validationFailed) {
      issue(issues, commit, "history-broken-chain", `Certification of ${completed} for ${work} bypasses a validation failure in attempt ${current.attempt}; remediation is required`);
      continue;
    }
    if (attempt === undefined || attempt !== current.attempt || completed !== current.nextPhase) {
      issue(issues, commit, "history-broken-chain", `Certification of ${completed} for ${work} is out of order for attempt ${current.attempt}; expected ${current.nextPhase}`);
      continue;
    }
    const next = workflow.nextPhase(completed);
    if (next) replay.set(work, { attempt: current.attempt, nextPhase: next, validationFailed: false });
    else replay.delete(work);
    checkpoints.push({ work, attempt, kind: "certification", commit, phase: completed });
  }

  for (const [work, path] of opened) {
    if (work !== activeId) issues.push({ code: "history-abandoned-opening", path, message: `Supervised work ${work} was opened but never certified or closed` });
  }
  return { issues, checkpoints };
}

export function auditCommits(commits: readonly CommitInfo[], activeId?: string): IntegrityIssue[] {
  return replayCommits(commits, activeId).issues;
}

/**
 * v1 remediation commits used Harness-State: remediated and put source/target
 * only in their committed record.  Hydrate that record before ordered replay;
 * new commits are deliberately required to carry the explicit trailers.
 */
async function hydrateLegacyRemediations(git: GitRepository, commits: readonly CommitInfo[]): Promise<CommitInfo[]> {
  return Promise.all(commits.map(async (commit) => {
    if (commit.trailers.state !== "remediated" || !commit.trailers.work) return commit;
    const attempt = parsedAttempt(commit.trailers.attempt);
    if (attempt === undefined || attempt === 0) return commit;
    try {
      const path = remediationRecordPath(commit.trailers.work, attempt);
      const value: unknown = JSON.parse(await git.run(["show", `${commit.hash}:${path}`]));
      if (!validateRemediation(value) || value.workId !== commit.trailers.work || value.attempt !== attempt) return commit;
      return {
        ...commit,
        trailers: { ...commit.trailers, phase: value.source, state: `remediated-${value.target}` },
      };
    } catch {
      return commit;
    }
  }));
}

async function remediationEvidenceIssues(git: GitRepository, checkpoints: readonly HistoryCheckpoint[]): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.kind !== "remediation" || !checkpoint.target) continue;
    const path = remediationRecordPath(checkpoint.work, checkpoint.attempt);
    let record: RemediationRecord | undefined;
    try {
      const added = (await git.run(["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=A", "-r", checkpoint.commit.hash, "--", path])).split("\n").includes(path);
      const value: unknown = JSON.parse(await git.run(["show", `${checkpoint.commit.hash}:${path}`]));
      if (added && validateRemediation(value)) record = value;
    } catch {
      // Report one stable issue below.
    }
    let parent: string | undefined;
    try {
      parent = await git.parent(checkpoint.commit.hash);
    } catch {
      // A transition cannot be a root commit.
    }
    if (!record || !parent || record.workId !== checkpoint.work || record.source !== checkpoint.phase || record.target !== checkpoint.target
      || record.attempt !== checkpoint.attempt || record.priorCheckpoint !== parent) {
      issue(issues, checkpoint.commit, "history-invalid-remediation-evidence", `Remediation attempt ${checkpoint.attempt} for ${checkpoint.work} lacks matching transition evidence at ${path}`);
      continue;
    }
    try {
      const failure = await remediationEvidenceFailure(git, record, parent, checkpoint.commit.hash);
      if (failure) issue(issues, checkpoint.commit, "history-invalid-remediation-evidence", failure);
    } catch {
      issue(issues, checkpoint.commit, "history-invalid-remediation-evidence", `Remediation attempt ${checkpoint.attempt} evidence cannot be bound to its transition tree`);
    }
  }
  return issues;
}

async function validationFailureIssues(git: GitRepository, commits: readonly CommitInfo[]): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  for (const commit of commits) {
    if (commit.trailers.state !== "validation-failed") continue;
    const attempt = parsedAttempt(commit.trailers.attempt);
    if (!commit.trailers.work || commit.trailers.phase !== "validate" || attempt === undefined) {
      issue(issues, commit, "history-invalid-validation-failure", "Validation failure record has malformed work, attempt, or phase trailers");
      continue;
    }
    const failure = await committedValidationFailureFailure(git, commit.trailers.work, attempt, commit.hash);
    if (failure) issue(issues, commit, "history-invalid-validation-failure", failure);
  }
  return issues;
}

async function legacyTransitionArtifacts(git: GitRepository, commit: CommitInfo, work: string, attempt: number): Promise<Set<string>> {
  const allowed = new Set<string>();
  if (commit.trailers.state !== "remediated") return allowed;
  try {
    const value: unknown = JSON.parse(await git.run(["show", `${commit.hash}:${remediationRecordPath(work, attempt)}`]));
    if (!validateRemediation(value) || value.workId !== work || value.attempt !== attempt) return allowed;
    allowed.add(remediationRecordPath(work, attempt));
    const sourceAttempt = attempt - 1;
    if (value.source === "review") {
      allowed.add(attemptPhasePath(work, sourceAttempt, "review"));
      allowed.add(attemptReviewPath(work, sourceAttempt));
    } else if (value.evidence.kind === "validate" && !("failureRecord" in value.evidence)) {
      // v1 validation remediation captured its inline failure marker in the
      // previous validate artifact. New transitions link a prior committed
      // validation-failure record and must not receive this exception.
      allowed.add(attemptPhasePath(work, sourceAttempt, "validate"));
    }
  } catch {
    // The remediation evidence check reports malformed legacy records.
  }
  return allowed;
}

async function priorArtifactMutationIssues(git: GitRepository, commits: readonly CommitInfo[]): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  for (const commit of commits) {
    const { work, phase, state } = commit.trailers;
    const attempt = parsedAttempt(commit.trailers.attempt);
    if (!work || attempt === undefined || attempt === 0 || state === "cancelled"
      || (state === "completed" && phase === "close")) continue;
    const allowed = new Set<string>();
    if (state?.startsWith("remediated-") && (phase === "review" || phase === "validate")) {
      const sourceAttempt = attempt - 1;
      allowed.add(remediationRecordPath(work, attempt));
      if (phase === "review") {
        allowed.add(attemptPhasePath(work, sourceAttempt, phase));
        allowed.add(attemptReviewPath(work, sourceAttempt));
      }
    }
    for (const path of await legacyTransitionArtifacts(git, commit, work, attempt)) allowed.add(path);
    const changed = (await git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", commit.hash])).split("\n").filter(Boolean);
    const protectedPath = changed.find((path) => !allowed.has(path) && isPriorAttemptArtifact(path, work, attempt));
    if (protectedPath) issue(issues, commit, "history-prior-artifact-mutated", `Prior SDD artifact was modified during attempt ${attempt}: ${protectedPath}`);
  }
  return issues;
}

/**
 * An untraced merge commit (for example GitHub's "Merge pull request") that
 * adds nothing beyond its parents is an integration event, not authored work:
 * its parents are audited on their own. A merge with its own changes (an evil
 * merge or a conflict resolution) still needs a trailer.
 */
async function isCleanUntracedMerge(git: GitRepository, commit: CommitInfo): Promise<boolean> {
  if (commit.trailers.work) return false;
  const parents = (await git.run(["show", "-s", "--format=%P", commit.hash])).split(" ").filter(Boolean);
  if (parents.length < 2) return false;
  return (await git.run(["show", "--cc", "--format=", commit.hash])) === "";
}

export async function auditHistory(git: GitRepository, allCommits: readonly CommitInfo[], activeId?: string): Promise<{ issues: IntegrityIssue[]; checkpoints: HistoryCheckpoint[] }> {
  const clean = await Promise.all(allCommits.map((commit) => isCleanUntracedMerge(git, commit)));
  const commits = allCommits.filter((_, index) => !clean[index]);
  const replayCommitsInput = await hydrateLegacyRemediations(git, commits);
  const replayed = replayCommits(replayCommitsInput, activeId);
  return { ...replayed, issues: [
    ...replayed.issues,
    ...await remediationEvidenceIssues(git, replayed.checkpoints),
    ...await validationFailureIssues(git, commits),
    ...await priorArtifactMutationIssues(git, commits),
    ...await outcomeHistoryIssues(git, commits),
  ] };
}

export async function checkHistory(cwd: string, options: HistoryOptions = {}): Promise<IntegrityIssue[]> {
  const git = new GitRepository(cwd);
  const anchor = await resolveAnchor(cwd, git, options.since);
  if (!anchor) return [];
  let activeId: string | undefined;
  try {
    activeId = (await loadState(cwd))?.id;
  } catch {
    // An unreadable state is reported by checkIntegrity.
  }
  return (await auditHistory(git, await commitsAfter(git, anchor, options.to), activeId)).issues;
}
