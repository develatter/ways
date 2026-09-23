import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { runChecks, type CheckResult } from "../check/check.js";
import { loadConfig } from "../config/config.js";
import type { LegacyValidationFailureEvidence, ValidationFailureRecord, WorkState } from "../domain/types.js";
import { validateConfig, validateValidationFailure } from "../domain/validation.js";
import { sha256, stableJson, writeAtomic } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { attemptNumber, validationFailureRecordPath } from "./attempt.js";

function canonicalChecks(result: CheckResult): ValidationFailureRecord["checks"] {
  return {
    integrity: [...result.issues]
      .sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.message.localeCompare(right.message))
      .map(({ code, path, message }) => ({ code, path, message })),
    ...(result.testExitCode === undefined ? {} : { testExitCode: result.testExitCode }),
    ...(result.checks ? {
      named: result.checks.map((check) => ({
        name: check.name,
        status: check.status,
        ...(check.command ? { command: [...check.command] } : {}),
        ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
        ...(check.detail ? { detail: check.detail } : {}),
      })),
    } : {}),
    ...(result.environment ? { environment: result.environment.map((entry) => ({ ...entry })) } : {}),
  };
}

/** The exact normalized shape written by the pre-record validation path. */
export function legacyValidationEvidence(result: CheckResult): LegacyValidationFailureEvidence {
  const failures = result.issues.map((issue) => ({
    check: `integrity:${issue.code}`,
    detail: `${issue.path}: ${issue.message}`,
  }));
  if (result.testExitCode !== undefined && result.testExitCode !== 0) {
    failures.push({ check: "configured-tests", detail: `Configured test command exited with status ${result.testExitCode}` });
  }
  return { kind: "validate", failures };
}
export function validationFailureDigest(record: Omit<ValidationFailureRecord, "digest">): string {
  return sha256(stableJson(record));
}

export function validationFailureRecordFailure(record: ValidationFailureRecord): string | undefined {
  if (!validateValidationFailure(record)) return "validation failure record is invalid";
  if (record.commands && record.checks.integrity.length === 0
    && (!record.checks.named || !record.checks.named.some((check) => check.status === "failed" || check.status === "timed-out" || check.status === "unavailable"))
    && !record.checks.environment?.some((entry) => entry.status !== "passed")) {
    return "named validation failure record has no failed, timed-out, or unavailable check";
  }
  if (record.digest !== validationFailureDigest({ ...record, digest: undefined } as Omit<ValidationFailureRecord, "digest">)) {
    return "validation failure record digest does not match its exact check results";
  }
  return undefined;
}

function sameChecks(left: ValidationFailureRecord["checks"], right: ValidationFailureRecord["checks"]): boolean {
  return stableJson(left) === stableJson(right);
}

/**
 * Re-run the recorded input in a fresh detached worktree.  Never switch the
 * caller's worktree (which may contain active work) to an arbitrary commit.
 * The command remains shell-free through runChecks; local Git cannot attest
 * who authored a reproducible record, only that its claimed result is real.
 */
async function replayCleanupFailure(git: GitRepository, replayCwd: string): Promise<string | undefined> {
  try {
    await git.run(["worktree", "remove", "--force", replayCwd]);
  } catch {
    // A damaged replay worktree can make remove fail. Remove its directory,
    // then prune the registration rather than leaving admin metadata behind.
  }
  try {
    await rm(replayCwd, { recursive: true, force: true });
    await git.run(["worktree", "prune"]);
    const registered = (await git.run(["worktree", "list", "--porcelain"])).split("\n").includes(`worktree ${replayCwd}`);
    return registered ? "validation failure replay cleanup left a detached worktree registration" : undefined;
  } catch {
    return "validation failure replay cleanup could not remove its detached worktree registration";
  }
}

export async function validationFailureReplayFailure(git: GitRepository, record: ValidationFailureRecord): Promise<string | undefined> {
  const root = await git.root();
  const runtime = join(root, ".ways", "runtime");
  await mkdir(runtime, { recursive: true });
  const replayCwd = await mkdtemp(join(runtime, "validation-replay-"));
  let replayFailure: string | undefined;
  try {
    await git.run(["worktree", "add", "--detach", "--force", replayCwd, record.inputCommit]);
    const replayGit = new GitRepository(replayCwd);
    if (await replayGit.head() !== record.inputCommit || await replayGit.run(["rev-parse", "HEAD^{tree}"]) !== record.inputTree) {
      replayFailure = "validation failure replay did not resolve the recorded input commit and tree";
    } else {
      const config = await loadConfig(replayCwd);
      const testCommandMatches = JSON.stringify(config.testCommand) === JSON.stringify(record.testCommand);
      const namedCommandsMatch = JSON.stringify(config.commands) === JSON.stringify(record.commands);
      if (!testCommandMatches || !namedCommandsMatch) {
        replayFailure = "validation failure replay command contract does not match its recorded input";
      } else if (record.commands) {
        const replayed = canonicalChecks(await runChecks(replayCwd, false, record.commands, { services: true }));
        replayFailure = sameChecks(replayed, record.checks) ? undefined : "validation failure record check results cannot be reproduced from its recorded input";
      } else {
        const replayed = canonicalChecks(await runChecks(replayCwd, false, undefined, { services: true }));
        replayFailure = sameChecks(replayed, record.checks) ? undefined : "validation failure record check results cannot be reproduced from its recorded input";
      }
    }
  } catch {
    replayFailure = "validation failure record check results cannot be replayed from its recorded input";
  }
  return await replayCleanupFailure(git, replayCwd) ?? replayFailure;

}
/**
 * Legacy remediation stored only normalized failure strings in its transition.
 * Recreate that old projection at the transition's exact parent and reject it
 * unless it is byte-for-byte the claimed evidence.
 */
export async function legacyValidationFailureReplayFailure(
  git: GitRepository,
  inputCommit: string,
  evidence: LegacyValidationFailureEvidence,
): Promise<string | undefined> {
  let inputTree: string;
  try {
    inputTree = await git.run(["rev-parse", `${inputCommit}^{tree}`]);
  } catch {
    return "legacy validation failure replay cannot resolve its recorded input commit and tree";
  }
  const root = await git.root();
  const runtime = join(root, ".ways", "runtime");
  await mkdir(runtime, { recursive: true });
  const replayCwd = await mkdtemp(join(runtime, "validation-replay-"));
  let replayFailure: string | undefined;
  try {
    await git.run(["worktree", "add", "--detach", "--force", replayCwd, inputCommit]);
    const replayGit = new GitRepository(replayCwd);
    if (await replayGit.head() !== inputCommit || await replayGit.run(["rev-parse", "HEAD^{tree}"]) !== inputTree) {
      replayFailure = "legacy validation failure replay did not resolve its recorded input commit and tree";
    } else {
      const replayed = legacyValidationEvidence(await runChecks(replayCwd));
      replayFailure = stableJson(replayed) === stableJson(evidence)
        ? undefined
        : "legacy validation failure results cannot be reproduced from its recorded input";
    }
  } catch {
    replayFailure = "legacy validation failure results cannot be replayed from its recorded input";
  }
  return await replayCleanupFailure(git, replayCwd) ?? replayFailure;
}

/** Find any validation-failed commit in the active attempt, including malformed evidence that must fail closed. */
export async function validationFailureCommit(git: GitRepository, state: WorkState): Promise<string | undefined> {
  const attempt = attemptNumber(state.attempt);
  const baseline = attempt === 0 ? state.baseCommit : state.remediation?.priorCheckpoint;
  if (!baseline) return undefined;
  for (const hash of (await git.run(["rev-list", `${baseline}..HEAD`])).split("\n").filter(Boolean)) {
    const info = await git.commitInfo(hash);
    // A no-verify marker for the active work is evidence of a possible failed
    // validation. Its malformed phase or attempt must not make it disappear.
    if (info.trailers.work === state.id && info.trailers.state === "validation-failed") return hash;
  }
  return undefined;
}

async function committedFailureRecord(git: GitRepository, workId: string, attempt: number, commit: string): Promise<ValidationFailureRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await git.run(["show", `${commit}:${validationFailureRecordPath(workId, attempt)}`]));
    return validateValidationFailure(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Verify that a failure record was committed as the direct child of the exact tree it validates. */
export async function committedValidationFailureFailure(
  git: GitRepository,
  workId: string,
  attempt: number,
  commit: string,
): Promise<string | undefined> {
  const record = await committedFailureRecord(git, workId, attempt, commit);
  if (!record || record.workId !== workId || record.attempt !== attempt || record.phase !== "validate") {
    return `validation failure record is missing or mismatched at ${validationFailureRecordPath(workId, attempt)}`;
  }
  const invalid = validationFailureRecordFailure(record);
  if (invalid) return invalid;
  let parent: string;
  try {
    parent = await git.parent(commit);
  } catch {
    return "validation failure record commit has no input parent";
  }
  if (record.inputCommit !== parent || record.inputTree !== await git.run(["rev-parse", `${parent}^{tree}`])) {
    return "validation failure record does not bind its committed input tree";
  }
  const info = await git.commitInfo(commit);
  const expectedAttempt = attempt === 0 ? undefined : String(attempt);
  if (info.trailers.work !== workId || info.trailers.phase !== "validate" || info.trailers.state !== "validation-failed" || info.trailers.attempt !== expectedAttempt) {
    return "validation failure record commit trailers do not identify its work, attempt, and phase";
  }
  const path = validationFailureRecordPath(workId, attempt);
  const added = (await git.run(["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=A", "-r", commit, "--", path])).split("\n").includes(path);
  const changed = (await git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", commit])).split("\n").filter(Boolean);
  if (!added || changed.length !== 1 || changed[0] !== path) return "validation failure record commit must add only its record";
  try {
    const config: unknown = JSON.parse(await git.run(["show", `${parent}:.ways/config.json`]));
    if (!validateConfig(config) || JSON.stringify(config.testCommand) !== JSON.stringify(record.testCommand)
      || JSON.stringify(config.commands) !== JSON.stringify(record.commands)) {
      return "validation failure record command contract does not match its input tree";
    }
  } catch {
    return "validation failure record input configuration is unreadable";
  }
  return validationFailureReplayFailure(git, record);
}

export async function currentValidationFailureRecord(git: GitRepository, state: WorkState): Promise<ValidationFailureRecord> {
  const attempt = attemptNumber(state.attempt);
  const head = await git.head();
  const failure = await committedValidationFailureFailure(git, state.id, attempt, head);
  if (failure) throw new Error(`A committed validation failure record is required for remediation: ${failure}`);
  const record = await committedFailureRecord(git, state.id, attempt, head);
  if (!record) throw new Error("A committed validation failure record is required for remediation");
  return record;
}

/** Run checks against a clean committed validate input and preserve failures for deterministic replay. */
export async function recordValidationFailure(cwd: string): Promise<ValidationFailureRecord | undefined> {
  const { loadState } = await import("../state/store.js");
  const state = await loadState(cwd);
  if (!state || state.mode !== "sdd" || state.phase !== "validate") throw new Error("Validation recording requires an active SDD validate phase");
  const { assertSddConsistency } = await import("./sdd.js");
  await assertSddConsistency(cwd, state);
  const git = new GitRepository(cwd);
  await git.assertClean();
  const inputCommit = await git.head();
  const path = validationFailureRecordPath(state.id, state.attempt);
  try {
    await git.run(["cat-file", "-e", `${inputCommit}:${path}`]);
    throw new Error("Validation failure is already recorded; remediate it before recording another failure");
  } catch (error) {
    if (error instanceof Error && error.message.includes("already recorded")) throw error;
  }
  const inputTree = await git.run(["rev-parse", `${inputCommit}^{tree}`]);
  const config = await loadConfig(cwd);
  const result = await runChecks(cwd, false, undefined, { services: true });
  if (result.issues.length === 0 && result.testExitCode === 0) return undefined;
  await git.assertClean();
  const record: ValidationFailureRecord = {
    schemaVersion: 1,
    workId: state.id,
    attempt: attemptNumber(state.attempt),
    phase: "validate",
    inputCommit,
    inputTree,
    testCommand: [...config.testCommand],
    ...(config.commands ? { commands: structuredClone(config.commands) } : {}),
    checks: canonicalChecks(result),
    digest: "",
  };
  record.digest = validationFailureDigest({ ...record, digest: undefined } as Omit<ValidationFailureRecord, "digest">);
  const failure = validationFailureRecordFailure(record);
  if (failure) throw new Error(`Refusing to write ${failure}`);
  await writeAtomic(join(cwd, path), stableJson(record));
  await git.commit([path], `sdd(validate): record failure for ${state.id}`, {
    work: state.id,
    phase: "validate",
    state: "validation-failed",
    ...(attemptNumber(state.attempt) > 0 ? { attempt: String(attemptNumber(state.attempt)) } : {}),
  });
  return record;
}
