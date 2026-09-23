import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { STATE_PATH, STATUS_PATH } from "../domain/constants.js";
import type { TaskState, WorkState } from "../domain/types.js";
import { workflowForState } from "../domain/workflow.js";
import { stableJson, writeAtomic } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { commitsAfter } from "../integrity/history.js";
import { loadState, saveState } from "../state/store.js";
import { attemptFailureCommit } from "./outcome.js";
import { parallelFailure } from "./outcome-policy.js";
import { attemptNumber, attemptPhasePath, isPriorAttemptArtifact, remediationTransitionCommit } from "./attempt.js";

function requireTaskWork(state: WorkState | undefined): WorkState {
  if (!state || (state.mode !== "sdd" && state.mode !== "outcome")) throw new Error("No active SDD or outcome work");
  return state;
}

/** Outcome work runs tasks throughout execution; SDD confines them to implement. */
function executing(state: WorkState): boolean {
  return state.mode === "outcome" ? state.stage === "execute" : state.phase === "implement";
}

function taskAttempt(task: TaskState): number {
  return attemptNumber(task.attempt);
}

function requireCurrentTask(state: WorkState, id: string): TaskState {
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Unknown task: ${id}`);
  const currentAttempt = attemptNumber(state.attempt);
  if (taskAttempt(task) !== currentAttempt) {
    throw new Error(`Task ${id} belongs to attempt ${taskAttempt(task)} and is immutable during attempt ${currentAttempt}`);
  }
  return task;
}

function taskAttemptTrailer(infoAttempt: string | undefined, attempt: number): boolean {
  return infoAttempt === String(attempt) || (attempt === 0 && infoAttempt === undefined);
}

function canAddTask(state: WorkState): boolean {
  return (state.mode === "outcome" && state.stage === "execute") || state.phase === "decompose"
    || (state.phase === "implement" && attemptNumber(state.attempt) > 0 && state.remediation?.attempt === state.attempt);
}

export async function addTask(cwd: string, id: string, title: string, dependsOn: string[] = []): Promise<TaskState> {
  const state = requireTaskWork(await loadState(cwd));
  if (!canAddTask(state)) throw new Error("Tasks can only be defined during decompose, remediated implement or outcome execution");
  if (state.mode === "outcome" && await attemptFailureCommit(new GitRepository(cwd), state.id, attemptNumber(state.attempt))) {
    throw new Error(`Attempt ${attemptNumber(state.attempt)} has a recorded evaluation failure; run ways outcome remediate --reason=<text> first`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error("Task id must be a lowercase slug");
  if (!title.trim()) throw new Error("Task title is required");
  if (state.tasks.some((task) => task.id === id)) throw new Error(`Task already exists: ${id}`);
  for (const dependency of dependsOn) {
    if (!state.tasks.some((task) => task.id === dependency)) throw new Error(`Unknown dependency: ${dependency}`);
  }
  const task: TaskState = {
    id,
    title: title.trim(),
    attempt: attemptNumber(state.attempt),
    status: dependsOn.some((dependency) => state.tasks.find((task) => task.id === dependency)?.status !== "completed") ? "pending" : "ready",
    dependsOn,
    commits: [],
  };
  state.tasks.push(task);
  state.updatedAt = new Date().toISOString();
  await saveState(cwd, state);
  return task;
}

export async function prepareTask(cwd: string, id: string): Promise<TaskState> {
  const state = requireTaskWork(await loadState(cwd));
  if (!executing(state)) throw new Error("Task worktrees can only be prepared during implement or outcome execution");
  const task = requireCurrentTask(state, id);
  const incomplete = task.dependsOn.filter((dependency) => state.tasks.find((candidate) => candidate.id === dependency)?.status !== "completed");
  if (incomplete.length > 0) throw new Error(`Incomplete dependencies: ${incomplete.join(", ")}`);
  if (task.worktree) throw new Error(`Task already prepared: ${id}`);
  if (task.status !== "ready") throw new Error(`Task is not ready: ${id}`);

  const attempt = attemptNumber(state.attempt);
  const git = new GitRepository(cwd);
  const serial = await parallelFailure(git, state, task.id);
  if (serial) throw new Error(serial);
  const branch = `ways/${state.id}/attempt-${attempt}/${task.id}`;
  const worktree = join(cwd, ".ways", "worktrees", state.id, `attempt-${attempt}`, task.id);
  await mkdir(join(cwd, ".ways", "worktrees", state.id, `attempt-${attempt}`), { recursive: true });
  await git.run(["worktree", "add", "-b", branch, worktree, "HEAD"]);
  await mkdir(join(worktree, ".ways", "runtime"), { recursive: true });
  await writeAtomic(join(worktree, ".ways", "runtime", "task.json"), stableJson({
    schemaVersion: 1,
    workId: state.id,
    attempt,
    task: { id: task.id, title: task.title, attempt, dependsOn: task.dependsOn },
    requiredTrailers: { "Harness-Work": state.id, "Harness-Task": task.id, "Harness-Attempt": String(attempt) },
  }));

  task.branch = branch;
  task.worktree = resolve(worktree);
  task.status = "active";
  state.updatedAt = new Date().toISOString();
  await saveState(cwd, state);
  return task;
}

async function priorArtifactChangedBy(git: GitRepository, commit: string, workId: string, attempt: number): Promise<string | undefined> {
  const paths = (await git.run(["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "--root", "-z", commit]))
    .split("\0").filter(Boolean);
  return paths.find((path) => isPriorAttemptArtifact(path, workId, attempt));
}

export async function integrateTask(cwd: string, id: string, commits: string[]): Promise<TaskState> {
  const state = requireTaskWork(await loadState(cwd));
  if (!executing(state)) throw new Error("Tasks can only be integrated during implement or outcome execution");
  const task = requireCurrentTask(state, id);
  if (task.status !== "active" || !task.branch || !task.worktree) throw new Error(`Task must be prepared before integration: ${id}`);
  if (commits.length === 0) throw new Error("At least one commit is required");
  const attempt = attemptNumber(state.attempt);
  const git = new GitRepository(cwd);
  for (const commit of commits) {
    const info = await git.commitInfo(commit);
    if (info.trailers.work !== state.id || info.trailers.task !== task.id || !taskAttemptTrailer(info.trailers.attempt, attempt)) {
      throw new Error(`Commit ${commit} lacks matching work/task/attempt trailers`);
    }
    if (!await git.isAncestor(info.hash, task.branch)) {
      throw new Error(`Commit ${commit} does not belong to task branch ${task.branch}`);
    }
    if (await git.isAncestor(info.hash)) throw new Error(`Commit ${commit} is already present in the orchestrator history`);
    const immutablePath = await priorArtifactChangedBy(git, info.hash, state.id, attempt);
    if (immutablePath) throw new Error(`Commit ${commit} mutates immutable prior SDD artifact: ${immutablePath}`);
  }
  for (const commit of commits) {
    await git.run(["cherry-pick", commit]);
    task.commits.push(await git.head());
  }
  task.status = "completed";
  for (const candidate of state.tasks) {
    if (taskAttempt(candidate) === attempt && candidate.status === "pending" && candidate.dependsOn.every((dependency) => state.tasks.find((item) => item.id === dependency)?.status === "completed")) {
      candidate.status = "ready";
    }
  }
  state.updatedAt = new Date().toISOString();
  await saveState(cwd, state);
  return task;
}

async function remediationTransitionAnchor(git: GitRepository, state: WorkState): Promise<string> {
  const remediation = state.remediation;
  const attempt = attemptNumber(state.attempt);
  if (!remediation || remediation.attempt !== attempt || attempt === 0) throw new Error("Remediated delegated execution lacks current attempt metadata");
  try {
    return await remediationTransitionCommit(git, state.id, remediation);
  } catch {
    throw new Error("Remediation transition is missing or does not follow its prior checkpoint");
  }
}

export async function assertDelegatedCertificationTree(cwd: string, state: WorkState): Promise<void> {
  const git = new GitRepository(cwd);
  const allowed = new Set([
    STATE_PATH,
    STATUS_PATH,
    attemptPhasePath(state.id, state.attempt, "implement"),
  ]);
  const commands = [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ] as const;
  const changed = new Set<string>();
  for (const command of commands) {
    for (const path of (await git.run(command)).split("\n")) if (path) changed.add(path);
  }
  const unrelated = [...changed].filter((path) => !allowed.has(path)).sort();
  if (unrelated.length > 0) {
    throw new Error(`Dirty or staged content outside delegated implementation orchestration blocks certification: ${unrelated.join(", ")}`);
  }
}

/** Enforce provenance from the current implementation cycle, not merely forgeable trailers or index contents. */
export async function assertDelegatedImplementation(cwd: string, state: WorkState): Promise<void> {
  const attempt = attemptNumber(state.attempt);
  const workflow = workflowForState(state);
  const currentTasks = state.tasks.filter((task) => taskAttempt(task) === attempt);
  if (currentTasks.length === 0) {
    throw new Error(attempt === 0
      ? "Delegated execution requires at least one task; declare tasks during decompose"
      : "Delegated remediation requires at least one newly integrated task");
  }
  const integrated = new Set(currentTasks.flatMap((task) => task.commits));

  const git = new GitRepository(cwd);
  const anchor = attempt === 0 ? state.gateCommit : await remediationTransitionAnchor(git, state);
  let observedIntegration = false;
  for (const commit of await commitsAfter(git, anchor)) {
    const certificationPhase = commit.trailers.phase;
    const currentCertification = commit.trailers.work === state.id
      && commit.trailers.state === "completed"
      && workflow.isPhase(certificationPhase)
      && taskAttemptTrailer(commit.trailers.attempt, attempt)
      && !commit.trailers.task;
    if (integrated.has(commit.hash)) {
      observedIntegration = true;
      continue;
    }
    if (currentCertification) continue;
    throw new Error(`Commit ${commit.hash.slice(0, 12)} "${commit.subject}" was not integrated from a task in the current attempt; the orchestrator must not implement in delegated execution`);
  }
  if (attempt > 0 && !observedIntegration) throw new Error("Delegated remediation requires at least one newly integrated task");
}
