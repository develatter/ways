import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_VERSION } from "../index.js";
import { failedCheckDetails, runChecks } from "../check/check.js";
import { OUTCOME_DIR, STATE_PATH, STATUS_PATH } from "../domain/constants.js";
import { CHECK_NAMES, type OutcomeCriterion, type OutcomeEvaluation, type OutcomeEvidence, type OutcomeSpec, type ReviewResult, type WorkState } from "../domain/types.js";
import { validateReview, validateState } from "../domain/validation.js";
import { stableJson, writeAtomic } from "../fs/files.js";
import { GitRepository, type CommitInfo } from "../git/git.js";
import { loadState, saveState } from "../state/store.js";
import { closeWork } from "./close.js";
import { committedWorkDigest } from "./digest.js";
import { reviewBlocks } from "./review.js";

/** Trailer phases of the outcome workflow. They never collide with SDD phase names. */
export const OUTCOME_PHASES = { open: "outcome-open", execute: "outcome-execute", close: "outcome-close" } as const;

const CRITERION_ID = /^[A-Z][A-Z0-9-]{0,31}$/;

function outcomeDirectory(workId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(workId)) throw new Error("Work id must be a lowercase slug");
  return `${OUTCOME_DIR}/${workId}`;
}

export function outcomeSpecPath(workId: string): string {
  return `${outcomeDirectory(workId)}/outcome.json`;
}

function attemptDirectory(workId: string, attempt = 0): string {
  return `${outcomeDirectory(workId)}/attempts/${attempt}`;
}

export function outcomeEvidencePath(workId: string, attempt = 0): string {
  return `${attemptDirectory(workId, attempt)}/evidence.json`;
}

export function outcomeEvaluationPath(workId: string, attempt = 0): string {
  return `${attemptDirectory(workId, attempt)}/evaluation.json`;
}

export function outcomeReviewPath(workId: string, attempt = 0): string {
  return `${attemptDirectory(workId, attempt)}/reviews/latest.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCriterion(value: string): OutcomeCriterion {
  const separator = value.indexOf(":");
  const id = value.slice(0, separator).trim();
  const text = value.slice(separator + 1).trim();
  if (separator < 1 || !CRITERION_ID.test(id) || !text) throw new Error(`Criterion must look like AC1:<text>, got "${value}"`);
  return { id, text };
}

function specFailure(value: unknown, workId: string): string | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.workId !== workId) return "outcome spec does not belong to this work";
  if (typeof value.goal !== "string" || !value.goal.trim()) return "outcome spec has no goal";
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) return "outcome spec has no acceptance criteria";
  const ids = new Set<string>();
  for (const criterion of value.criteria) {
    if (!isRecord(criterion) || typeof criterion.id !== "string" || !CRITERION_ID.test(criterion.id)
      || typeof criterion.text !== "string" || !criterion.text.trim() || ids.has(criterion.id)) return "outcome spec has an invalid or duplicate criterion";
    ids.add(criterion.id);
  }
  const policy = value.policy;
  if (!isRecord(policy) || policy.isolation !== "required" || policy.independentEvaluation !== "required" || policy.checks !== "configured") {
    return "outcome spec has an unsupported policy";
  }
  return undefined;
}

function evidenceFailure(value: unknown, spec: OutcomeSpec, attempt: number): string | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.workId !== spec.workId || value.attempt !== attempt || !isRecord(value.criteria)) {
    return `evidence must be {schemaVersion: 1, workId: "${spec.workId}", attempt: ${attempt}, criteria: {...}}`;
  }
  const expected = spec.criteria.map((criterion) => criterion.id);
  const missing = expected.filter((id) => !Object.hasOwn(value.criteria as object, id));
  if (missing.length > 0) return `evidence is missing criteria: ${missing.join(", ")}`;
  const unknown = Object.keys(value.criteria).filter((id) => !expected.includes(id));
  if (unknown.length > 0) return `evidence names unknown criteria: ${unknown.join(", ")}`;
  for (const [id, entry] of Object.entries(value.criteria)) {
    if (!isRecord(entry) || typeof entry.summary !== "string" || !entry.summary.trim()) return `criterion ${id} has no evidence summary`;
    if (entry.checks !== undefined && (!Array.isArray(entry.checks) || entry.checks.some((name) => !(CHECK_NAMES as readonly unknown[]).includes(name)))) {
      return `criterion ${id} references unknown checks`;
    }
  }
  return undefined;
}

/** A criterion may cite checks; each cited check must have passed in the evaluation. */
function citedCheckFailure(evidence: OutcomeEvidence, evaluation: OutcomeEvaluation): string | undefined {
  for (const [id, entry] of Object.entries(evidence.criteria)) {
    for (const name of entry.checks ?? []) {
      const named = evaluation.checks.named?.find((check) => check.name === name);
      const passed = named ? named.status === "passed" : name === "test" && evaluation.checks.named === undefined && evaluation.checks.testExitCode === 0;
      if (!passed) return `criterion ${id} cites check ${name}, which did not pass`;
    }
  }
  return undefined;
}

async function showJson(git: GitRepository, ref: string, path: string): Promise<unknown> {
  try {
    return JSON.parse(await git.run(["show", `${ref}:${path}`]));
  } catch {
    return undefined;
  }
}

/** The commit that opened the work: the one that added its spec. */
export async function outcomeOpenCommit(git: GitRepository, workId: string, ref = "HEAD"): Promise<CommitInfo | undefined> {
  const hash = (await git.run(["log", "--format=%H", "--diff-filter=A", ref, "--", outcomeSpecPath(workId)])).split("\n").filter(Boolean).pop();
  if (!hash) return undefined;
  const commit = await git.commitInfo(hash);
  return commit.trailers.work === workId && commit.trailers.phase === OUTCOME_PHASES.open && commit.trailers.state === "opened" ? commit : undefined;
}

/** Only commits the harness integrated from task worktrees may carry production changes when isolation is required. */
function isolationFailure(commits: readonly CommitInfo[], workId: string, state: unknown): string | undefined {
  const integrated = new Set(validateState(state) ? state.tasks.flatMap((task) => task.commits) : []);
  const direct = commits.find((commit) => commit.trailers.work !== workId || !commit.trailers.task || !integrated.has(commit.hash));
  return direct ? `commit ${direct.hash.slice(0, 12)} "${direct.subject}" was not integrated from an isolated task` : undefined;
}

/**
 * Verifies everything close relies on, from committed content only: the
 * certified execution, its passing evaluation, complete criterion evidence and
 * a fresh independent review. Used by close, the commit hook and history.
 */
export async function outcomeCloseFailure(git: GitRepository, workId: string, executeCommit: string, review: unknown, attempt = 0): Promise<string | undefined> {
  const execute = await git.commitInfo(executeCommit);
  if (execute.trailers.work !== workId || execute.trailers.phase !== OUTCOME_PHASES.execute || execute.trailers.state !== "completed") {
    return "close must directly follow the certified execution";
  }
  const open = await outcomeOpenCommit(git, workId, executeCommit);
  if (!open) return "outcome work has no opening commit";
  const spec = await showJson(git, executeCommit, outcomeSpecPath(workId));
  const failure = specFailure(spec, workId);
  if (failure) return failure;
  if (stableJson(spec) !== stableJson(await showJson(git, open.hash, outcomeSpecPath(workId)))) return "goal or acceptance criteria changed after opening";
  const evidence = await showJson(git, executeCommit, outcomeEvidencePath(workId, attempt));
  const missingEvidence = evidenceFailure(evidence, spec as OutcomeSpec, attempt);
  if (missingEvidence) return missingEvidence;
  const evaluation = await showJson(git, executeCommit, outcomeEvaluationPath(workId, attempt)) as OutcomeEvaluation | undefined;
  const input = await git.parent(executeCommit);
  if (!isRecord(evaluation) || evaluation.workId !== workId || evaluation.attempt !== attempt || evaluation.inputCommit !== input
    || evaluation.inputTree !== await git.run(["rev-parse", `${input}^{tree}`])) return "evaluation does not bind the executed input";
  if (evaluation.passed !== true) return "evaluation did not pass";
  const cited = citedCheckFailure(evidence as OutcomeEvidence, evaluation);
  if (cited) return cited;
  const isolation = isolationFailure(await commitsBetween(git, open.hash, input), workId, await showJson(git, executeCommit, STATE_PATH));
  if (isolation) return isolation;
  if (!validateReview(review)) return "an independent review is required";
  if (review.workId !== workId || (review.attempt ?? 0) !== attempt || !review.reviewer.trim()) return "review does not belong to this work and attempt";
  const blockers = reviewBlocks(review);
  if (blockers.length > 0) return `review blocked by: ${blockers.join(", ")}`;
  if (review.digest !== await outcomeDigest(git, open.hash, executeCommit)) return "review is stale: it does not match the evaluated increment";
  return undefined;
}

async function commitsBetween(git: GitRepository, from: string, to: string): Promise<CommitInfo[]> {
  const hashes = (await git.run(["rev-list", "--reverse", `${from}..${to}`])).split("\n").filter(Boolean);
  return Promise.all(hashes.map((hash) => git.commitInfo(hash)));
}

/** The reviewed increment: everything from before opening through the certified execution. */
export async function outcomeDigest(git: GitRepository, openCommit: string, executeCommit: string): Promise<string> {
  return committedWorkDigest(git, await git.parent(openCommit), executeCommit);
}

function requireOutcome(state: WorkState | undefined, stage?: WorkState["stage"]): WorkState {
  if (!state || state.mode !== "outcome") throw new Error("No active outcome work");
  if (stage && state.stage !== stage) throw new Error(`Outcome work ${state.id} is in ${state.stage}, not ${stage}`);
  return state;
}

export async function assertOutcomeConsistency(cwd: string, state: WorkState): Promise<void> {
  const git = new GitRepository(cwd);
  let committed: unknown;
  try {
    committed = JSON.parse(await git.run(["show", `HEAD:${STATE_PATH}`]));
  } catch {
    committed = undefined;
  }
  if (!validateState(committed) || committed.mode !== "outcome" || committed.id !== state.id || committed.baseCommit !== state.baseCommit) {
    throw new Error("Outcome state diverged from its committed state; run ways repair");
  }
  const open = await outcomeOpenCommit(git, state.id);
  if (!open || await git.parent(open.hash) !== state.baseCommit) throw new Error("Outcome work has no opening commit on its base; run ways repair");
  if (state.stage === "evaluate") {
    const head = await git.commitInfo("HEAD");
    if (head.trailers.work !== state.id || head.trailers.phase !== OUTCOME_PHASES.execute || head.trailers.state !== "completed"
      || await git.parent(head.hash) !== state.gateCommit) {
      throw new Error("Evaluation must sit on the certified execution; run ways repair");
    }
  }
}

async function dirtyPaths(git: GitRepository): Promise<string[]> {
  const commands = [["diff", "--name-only"], ["diff", "--cached", "--name-only"], ["ls-files", "--others", "--exclude-standard"]] as const;
  const paths = new Set<string>();
  for (const command of commands) for (const path of (await git.run(command)).split("\n")) if (path) paths.add(path);
  return [...paths].sort();
}

export async function openOutcome(cwd: string, id: string, goal: string, criteria: OutcomeCriterion[]): Promise<WorkState> {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) throw new Error("Work id must be a lowercase slug");
  if (await loadState(cwd)) throw new Error("Another mutating work is already active");
  const spec: OutcomeSpec = {
    schemaVersion: 1,
    workId: id,
    goal: goal.trim(),
    criteria,
    policy: { isolation: "required", independentEvaluation: "required", checks: "configured" },
  };
  const failure = specFailure(spec, id);
  if (failure) throw new Error(failure[0]!.toUpperCase() + failure.slice(1));
  const git = new GitRepository(cwd);
  await git.assertClean();
  const head = await git.head();
  const now = new Date().toISOString();
  const state: WorkState = {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    id,
    mode: "outcome",
    status: "active",
    stage: "execute",
    baseCommit: head,
    gateCommit: head,
    createdAt: now,
    updatedAt: now,
    tasks: [],
  };
  await writeAtomic(join(cwd, outcomeSpecPath(id)), stableJson(spec));
  // A template the agent fills in; evaluation refuses any criterion left without a summary.
  const template: OutcomeEvidence = { schemaVersion: 1, workId: id, attempt: 0, criteria: Object.fromEntries(criteria.map((criterion) => [criterion.id, { summary: "" }])) };
  await writeAtomic(join(cwd, outcomeEvidencePath(id)), stableJson(template));
  await saveState(cwd, state);
  await git.commit(await git.changedPaths(), `outcome(open): ${id}`, { work: id, phase: OUTCOME_PHASES.open, state: "opened" });
  return state;
}

/** Runs the configured checks against the executed input and certifies it when they pass. */
export async function evaluateOutcome(cwd: string): Promise<{ commit: string; evaluation: OutcomeEvaluation }> {
  const state = requireOutcome(await loadState(cwd), "execute");
  await assertOutcomeConsistency(cwd, state);
  const git = new GitRepository(cwd);
  const attempt = state.attempt ?? 0;
  if (state.tasks.length === 0) throw new Error("Isolation is required: implement through at least one task (ways task add/prepare/integrate)");
  const pending = state.tasks.filter((task) => task.status !== "completed").map((task) => task.id);
  if (pending.length > 0) throw new Error(`Every task must be integrated before evaluation: ${pending.join(", ")}`);
  const open = (await outcomeOpenCommit(git, state.id))!;
  const isolation = isolationFailure(await commitsBetween(git, open.hash, "HEAD"), state.id, state);
  if (isolation) throw new Error(`Isolation is required: ${isolation}`);
  const allowed = new Set([STATE_PATH, STATUS_PATH, outcomeEvidencePath(state.id, attempt)]);
  const unrelated = (await dirtyPaths(git)).filter((path) => !allowed.has(path));
  if (unrelated.length > 0) throw new Error(`Uncommitted changes outside the evidence file block evaluation: ${unrelated.join(", ")}`);

  const spec = JSON.parse(await readFile(join(cwd, outcomeSpecPath(state.id)), "utf8")) as OutcomeSpec;
  let evidence: unknown;
  try {
    evidence = JSON.parse(await readFile(join(cwd, outcomeEvidencePath(state.id, attempt)), "utf8"));
  } catch {
    evidence = undefined;
  }
  const missing = evidenceFailure(evidence, spec, attempt);
  if (missing) throw new Error(`Map every acceptance criterion to evidence in ${outcomeEvidencePath(state.id, attempt)}: ${missing}`);

  const result = await runChecks(cwd, false, undefined, { services: true });
  const failures = [
    ...result.issues.map((issue) => `${issue.code}: ${issue.path}: ${issue.message}`),
    ...failedCheckDetails(result),
    ...(!result.checks && result.testExitCode !== 0 ? [`test: exit code ${result.testExitCode}`] : []),
  ];
  const input = await git.head();
  const evaluation: OutcomeEvaluation = {
    schemaVersion: 1,
    workId: state.id,
    attempt,
    inputCommit: input,
    inputTree: await git.run(["rev-parse", `${input}^{tree}`]),
    checks: {
      integrity: result.issues.map(({ code, path, message }) => ({ code, path, message })),
      ...(result.testExitCode !== undefined ? { testExitCode: result.testExitCode } : {}),
      ...(result.checks ? { named: result.checks } : {}),
    },
    passed: failures.length === 0,
  };
  const cited = citedCheckFailure(evidence as OutcomeEvidence, evaluation);
  if (cited) failures.push(cited);
  if (failures.length > 0) throw new Error(`Evaluation failed:\n${failures.join("\n")}`);

  await writeAtomic(join(cwd, outcomeEvaluationPath(state.id, attempt)), stableJson(evaluation));
  state.stage = "evaluate";
  state.gateCommit = input;
  state.updatedAt = new Date().toISOString();
  await saveState(cwd, state);
  const commit = await git.commit(await git.changedPaths(), `outcome(execute): complete ${state.id}`, {
    work: state.id, phase: OUTCOME_PHASES.execute, state: "completed",
  });
  return { commit, evaluation };
}

/** Digest a reviewer must bind to while the work is in evaluate. */
export async function outcomeReviewDigest(cwd: string, state: WorkState): Promise<string> {
  requireOutcome(state, "evaluate");
  await assertOutcomeConsistency(cwd, state);
  const git = new GitRepository(cwd);
  return outcomeDigest(git, (await outcomeOpenCommit(git, state.id))!.hash, await git.head());
}

export async function closeOutcome(cwd: string): Promise<string> {
  const state = requireOutcome(await loadState(cwd), "evaluate");
  await assertOutcomeConsistency(cwd, state);
  const git = new GitRepository(cwd);
  const attempt = state.attempt ?? 0;
  const allowed = new Set([STATE_PATH, STATUS_PATH, outcomeReviewPath(state.id, attempt)]);
  const unrelated = (await dirtyPaths(git)).filter((path) => !allowed.has(path));
  if (unrelated.length > 0) throw new Error(`Changes after evaluation block close; they need a new evaluation: ${unrelated.join(", ")}`);
  let review: ReviewResult | undefined;
  try {
    review = JSON.parse(await readFile(join(cwd, outcomeReviewPath(state.id, attempt)), "utf8")) as ReviewResult;
  } catch {
    review = undefined;
  }
  const failure = await outcomeCloseFailure(git, state.id, await git.head(), review, attempt);
  if (failure) throw new Error(`Close refused: ${failure}`);
  // The evaluated tree is still HEAD's; re-running the checks means a hand-written evaluation cannot close failing work.
  const checks = await runChecks(cwd, false, undefined, { services: true });
  const failing = [...checks.issues.map((issue) => `${issue.code}: ${issue.path}`), ...failedCheckDetails(checks), ...(!checks.checks && checks.testExitCode !== 0 ? [`test: exit code ${checks.testExitCode}`] : [])];
  if (failing.length > 0) throw new Error(`Close refused: checks fail on the evaluated input:\n${failing.join("\n")}`);
  for (const task of state.tasks) {
    if (task.worktree) await git.run(["worktree", "remove", "--force", task.worktree]).catch(() => undefined);
    if (task.branch) await git.run(["branch", "-D", task.branch]).catch(() => undefined);
  }
  await rm(join(cwd, ".ways", "worktrees", state.id), { recursive: true, force: true });
  return closeWork(cwd, `outcome(close): complete ${state.id}`, { work: state.id, phase: OUTCOME_PHASES.close, state: "completed" });
}

export async function cancelOutcome(cwd: string): Promise<string> {
  const state = requireOutcome(await loadState(cwd));
  const git = new GitRepository(cwd);
  for (const task of state.tasks) {
    if (task.worktree) await git.run(["worktree", "remove", "--force", task.worktree]).catch(() => undefined);
    if (task.branch) await git.run(["branch", "-D", task.branch]).catch(() => undefined);
  }
  const unrelated = (await dirtyPaths(git)).filter((path) => path !== STATE_PATH && path !== STATUS_PATH);
  if (unrelated.length > 0) throw new Error(`Commit, move or discard these changes before cancelling: ${unrelated.join(", ")}`);
  return closeWork(cwd, `outcome(cancel): ${state.id}`, { work: state.id, state: "cancelled" });
}

/** A close commit records the review and removes the state; anything else was never evaluated. */
export function closeCommitExtraPaths(changed: readonly string[], workId: string, attempt = 0): string[] {
  const allowed = new Set([STATE_PATH, STATUS_PATH, outcomeReviewPath(workId, attempt)]);
  return changed.filter((path) => !allowed.has(path));
}

export interface OutcomeReplay {
  issues: Array<{ code: string; path: string; message: string }>;
  closes: Array<{ work: string; commit: CommitInfo }>;
}

/** Ordered replay of outcome transitions: open, execute certification, then close or cancel. */
export function replayOutcomes(commits: readonly CommitInfo[]): OutcomeReplay {
  const issues: OutcomeReplay["issues"] = [];
  const closes: OutcomeReplay["closes"] = [];
  const next = new Map<string, "execute" | "close">();
  const phases = new Set<string>(Object.values(OUTCOME_PHASES));
  for (const commit of commits) {
    const { work, phase, state, task } = commit.trailers;
    if (!work) continue;
    const expected = next.get(work);
    const fail = (message: string): void => {
      issues.push({ code: "history-outcome-broken-chain", path: commit.hash.slice(0, 12), message });
    };
    if (phase && phases.has(phase)) {
      if (phase === OUTCOME_PHASES.open && state === "opened" && expected === undefined) next.set(work, "execute");
      else if (phase === OUTCOME_PHASES.execute && state === "completed" && expected === "execute") next.set(work, "close");
      else if (phase === OUTCOME_PHASES.close && state === "completed" && expected === "close") {
        next.delete(work);
        closes.push({ work, commit });
      } else fail(`Outcome transition ${phase} for ${work} is out of order`);
      continue;
    }
    if (expected === undefined) continue;
    if (state === "cancelled") {
      next.delete(work);
    } else if (expected === "execute" && !task) {
      fail(`Outcome ${work} requires isolation; "${commit.subject}" was not integrated from a task`);
    } else if (expected === "close") {
      fail(`Outcome ${work} changed after its evaluation: "${commit.subject}"`);
    }
  }
  return { issues, closes };
}

/** Recheck every close from committed content so a forged or no-verify close fails the audit. */
export async function outcomeHistoryIssues(git: GitRepository, commits: readonly CommitInfo[]): Promise<OutcomeReplay["issues"]> {
  const replay = replayOutcomes(commits);
  const issues = [...replay.issues];
  for (const { work, commit } of replay.closes) {
    const changed = (await git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", commit.hash])).split("\n").filter(Boolean);
    const extra = closeCommitExtraPaths(changed, work);
    if (extra.length > 0) {
      issues.push({ code: "history-invalid-outcome-evidence", path: commit.hash.slice(0, 12), message: `Outcome ${work} close changed more than its review: ${extra.join(", ")}` });
      continue;
    }
    const failure = await outcomeCloseFailure(git, work, await git.parent(commit.hash), await showJson(git, commit.hash, outcomeReviewPath(work)))
      .catch((error: unknown) => error instanceof Error ? error.message : String(error));
    if (failure) issues.push({ code: "history-invalid-outcome-evidence", path: commit.hash.slice(0, 12), message: `Outcome ${work} closed without valid evidence: ${failure}` });
  }
  return issues;
}
