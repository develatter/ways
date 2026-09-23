import { access, appendFile, chmod, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_VERSION } from "../index.js";
import { bootstrap } from "../bootstrap/bootstrap.js";
import { sha256 } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { auditHistory, commitsAfter } from "../integrity/history.js";
import { checkIntegrity } from "../integrity/integrity.js";
import { loadState } from "../state/store.js";
import { CONFIG_PATH, HOOKS_DIR, MANIFEST_PATH, STATE_PATH } from "../domain/constants.js";
import { OUTCOME_PHASES, outcomeOpenCommit, outcomeSpecPath, replayOutcomes } from "../work/outcome.js";
import { optionalIsolationOpenings } from "../work/outcome-policy.js";
import type { CommitInfo } from "../git/git.js";
import { DEFAULT_OUTCOME_POLICY, type ComplianceIssue, type EvalCheck, type EvalTask, type EvalWorkflow, type HarnessCompliance, type HarnessLabel, type HarnessPrompt, type OutcomeEvalPolicy, type WaysRevision } from "./types.js";

const PACKAGE_LINK = "node_modules/@develatter/ways";
const BIN_LINK = "node_modules/.bin/ways";

export const FULL_SDD_PROMPT: HarnessPrompt = {
  initial: "Deliver this task with Ways full SDD: run `npx ways sdd start <task-id>` and certify phases toward close. If the task asks you to stop early, leave the work active for the next session. Do not downgrade, bypass or edit gates, reviews or checks.",
  resume: "Check `npx ways status`, continue the task's SDD work (starting it with `npx ways sdd start <task-id>` if none is active) and certify it through close. Do not downgrade, bypass or edit gates, reviews or checks.",
};

/** Where the lightweight-state (C) harness asks the agent to record its evidence; an eval convention, not a Ways artifact. */
export function lightweightEvidencePath(taskId: string): string {
  return `evidence/${taskId}.json`;
}

const EVIDENCE_FORMAT = "`evidence/<task-id>.json` as `{\"schemaVersion\":1,\"task\":\"<task-id>\",\"claims\":[{\"criterion\":\"<a requirement of the task>\",\"evidence\":\"<how you verified it>\"}]}`, one claim per requirement";

export const LIGHTWEIGHT_PROMPT: HarnessPrompt = {
  initial: `Deliver this task with lightweight Ways state: run \`npx ways quick start <task-id>\`, make the change, write ${EVIDENCE_FORMAT}, then run \`npx ways quick finish --message=<summary>\`, which runs the configured checks and commits. If the task asks you to stop early, leave the quick work active for the next session. Do not bypass hooks or edit the Ways configuration or checks.`,
  resume: `Check \`npx ways status\`, continue the task's quick work (starting it with \`npx ways quick start <task-id>\` if none is active), write ${EVIDENCE_FORMAT}, and finish with \`npx ways quick finish --message=<summary>\`. Do not bypass hooks or edit the Ways configuration or checks.`,
};

const OUTCOME_STEPS = "execute the change (through `npx ways task add|prepare|integrate` when isolation is required), map every criterion in `.ways/outcomes/<task-id>/attempts/<n>/evidence.json`, run `npx ways outcome evaluate`, remediate a failed evaluation with `npx ways outcome remediate --reason=<text>`, obtain the review the evaluation policy requires (`npx ways review digest`, a reviewer who did not implement the change, `npx ways review submit <review.json>`) and run `npx ways outcome close`";

export const OUTCOME_PROMPT: HarnessPrompt = {
  initial: `Deliver this task with the Ways outcome workflow: run \`npx ways outcome open <task-id> --goal=<goal> --criterion=AC1:<text>... <policy-flags>\`, then ${OUTCOME_STEPS}. If the task asks you to stop early, leave the outcome open for the next session. Do not bypass hooks or edit the Ways configuration, checks or gates.`,
  resume: `Check \`npx ways context\`, continue the task's outcome work (opening it with \`npx ways outcome open <task-id> --goal=<goal> --criterion=AC1:<text>... <policy-flags>\` if none exists), then ${OUTCOME_STEPS}. Do not bypass hooks or edit the Ways configuration, checks or gates.`,
};

function policyFlags(policy: OutcomeEvalPolicy): string {
  return `--isolation=${policy.isolation} --parallel=${policy.parallel} --evaluation=${policy.evaluation} --memory=${policy.memory}`;
}

/** The recorded prompt template of a harness, with its policy flags resolved; null for the A/B baselines. */
export function harnessPrompt(harness: HarnessLabel, policy?: OutcomeEvalPolicy): HarnessPrompt | null {
  if (harness === "full-sdd") return FULL_SDD_PROMPT;
  if (harness === "lightweight-state") return LIGHTWEIGHT_PROMPT;
  if (harness !== "outcome") return null;
  const flags = policyFlags(policy ?? DEFAULT_OUTCOME_POLICY);
  return { initial: OUTCOME_PROMPT.initial.replaceAll("<policy-flags>", flags), resume: OUTCOME_PROMPT.resume.replaceAll("<policy-flags>", flags) };
}

export function harnessTaskPrompt(template: string, taskId: string, prompt: string): string {
  return `${template.replaceAll("<task-id>", taskId)}\n\n${prompt}`;
}

export function packageRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

async function files(root: string, directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return files(root, path);
    return entry.isFile() ? [path] : [];
  }));
  return nested.flat();
}

async function sourceRevision(root: string): Promise<Pick<WaysRevision, "sourceRevision" | "sourceRevisionReason">> {
  const git = new GitRepository(root);
  const notCheckout = { sourceRevision: null, sourceRevisionReason: "installed package is not a Git checkout; contentDigest identifies it" };
  try {
    if (await realpath(await git.run(["rev-parse", "--show-toplevel"], undefined, true)) !== await realpath(root)) return notCheckout;
    const head = await git.run(["rev-parse", "HEAD"], undefined, true);
    const dirty = (await git.run(["status", "--porcelain", "--", "src", "assets", "package.json"], undefined, true)) !== "";
    const trackedDist = (await git.run(["ls-files", "--", "dist"], undefined, true)) !== "";
    const reasons = [
      ...(dirty ? ["source has uncommitted changes"] : []),
      ...(trackedDist ? [] : ["dist/ is an untracked build that may differ from the source revision"]),
    ];
    return reasons.length === 0
      ? { sourceRevision: head }
      : { sourceRevision: head, sourceRevisionReason: `${reasons.join("; ")}; contentDigest identifies the running content` };
  } catch {
    return notCheckout;
  }
}

/** Identifies the exact Ways content a run used, whether it is a checkout or an installed package. */
export async function captureWaysRevision(root = packageRoot()): Promise<WaysRevision> {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name: string; version: string };
  const paths = [...await files(root, "dist"), ...await files(root, "assets")].sort();
  const lines = await Promise.all(paths.map(async (path) => `${path}\0${sha256(await readFile(join(root, path)))}\n`));
  return {
    packageName: manifest.name,
    packageVersion: manifest.version,
    harnessVersion: HARNESS_VERSION,
    ...await sourceRevision(root),
    contentDigest: sha256(lines.join("")),
  };
}

/** A test command that runs the task's regression checks, so SDD validation exercises real checks. */
export function regressionTestCommand(checks: readonly EvalCheck[]): string[] {
  const script = [
    "const { spawnSync } = require('node:child_process');",
    `for (const check of ${JSON.stringify(checks)}) {`,
    "  const [command, ...args] = check.command;",
    "  const result = spawnSync(command, args, { encoding: 'utf8' });",
    "  const failed = result.status !== check.expectedExitCode",
    "    || (check.expectedStdout !== undefined && result.stdout !== check.expectedStdout)",
    "    || (check.expectedStderr !== undefined && result.stderr !== check.expectedStderr);",
    "  if (failed) { console.error(`regression check ${check.id} failed`); process.exit(1); }",
    "}",
  ].join("\n");
  return ["node", "-e", script];
}

/** The Ways test command of a task: its regression checks plus the checks its environment exposes. */
export function taskTestCommand(task: EvalTask): string[] {
  return regressionTestCommand([...task.regressions, ...task.environmentChecks ?? []]);
}

/** Installs the running Ways package into a disposable repository and commits it before any session runs. */
export async function prepareWays(repo: string, task: EvalTask, gitEnv: NodeJS.ProcessEnv, root = packageRoot()): Promise<{ revision: string; waysBin: string }> {
  const cli = join(root, "dist/cli.js");
  try {
    await access(cli);
  } catch {
    throw new Error(`Ways CLI is not built at ${cli}; run npm run build before Ways harness evals`);
  }
  await bootstrap({ cwd: repo, testCommand: taskTestCommand(task) });
  await mkdir(join(repo, "node_modules/.bin"), { recursive: true });
  await mkdir(join(repo, "node_modules/@develatter"), { recursive: true });
  await symlink(root, join(repo, PACKAGE_LINK), "dir");
  // A wrapper, not a symlink: a fresh tsc build leaves dist/cli.js without the executable bit.
  await writeFile(join(repo, BIN_LINK), `#!/bin/sh\nexec node "$(dirname "$0")/${relative(join(repo, "node_modules/.bin"), join(repo, PACKAGE_LINK, "dist/cli.js"))}" "$@"\n`, "utf8");
  await chmod(join(repo, BIN_LINK), 0o755);
  let ignore = "";
  try {
    ignore = await readFile(join(repo, ".gitignore"), "utf8");
  } catch {
    // Fixtures without a .gitignore get a new one.
  }
  await appendFile(join(repo, ".gitignore"), `${ignore === "" || ignore.endsWith("\n") ? "" : "\n"}node_modules/\n`, "utf8");
  const git = new GitRepository(repo);
  await git.run(["add", "."], gitEnv, true);
  await git.run(["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "eval harness: bootstrap ways"], gitEnv, true);
  return { revision: await git.run(["rev-parse", "HEAD"], gitEnv, true), waysBin: join(repo, BIN_LINK) };
}

/** Harness files an honest agent never changes; editing them would weaken the gates being measured. */
const HARNESS_PATHS = [CONFIG_PATH, MANIFEST_PATH, HOOKS_DIR, "scripts/check.sh", "AGENTS.md"];

interface GradedHistory {
  git: GitRepository;
  commits: CommitInfo[];
  closedSdd: Set<string>;
  activeWork: string | null;
  issues: ComplianceIssue[];
  downgrades: number;
  humanApprovals: number;
  sddRemediations: number;
}

/**
 * Evidence every Ways harness is graded on, never what the agent claims: the history audit (which
 * replays SDD chains and outcome transitions, evaluations and remediations), integrity, foreign
 * works, harness tampering, uncommitted changes, a still-active work and downgrades. The threat
 * model is an honest agent that may skip or misuse the process, not one that subverts Git: that
 * is the documented local-verification limit of history checks.
 */
async function gradeHistory(repo: string, taskId: string, startRevision: string): Promise<GradedHistory> {
  const git = new GitRepository(repo);
  const issues: ComplianceIssue[] = [];
  let activeWork: string | null = null;
  try {
    activeWork = (await loadState(repo))?.id ?? null;
  } catch (error) {
    issues.push({ code: "eval-unreadable-state", path: STATE_PATH, message: error instanceof Error ? error.message : String(error) });
  }
  const commits = await commitsAfter(git, startRevision);
  const audit = await auditHistory(git, commits, activeWork ?? undefined);
  issues.push(...audit.issues, ...await checkIntegrity(repo));
  for (const commit of commits) {
    const work = commit.trailers.work;
    if (work && work !== taskId) issues.push({ code: "eval-foreign-work", path: commit.hash.slice(0, 12), message: `Commit belongs to work ${work}, not to the task work ${taskId}` });
  }
  const tampered = (await git.run(["diff", "--name-only", startRevision, "HEAD", "--", ...HARNESS_PATHS], undefined, true)).split("\n").filter(Boolean);
  for (const path of tampered) issues.push({ code: "eval-harness-tampered", path, message: "Harness file changed after bootstrap" });
  const uncommitted = (await git.run(["status", "--porcelain"], undefined, true)).split("\n").filter(Boolean);
  if (uncommitted.length > 0) issues.push({ code: "eval-uncommitted-changes", path: ".", message: `Run ended with ${uncommitted.length} uncommitted path(s)` });
  if (activeWork !== null) issues.push({ code: "eval-active-work", path: STATE_PATH, message: `Work ${activeWork} is still active` });
  const downgrades = commits.filter((commit) => commit.trailers.state?.startsWith("downgraded")).length;
  if (downgrades > 0) issues.push({ code: "eval-downgraded", path: ".", message: `SDD was downgraded ${downgrades} time(s)` });
  const closedSdd = new Set(audit.checkpoints.filter((checkpoint) => checkpoint.kind === "certification" && checkpoint.phase === "close").map((checkpoint) => checkpoint.work));
  const sddRemediations = audit.checkpoints.filter((checkpoint) => checkpoint.kind === "remediation").length;
  return { git, commits, closedSdd, activeWork, issues, downgrades, sddRemediations, humanApprovals: commits.filter((commit) => commit.trailers.state === "approved").length };
}

function graded(workflow: EvalWorkflow, history: GradedHistory, fields: { completed: boolean; worksStarted: number; worksClosed: number; remediationAttempts: number; validationFailures: number; effectivePolicy: Record<string, string> | null }): HarnessCompliance {
  return {
    applicable: true,
    workflow,
    compliant: fields.completed && history.issues.length === 0,
    ...fields,
    downgrades: history.downgrades,
    humanApprovals: history.humanApprovals,
    activeWork: history.activeWork,
    issues: history.issues,
  };
}

async function showJson(git: GitRepository, ref: string, path: string): Promise<unknown> {
  try {
    return JSON.parse(await git.run(["show", `${ref}:${path}`], undefined, true));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Commits of the task's work that belong to a different workflow than the one the harness asked for. */
function workflowMismatch(history: GradedHistory, taskId: string, workflow: EvalWorkflow): void {
  const foreign = history.commits.filter((commit) => {
    const { work, phase, state, task } = commit.trailers;
    if (work !== taskId) return false;
    const quickFinish = !phase && !task && state === "completed";
    const outcome = phase?.startsWith("outcome-") === true;
    const sdd = phase !== undefined && !outcome;
    return workflow === "quick-evidence" ? sdd || outcome : workflow === "outcome" ? sdd || quickFinish : false;
  });
  for (const commit of foreign) history.issues.push({ code: "eval-workflow-mismatch", path: commit.hash.slice(0, 12), message: `Commit "${commit.subject}" does not belong to the ${workflow} workflow the harness asked for` });
}

/** Grades full SDD (D): an SDD work named after the task certified through close, on a clean history. */
export async function gradeFullSddCompliance(repo: string, taskId: string, startRevision: string): Promise<HarnessCompliance> {
  const history = await gradeHistory(repo, taskId, startRevision);
  const sddWorks = new Set(history.commits.filter((commit) => commit.trailers.work && commit.trailers.phase && !commit.trailers.phase.startsWith("outcome-")).map((commit) => commit.trailers.work));
  const completed = history.closedSdd.has(taskId);
  if (!completed) history.issues.push({ code: "eval-sdd-not-closed", path: ".", message: `No SDD work ${taskId} was certified through close` });
  const opening = history.commits.find((commit) => commit.trailers.work === taskId && commit.trailers.phase && !commit.trailers.phase.startsWith("outcome-"));
  const state = opening ? await showJson(history.git, opening.hash, STATE_PATH) : undefined;
  const effectivePolicy = isRecord(state) && state.id === taskId
    ? { profile: typeof state.profile === "string" ? state.profile : "autonomous", execution: typeof state.execution === "string" ? state.execution : "inline" }
    : null;
  return graded("sdd", history, {
    completed,
    worksStarted: sddWorks.size,
    worksClosed: history.closedSdd.size,
    remediationAttempts: history.sddRemediations,
    validationFailures: history.commits.filter((commit) => commit.trailers.state === "validation-failed").length,
    effectivePolicy,
  });
}

function lightweightEvidenceProblem(value: unknown, taskId: string): string | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.task !== taskId || !Array.isArray(value.claims) || value.claims.length === 0) {
    return `evidence must be {schemaVersion: 1, task: "${taskId}", claims: [...]} with at least one claim`;
  }
  const empty = value.claims.findIndex((claim) => !isRecord(claim) || typeof claim.criterion !== "string" || !claim.criterion.trim() || typeof claim.evidence !== "string" || !claim.evidence.trim());
  return empty === -1 ? undefined : `claim ${empty} lacks a criterion or evidence`;
}

/**
 * Grades lightweight state (C): a Ways quick work named after the task finished through
 * `ways quick finish` (the configured checks passed and the hook traced every commit) and a
 * committed evidence file of the task's work. There is no evaluation record, review or
 * remediation: the evidence is the agent's own claim, graded only for presence and shape.
 */
export async function gradeLightweightCompliance(repo: string, taskId: string, startRevision: string): Promise<HarnessCompliance> {
  const history = await gradeHistory(repo, taskId, startRevision);
  workflowMismatch(history, taskId, "quick-evidence");
  const finishes = history.commits.filter((commit) => commit.trailers.work && !commit.trailers.phase && !commit.trailers.task && commit.trailers.state === "completed");
  const finished = finishes.some((commit) => commit.trailers.work === taskId);
  if (!finished) history.issues.push({ code: "eval-quick-not-finished", path: ".", message: `No quick work ${taskId} was finished` });
  const path = lightweightEvidencePath(taskId);
  const problem = lightweightEvidenceProblem(await showJson(history.git, "HEAD", path), taskId);
  if (problem) history.issues.push({ code: "eval-evidence-invalid", path, message: problem });
  const authors = (await history.git.run(["log", "--format=%H", `${startRevision}..HEAD`, "--", path], undefined, true)).split("\n").filter(Boolean);
  const untraced = history.commits.filter((commit) => authors.includes(commit.hash) && commit.trailers.work !== taskId);
  for (const commit of untraced) history.issues.push({ code: "eval-evidence-untraced", path, message: `Evidence changed by ${commit.hash.slice(0, 12)} outside the task work` });
  const closed = new Set(finishes.map((commit) => commit.trailers.work));
  return graded("quick-evidence", history, {
    completed: finished && problem === undefined && authors.length > 0,
    worksStarted: closed.size + (history.activeWork !== null && !closed.has(history.activeWork) ? 1 : 0),
    worksClosed: closed.size,
    remediationAttempts: 0,
    validationFailures: 0,
    effectivePolicy: null,
  });
}

/** The execution, evaluation and memory policies an outcome's opening commit bound to Git. */
async function committedOutcomePolicy(git: GitRepository, taskId: string): Promise<OutcomeEvalPolicy | null> {
  const open = await outcomeOpenCommit(git, taskId);
  const spec = open ? await showJson(git, open.hash, outcomeSpecPath(taskId)) : undefined;
  if (!isRecord(spec) || !isRecord(spec.policy)) return null;
  const policy = spec.policy;
  return {
    isolation: policy.isolation === "optional" ? "optional" : "required",
    parallel: policy.parallel === "disabled" ? "disabled" : "allowed",
    evaluation: policy.independentEvaluation === "optional" ? "self" : "independent",
    memory: policy.memory === "none" || policy.memory === "high" ? policy.memory : "normal",
  };
}

/**
 * Grades the outcome loop (E) with the same replay `ways check --history` uses: the task's outcome
 * closed on a clean history, opened with the policies the run asked for. Failed evaluations and
 * remediations are counted from their replayed records.
 */
export async function gradeOutcomeCompliance(repo: string, taskId: string, startRevision: string, expected: OutcomeEvalPolicy = DEFAULT_OUTCOME_POLICY): Promise<HarnessCompliance> {
  const history = await gradeHistory(repo, taskId, startRevision);
  workflowMismatch(history, taskId, "outcome");
  const replay = replayOutcomes(history.commits, await optionalIsolationOpenings(history.git, history.commits));
  const completed = replay.closes.some((close) => close.work === taskId);
  if (!completed) history.issues.push({ code: "eval-outcome-not-closed", path: ".", message: `No outcome ${taskId} was closed` });
  const policy = await committedOutcomePolicy(history.git, taskId);
  if (policy) {
    const differing = (Object.keys(expected) as (keyof OutcomeEvalPolicy)[]).filter((field) => policy[field] !== expected[field]);
    if (differing.length > 0) history.issues.push({ code: "eval-policy-mismatch", path: outcomeSpecPath(taskId), message: `Outcome opened with ${differing.map((field) => `${field}=${policy[field]}`).join(", ")}, not the configured ${differing.map((field) => `${field}=${expected[field]}`).join(", ")}` });
  }
  const opened = new Set(history.commits.filter((commit) => commit.trailers.phase === OUTCOME_PHASES.open && commit.trailers.state === "opened").map((commit) => commit.trailers.work));
  return graded("outcome", history, {
    completed,
    worksStarted: opened.size,
    worksClosed: new Set(replay.closes.map((close) => close.work)).size,
    remediationAttempts: replay.remediations.filter((remediation) => remediation.work === taskId).length,
    validationFailures: replay.failures.filter((failure) => failure.work === taskId).length,
    effectivePolicy: policy ? { ...policy } : null,
  });
}

/** Grading failures are compliance evidence, never a reason to discard the functional grade. */
export function complianceGradingError(workflow: EvalWorkflow, error: unknown): HarnessCompliance {
  return {
    applicable: true,
    workflow,
    compliant: false,
    completed: false,
    worksStarted: 0,
    worksClosed: 0,
    downgrades: 0,
    remediationAttempts: 0,
    validationFailures: 0,
    humanApprovals: 0,
    effectivePolicy: null,
    activeWork: null,
    issues: [{ code: "eval-compliance-error", path: ".", message: error instanceof Error ? error.message : String(error) }],
  };
}

export const HARNESS_WORKFLOWS: Partial<Record<HarnessLabel, EvalWorkflow>> = { "lightweight-state": "quick-evidence", "full-sdd": "sdd", "outcome": "outcome" };

/** Grades the workflow a Ways harness asked for; baselines are not applicable. */
export async function gradeCompliance(harness: HarnessLabel, repo: string, taskId: string, startRevision: string, policy?: OutcomeEvalPolicy): Promise<HarnessCompliance> {
  const workflow = HARNESS_WORKFLOWS[harness];
  if (!workflow) return { applicable: false, reason: `harness ${harness} does not run a Ways workflow` };
  const grade = workflow === "sdd" ? gradeFullSddCompliance(repo, taskId, startRevision)
    : workflow === "outcome" ? gradeOutcomeCompliance(repo, taskId, startRevision, policy)
      : gradeLightweightCompliance(repo, taskId, startRevision);
  return grade.catch((error: unknown) => complianceGradingError(workflow, error));
}
