import type { IsolationPolicy, OutcomePolicy, ParallelPolicy, WorkState } from "../domain/types.js";
import { validateState } from "../domain/validation.js";
import type { CommitInfo, GitRepository } from "../git/git.js";
import { OUTCOME_PHASES, outcomeOpenCommit, outcomeSpecPath } from "./outcome.js";

export const ISOLATION_POLICIES: readonly IsolationPolicy[] = ["required", "optional"];
export const PARALLEL_POLICIES: readonly ParallelPolicy[] = ["allowed", "disabled"];

/** Execution policies chosen at open; omitted fields take the conservative defaults. */
export interface ExecutionPolicy {
  isolation?: IsolationPolicy;
  parallel?: ParallelPolicy;
}

/** The effective execution policy persisted in a new spec. */
export function effectiveExecutionPolicy(chosen: ExecutionPolicy = {}): Required<ExecutionPolicy> {
  return { isolation: chosen.isolation ?? "required", parallel: chosen.parallel ?? "allowed" };
}

/** Unsupported isolation or parallelism values; a missing parallel field reads as allowed. */
export function executionPolicyInvalid(policy: Record<string, unknown>): boolean {
  return !(ISOLATION_POLICIES as readonly unknown[]).includes(policy.isolation)
    || (policy.parallel !== undefined && !(PARALLEL_POLICIES as readonly unknown[]).includes(policy.parallel));
}

/** Policy of a committed spec, read as the conservative defaults when it is missing or malformed. */
function readPolicy(spec: unknown): Required<ExecutionPolicy> {
  const policy = typeof spec === "object" && spec !== null ? (spec as { policy?: Partial<OutcomePolicy> }).policy : undefined;
  return {
    isolation: policy?.isolation === "optional" ? "optional" : "required",
    parallel: policy?.parallel === "disabled" ? "disabled" : "allowed",
  };
}

async function specAt(git: GitRepository, ref: string, workId: string): Promise<unknown> {
  try {
    return JSON.parse(await git.run(["show", `${ref}:${outcomeSpecPath(workId)}`]));
  } catch {
    return undefined;
  }
}

/** The policy the opening commit bound to Git; later disk or commit edits cannot weaken it. */
export async function committedExecutionPolicy(git: GitRepository, workId: string, ref = "HEAD"): Promise<Required<ExecutionPolicy>> {
  const open = await outcomeOpenCommit(git, workId, ref);
  return readPolicy(open ? await specAt(git, open.hash, workId) : undefined);
}

/** Opening commits, among `commits`, whose spec makes isolation optional. */
export async function optionalIsolationOpenings(git: GitRepository, commits: readonly CommitInfo[]): Promise<Set<string>> {
  const openings = new Set<string>();
  for (const commit of commits) {
    const { work, phase, state } = commit.trailers;
    if (!work || phase !== OUTCOME_PHASES.open || state !== "opened") continue;
    if (readPolicy(await specAt(git, commit.hash, work)).isolation === "optional") openings.add(commit.hash);
  }
  return openings;
}

/**
 * Commits after opening that may carry production changes. Required isolation
 * accepts only commits the harness integrated from task worktrees; optional
 * isolation also accepts traced direct commits of the work. A task trailer
 * always claims integration, so it must be backed by the task state.
 */
export function isolationFailure(commits: readonly CommitInfo[], workId: string, state: unknown, isolation: IsolationPolicy): string | undefined {
  const integrated = new Set(validateState(state) ? state.tasks.flatMap((task) => task.commits) : []);
  const transition = (commit: CommitInfo): boolean => commit.trailers.work === workId && (commit.trailers.phase?.startsWith("outcome-") ?? false) && !commit.trailers.task;
  const accepted = (commit: CommitInfo): boolean => commit.trailers.work === workId
    && (commit.trailers.task ? integrated.has(commit.hash) : isolation === "optional");
  const direct = commits.find((commit) => !transition(commit) && !accepted(commit));
  if (!direct) return undefined;
  return isolation === "optional"
    ? `commit ${direct.hash.slice(0, 12)} "${direct.subject}" is neither a traced direct commit nor an integrated task`
    : `commit ${direct.hash.slice(0, 12)} "${direct.subject}" was not integrated from an isolated task`;
}

/** Tasks of the work prepared in a worktree and not yet integrated. */
function preparedTasks(state: WorkState, except?: string): string[] {
  return state.tasks.filter((task) => task.id !== except && task.status === "active").map((task) => task.id);
}

/** Disabled parallelism rejects preparing a task while another one is still being executed. */
export async function parallelFailure(git: GitRepository, state: WorkState, taskId: string): Promise<string | undefined> {
  if (state.mode !== "outcome") return undefined;
  const busy = preparedTasks(state, taskId);
  if (busy.length === 0 || (await committedExecutionPolicy(git, state.id)).parallel === "allowed") return undefined;
  return `Parallelism is disabled for ${state.id}: integrate ${busy.join(", ")} before preparing ${taskId}`;
}

/** Integrity: a work with disabled parallelism never holds two prepared tasks. */
export async function parallelStateFailure(git: GitRepository, state: WorkState): Promise<string | undefined> {
  const busy = preparedTasks(state);
  if (busy.length < 2 || (await committedExecutionPolicy(git, state.id)).parallel === "allowed") return undefined;
  return `Parallelism is disabled for ${state.id} but tasks run concurrently: ${busy.join(", ")}; run ways repair`;
}

/** Reads `--isolation=` and `--parallel=` from CLI arguments. */
export function parseExecutionPolicy(args: readonly string[]): ExecutionPolicy {
  const value = (name: string): string | undefined => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const isolation = value("--isolation");
  const parallel = value("--parallel");
  if (isolation !== undefined && !(ISOLATION_POLICIES as readonly string[]).includes(isolation)) throw new Error("--isolation must be required or optional");
  if (parallel !== undefined && !(PARALLEL_POLICIES as readonly string[]).includes(parallel)) throw new Error("--parallel must be allowed or disabled");
  return { ...(isolation ? { isolation: isolation as IsolationPolicy } : {}), ...(parallel ? { parallel: parallel as ParallelPolicy } : {}) };
}
