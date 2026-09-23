import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTCOME_DIR, STATE_PATH, STATUS_PATH } from "../domain/constants.js";
import type { Mode, OutcomeEvaluation, OutcomeEvidence, OutcomeSpec, TaskState, WorkState } from "../domain/types.js";
import { validateReview } from "../domain/validation.js";
import { GitRepository } from "../git/git.js";
import { buildIndexes } from "../knowledge/indexes.js";
import { queryKnowledgeResult } from "../query/query.js";
import { diagnose } from "../repair/repair.js";
import { loadState } from "../state/store.js";
import { OUTCOME_PHASES, outcomeDigest, outcomeEvaluationPath, outcomeEvidencePath, outcomeOpenCommit, outcomeReviewPath, outcomeSpecPath } from "../work/outcome.js";
import { reviewBlocks } from "../work/review.js";

/**
 * A resumable, read-only packet of operational facts. Every field is derived
 * from Git, the state file and committed evidence; nothing carries a clock.
 */
export interface ContextPacket {
  schemaVersion: 1;
  head: string | null;
  divergence: string | null;
  active: ActiveContext | null;
  outcomes: OutcomeListing[];
  knowledge: KnowledgeLink[];
}

export interface TaskContext {
  id: string;
  title: string;
  attempt: number;
  status: TaskState["status"];
  dependsOn: string[];
  commits: string[];
  /** True only when the task has commits and every one is reachable from HEAD. */
  integrated: boolean;
  worktree: string | null;
}

export interface ActiveContext {
  id: string;
  mode: Exclude<Mode, "query">;
  status: WorkState["status"];
  stage: WorkState["stage"] | null;
  phase: WorkState["phase"] | null;
  lastCompletedPhase: WorkState["lastCompletedPhase"] | null;
  attempt: number;
  profile: WorkState["profile"] | null;
  execution: WorkState["execution"] | null;
  planPath: string | null;
  /** Why a remediation attempt reopened the work; null at attempt zero. */
  remediation: WorkState["remediation"] | null;
  baseCommit: string;
  gateCommit: string;
  uncommitted: string[];
  tasks: TaskContext[];
  readyTasks: string[];
  outcome: OutcomeContext | null;
}

export type EvaluationStatus = "absent" | "stale" | "passed" | "failed";

export interface OutcomeContext {
  goal: string | null;
  specPath: string;
  evidencePath: string;
  criteria: Array<{ id: string; text: string; evidence: "missing" | "filled"; summary: string | null; checks: string[]; evaluation: EvaluationStatus }>;
  evaluation: { status: EvaluationStatus; path: string; inputCommit: string | null; changedSinceInput: string[] };
  review: { status: "absent" | "invalid" | "stale" | "pass" | "fail"; path: string; blockers: string[] };
  blockers: string[];
}

export interface OutcomeListing {
  id: string;
  status: "open" | "closed" | "cancelled" | "incomplete";
  goal: string | null;
  commit: string | null;
}

export interface KnowledgeLink {
  path: string;
  title: string;
}

async function tryRun(git: GitRepository, args: readonly string[]): Promise<string | undefined> {
  try {
    return await git.run(args);
  } catch {
    return undefined;
  }
}

async function committedJson(git: GitRepository, path: string, ref = "HEAD"): Promise<unknown> {
  const content = await tryRun(git, ["show", `${ref}:${path}`]);
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

async function workingJson(cwd: string, path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(cwd, path), "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function uncommittedPaths(git: GitRepository): Promise<string[]> {
  const paths = new Set<string>();
  for (const args of [["diff", "--name-only"], ["diff", "--cached", "--name-only"], ["ls-files", "--others", "--exclude-standard"]]) {
    for (const path of (await tryRun(git, args) ?? "").split("\n")) if (path) paths.add(path);
  }
  return [...paths].sort();
}

async function taskContexts(git: GitRepository, state: WorkState): Promise<{ tasks: TaskContext[]; ready: string[] }> {
  const tasks: TaskContext[] = [];
  for (const task of state.tasks) {
    let integrated = task.commits.length > 0;
    for (const commit of task.commits) if (integrated && !await git.isAncestor(commit)) integrated = false;
    tasks.push({
      id: task.id, title: task.title, attempt: task.attempt ?? 0, status: task.status, dependsOn: [...task.dependsOn],
      commits: [...task.commits], integrated, worktree: task.worktree ?? null,
    });
  }
  // A dependency counts only when its commits are really in HEAD, not merely marked completed.
  const done = new Set(tasks.filter((task) => task.status === "completed" && task.integrated).map((task) => task.id));
  const attempt = state.attempt ?? 0;
  const ready = tasks
    .filter((task) => task.attempt === attempt && (task.status === "ready" || task.status === "pending") && task.dependsOn.every((id) => done.has(id)))
    .map((task) => task.id);
  return { tasks, ready };
}

async function outcomeContext(cwd: string, git: GitRepository, state: WorkState, head: string, uncommitted: string[], tasks: TaskContext[]): Promise<OutcomeContext> {
  const attempt = state.attempt ?? 0;
  const specPath = outcomeSpecPath(state.id);
  const evidencePath = outcomeEvidencePath(state.id, attempt);
  const evaluationPath = outcomeEvaluationPath(state.id, attempt);
  const reviewPath = outcomeReviewPath(state.id, attempt);
  const spec = await committedJson(git, specPath) as OutcomeSpec | undefined;
  const evidence = await workingJson(cwd, evidencePath) as OutcomeEvidence | undefined;
  const evaluation = await committedJson(git, evaluationPath) as OutcomeEvaluation | undefined;

  let evaluationStatus: EvaluationStatus = "absent";
  let changedSinceInput: string[] = [];
  if (isRecord(evaluation)) {
    const input = typeof evaluation.inputCommit === "string" ? evaluation.inputCommit : undefined;
    const tree = input ? await tryRun(git, ["rev-parse", `${input}^{tree}`]) : undefined;
    const diff = tree ? await tryRun(git, ["diff", "--name-only", input!, head]) : undefined;
    if (evaluation.workId !== state.id || evaluation.attempt !== attempt || !tree || tree !== evaluation.inputTree || diff === undefined) {
      evaluationStatus = "stale";
    } else {
      // Mirror close: the certified execution commit may add only its evidence, evaluation and state;
      // afterwards only state, status and the review may be dirty. Anything else needs a new evaluation.
      const certification = head !== input && await tryRun(git, ["rev-parse", `${head}^`]).then((parent) => parent?.trim() === input);
      const committedAllowed = new Set(certification ? [STATE_PATH, STATUS_PATH, evidencePath, evaluationPath] : []);
      const dirtyAllowed = new Set([STATE_PATH, STATUS_PATH, reviewPath]);
      changedSinceInput = [...new Set([
        ...diff.split("\n").filter((path) => path && !committedAllowed.has(path)),
        ...uncommitted.filter((path) => !dirtyAllowed.has(path)),
      ])].sort();
      evaluationStatus = changedSinceInput.length > 0 ? "stale" : evaluation.passed === true ? "passed" : "failed";
    }
  }

  const criteria = (Array.isArray(spec?.criteria) ? spec.criteria : []).map((criterion) => {
    const entry = isRecord(evidence) && isRecord(evidence.criteria) ? evidence.criteria[criterion.id] : undefined;
    const summary = isRecord(entry) && typeof entry.summary === "string" && entry.summary.trim() ? entry.summary : null;
    const checks = isRecord(entry) && Array.isArray(entry.checks) ? (entry.checks as unknown[]).filter((name): name is string => typeof name === "string") : [];
    let status = evaluationStatus;
    if (status === "passed") {
      const named = evaluation!.checks?.named;
      const citedFailed = checks.some((name) => {
        const check = named?.find((candidate) => candidate.name === name);
        return check ? check.status !== "passed" : !(name === "test" && named === undefined && evaluation!.checks?.testExitCode === 0);
      });
      if (citedFailed) status = "failed";
    }
    return { id: criterion.id, text: criterion.text, evidence: summary ? "filled" as const : "missing" as const, summary, checks, evaluation: status };
  });

  const review: OutcomeContext["review"] = { status: "absent", path: reviewPath, blockers: [] };
  const reviewValue = await workingJson(cwd, reviewPath);
  if (reviewValue !== undefined) {
    if (!validateReview(reviewValue)) review.status = "invalid";
    else {
      const headInfo = await git.commitInfo(head);
      const open = await outcomeOpenCommit(git, state.id);
      const certified = headInfo.trailers.work === state.id && headInfo.trailers.phase === OUTCOME_PHASES.execute && headInfo.trailers.state === "completed";
      const fresh = certified && open && reviewValue.workId === state.id && (reviewValue.attempt ?? 0) === attempt
        && reviewValue.digest === await outcomeDigest(git, open.hash, head);
      review.blockers = reviewBlocks(reviewValue);
      review.status = !fresh ? "stale" : review.blockers.length > 0 ? "fail" : "pass";
    }
  }

  const blockers: string[] = [];
  const openTasks = tasks.filter((task) => task.attempt === attempt && !(task.status === "completed" && task.integrated)).map((task) => task.id);
  if (state.stage === "execute") {
    if (tasks.length === 0) blockers.push("no tasks: execution requires at least one isolated task");
    if (openTasks.length > 0) blockers.push(`tasks not integrated: ${openTasks.join(", ")}`);
  }
  const missing = criteria.filter((criterion) => criterion.evidence === "missing").map((criterion) => criterion.id);
  if (missing.length > 0) blockers.push(`criteria without evidence: ${missing.join(", ")}`);
  if (evaluationStatus !== "passed") blockers.push(`evaluation ${evaluationStatus}${changedSinceInput.length > 0 ? ` (changed since input: ${changedSinceInput.join(", ")})` : ""}`);
  if (review.status !== "pass") blockers.push(`review ${review.status}`);

  return {
    goal: typeof spec?.goal === "string" ? spec.goal : null,
    specPath,
    evidencePath,
    criteria,
    evaluation: { status: evaluationStatus, path: evaluationPath, inputCommit: isRecord(evaluation) && typeof evaluation.inputCommit === "string" ? evaluation.inputCommit : null, changedSinceInput },
    review,
    blockers,
  };
}

async function outcomeListings(git: GitRepository, active: WorkState | undefined): Promise<OutcomeListing[]> {
  const listed = await tryRun(git, ["ls-tree", "-d", "--name-only", "HEAD", `${OUTCOME_DIR}/`]);
  const ids = (listed ?? "").split("\n").filter(Boolean).map((path) => path.slice(OUTCOME_DIR.length + 1)).sort();
  const listings: OutcomeListing[] = [];
  for (const id of ids) {
    const spec = await committedJson(git, outcomeSpecPath(id));
    const goal = isRecord(spec) && typeof spec.goal === "string" ? spec.goal : null;
    if (active?.mode === "outcome" && active.id === id) {
      listings.push({ id, status: "open", goal, commit: null });
      continue;
    }
    const last = (await tryRun(git, ["log", "-1", "--format=%H", `--grep=^Harness-Work: ${id}$`, "HEAD"]))?.trim();
    const info = last ? await git.commitInfo(last) : undefined;
    const status = info?.trailers.phase === OUTCOME_PHASES.close && info.trailers.state === "completed" ? "closed"
      : info?.trailers.state === "cancelled" ? "cancelled" : "incomplete";
    listings.push({ id, status, goal, commit: status === "incomplete" ? null : info!.hash });
  }
  return listings;
}

async function knowledgeLinks(cwd: string, text: string): Promise<KnowledgeLink[]> {
  try {
    // Built in memory: the derived cache on disk is never rewritten by context.
    const indexes = await buildIndexes(cwd);
    const result = await queryKnowledgeResult(cwd, text, { limit: 5, indexes, freshness: async () => [] });
    const titles = new Map(indexes.catalog.documents.map((document) => [document.path, document.title]));
    return result.hits.map((hit) => ({ path: hit.path, title: titles.get(hit.path.replace(/^\.ways\/knowledge\//, "")) ?? hit.path }));
  } catch {
    return [];
  }
}

export async function buildContext(cwd: string): Promise<ContextPacket> {
  const git = new GitRepository(cwd);
  const head = (await tryRun(git, ["rev-parse", "--verify", "-q", "HEAD"]))?.trim() || null;
  let state: WorkState | undefined;
  let divergence: string | null = null;
  try {
    state = await loadState(cwd);
    if (state && head) {
      const diagnosis = await diagnose(cwd);
      if (!diagnosis.consistent) divergence = diagnosis.message;
    }
  } catch (error) {
    divergence = error instanceof Error ? error.message : String(error);
  }

  let active: ActiveContext | null = null;
  if (state && head) {
    const uncommitted = await uncommittedPaths(git);
    const { tasks, ready } = await taskContexts(git, state);
    active = {
      id: state.id,
      mode: state.mode,
      status: state.status,
      stage: state.stage ?? null,
      phase: state.phase ?? null,
      lastCompletedPhase: state.lastCompletedPhase ?? null,
      attempt: state.attempt ?? 0,
      profile: state.profile ?? null,
      execution: state.execution ?? null,
      planPath: state.planPath ?? null,
      remediation: state.remediation ?? null,
      baseCommit: state.baseCommit,
      gateCommit: state.gateCommit,
      uncommitted,
      tasks,
      readyTasks: ready,
      outcome: state.mode === "outcome" ? await outcomeContext(cwd, git, state, head, uncommitted, tasks) : null,
    };
  }

  const topic = active?.outcome?.goal ?? state?.id.replace(/-/g, " ");
  return {
    schemaVersion: 1,
    head,
    divergence,
    active,
    outcomes: head ? await outcomeListings(git, state) : [],
    knowledge: topic ? await knowledgeLinks(cwd, topic) : [],
  };
}

/** Human-readable rendering of the same packet. */
export function renderContext(packet: ContextPacket): string {
  const lines = [`Ways context (schema ${packet.schemaVersion})`, `HEAD: ${packet.head ?? "none"}`];
  if (packet.divergence) lines.push(`DIVERGENCE: ${packet.divergence}`);
  const active = packet.active;
  if (!active) lines.push("Active work: none");
  else {
    const where = active.stage ? `stage ${active.stage}` : active.phase ? `phase ${active.phase}` : active.status;
    lines.push(`Active work: ${active.id} (${active.mode}, ${where}, attempt ${active.attempt}${active.profile ? `, ${active.profile}` : ""}${active.execution ? `, ${active.execution}` : ""})`);
    if (active.lastCompletedPhase) lines.push(`Last completed phase: ${active.lastCompletedPhase}`);
    if (active.planPath) lines.push(`Plan: ${active.planPath}`);
    lines.push(`Gate commit: ${active.gateCommit}`);
    if (active.uncommitted.length > 0) lines.push(`Uncommitted: ${active.uncommitted.join(", ")}`);
    const outcome = active.outcome;
    if (outcome) {
      lines.push(`Goal: ${outcome.goal ?? "(spec missing)"}`, "Criteria:");
      for (const criterion of outcome.criteria) {
        lines.push(`  ${criterion.id}: ${criterion.text} [evidence ${criterion.evidence}, evaluation ${criterion.evaluation}]`);
      }
      lines.push(`Evaluation: ${outcome.evaluation.status}${outcome.evaluation.inputCommit ? ` (input ${outcome.evaluation.inputCommit})` : ""}`);
      if (outcome.evaluation.changedSinceInput.length > 0) lines.push(`  changed since input: ${outcome.evaluation.changedSinceInput.join(", ")}`);
      lines.push(`Review: ${outcome.review.status}${outcome.review.blockers.length > 0 ? ` (blocked by ${outcome.review.blockers.join(", ")})` : ""}`);
      lines.push(`Blockers: ${outcome.blockers.length > 0 ? outcome.blockers.join("; ") : "none"}`);
    }
    lines.push(`Tasks: ${active.tasks.length === 0 ? "none" : ""}`);
    for (const task of active.tasks) {
      const deps = task.dependsOn.length > 0 ? ` after ${task.dependsOn.join(", ")}` : "";
      lines.push(`  ${task.id} [${task.status}${task.integrated ? ", integrated" : ""}]${deps}: ${task.title}`);
    }
    lines.push(`Ready tasks: ${active.readyTasks.length > 0 ? active.readyTasks.join(", ") : "none"}`);
  }
  if (packet.outcomes.length > 0) {
    lines.push("Outcomes:");
    for (const outcome of packet.outcomes) lines.push(`  ${outcome.id} [${outcome.status}]${outcome.goal ? `: ${outcome.goal}` : ""}`);
  }
  if (packet.knowledge.length > 0) {
    lines.push("Knowledge:");
    for (const link of packet.knowledge) lines.push(`  ${link.path} — ${link.title}`);
  }
  return `${lines.join("\n").replace(/ +$/gm, "")}\n`;
}
