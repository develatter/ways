import { access, appendFile, chmod, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_VERSION } from "../version.js";
import { bootstrap } from "../bootstrap/bootstrap.js";
import { CONFIG_PATH, HOOKS_DIR, MANIFEST_PATH, workRecordPath } from "../domain/constants.js";
import type { WorkRecord } from "../domain/types.js";
import { sha256 } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { auditHistory, commitsAfter } from "../integrity/history.js";
import { checkIntegrity } from "../integrity/integrity.js";
import { readActive, readRuns } from "../runtime/runtime.js";
import { committedRecord, openRecords } from "../work/record.js";
import type { CommitInfo } from "../git/git.js";
import { DEFAULT_OUTCOME_POLICY, type ComplianceIssue, type EvalCheck, type EvalTask, type EvalWorkflow, type HarnessCompliance, type HarnessLabel, type HarnessPrompt, type OutcomeEvalPolicy, type WaysRevision } from "./types.js";

const PACKAGE_LINK = "node_modules/@develatter/ways";
const BIN_LINK = "node_modules/.bin/ways";

const GUARDRAILS = "Do not bypass hooks or edit the ways configuration, the checks or `.ways/work/`.";

export const CHANGE_PROMPT: HarnessPrompt = {
  initial: `Deliver this task as a small ways change: make the change and commit as you go (the commit hook traces your commits), then run \`npx ways done\`, which runs the configured checks once and closes the work. If it fails, fix, commit and run it again. If the task asks you to stop early, leave the work open for the next session. ${GUARDRAILS}`,
  resume: `Run \`npx ways status\`, continue the task's work, and finish it with \`npx ways done\`. ${GUARDRAILS}`,
};

const OUTCOME_FINISH = "implement and commit as you go, then run `npx ways done`; if it asks for an independent review, have a reviewer who did not implement the change review the commit it prints and record it with `npx ways review submit <file>`";

export const OUTCOME_PROMPT: HarnessPrompt = {
  initial: `Deliver this task as a ways outcome: open it with \`npx ways outcome open <task-id> --goal=<goal> --criterion=AC1:<one line> --verify=AC1:<command>... <policy-flags>\`, then ${OUTCOME_FINISH}. If the task asks you to stop early, leave the outcome open for the next session. ${GUARDRAILS}`,
  resume: `Run \`npx ways status\` and continue the task's outcome (opening it with \`npx ways outcome open <task-id> --goal=<goal> --criterion=AC1:<one line> --verify=AC1:<command>... <policy-flags>\` if none exists), then ${OUTCOME_FINISH}. ${GUARDRAILS}`,
};

function policyFlags(policy: OutcomeEvalPolicy): string {
  return `--review=${policy.review} --approval=${policy.approval}`;
}

/** The recorded prompt template of a harness, with its policy flags resolved; null for the A/B baselines. */
export function harnessPrompt(harness: HarnessLabel, policy?: OutcomeEvalPolicy): HarnessPrompt | null {
  if (harness === "lightweight-state") return CHANGE_PROMPT;
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

/** A test command that runs the task's regression checks, so `ways done` exercises real checks. */
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

/** Harness files an honest agent never changes; editing them would weaken what is being measured. */
const HARNESS_PATHS = [CONFIG_PATH, MANIFEST_PATH, HOOKS_DIR, "scripts/check.sh"];

interface GradedHistory {
  git: GitRepository;
  commits: CommitInfo[];
  activeWork: string | null;
  issues: ComplianceIssue[];
}

/**
 * Evidence every Ways harness is graded on, never what the agent claims: the
 * record audit (with untraced commits counted, since the hook traces every
 * commit), integrity, foreign works, harness tampering, uncommitted changes and
 * a still-active work. The threat model is an honest agent that may skip or
 * misuse the process, not one that subverts Git.
 */
async function gradeHistory(repo: string, taskId: string, startRevision: string): Promise<GradedHistory> {
  const git = new GitRepository(repo);
  const issues: ComplianceIssue[] = [];
  let activeWork: string | null = null;
  try {
    activeWork = readActive(repo)?.id ?? (await openRecords(git)).at(0)?.id ?? null;
  } catch (error) {
    issues.push({ code: "eval-unreadable-state", path: ".ways/work", message: error instanceof Error ? error.message : String(error) });
  }
  const commits = await commitsAfter(git, startRevision);
  issues.push(...await auditHistory(git, commits, { untraced: true }), ...await checkIntegrity(repo));
  for (const commit of commits) {
    const work = commit.trailers.work;
    if (work && work !== taskId) issues.push({ code: "eval-foreign-work", path: commit.hash.slice(0, 12), message: `Commit belongs to work ${work}, not to the task work ${taskId}` });
  }
  const tampered = (await git.run(["diff", "--name-only", startRevision, "HEAD", "--", ...HARNESS_PATHS], undefined, true)).split("\n").filter(Boolean);
  for (const path of tampered) issues.push({ code: "eval-harness-tampered", path, message: "Harness file changed after bootstrap" });
  const uncommitted = (await git.run(["status", "--porcelain"], undefined, true)).split("\n").filter(Boolean);
  if (uncommitted.length > 0) issues.push({ code: "eval-uncommitted-changes", path: ".", message: `Run ended with ${uncommitted.length} uncommitted path(s)` });
  if (activeWork !== null) issues.push({ code: "eval-active-work", path: ".ways/work", message: `Work ${activeWork} is still active` });
  return { git, commits, activeWork, issues };
}

function graded(workflow: EvalWorkflow, history: GradedHistory, fields: { completed: boolean; worksStarted: number; worksClosed: number; remediationAttempts: number; validationFailures: number; humanApprovals: number; effectivePolicy: Record<string, string> | null }): HarnessCompliance {
  return {
    applicable: true,
    workflow,
    compliant: fields.completed && history.issues.length === 0,
    ...fields,
    activeWork: history.activeWork,
    issues: history.issues,
  };
}

function worksIn(commits: readonly CommitInfo[]): number {
  return new Set(commits.map((commit) => commit.trailers.work).filter(Boolean)).size;
}

/**
 * Grades a change (C): the task's commits are traced to it and the last
 * `ways done` run passed on the final HEAD. A change leaves no record in
 * Git, so the run log in the repository's Git directory is the evidence.
 */
export async function gradeChangeCompliance(repo: string, taskId: string, startRevision: string): Promise<HarnessCompliance> {
  const history = await gradeHistory(repo, taskId, startRevision);
  const record = await committedRecord(history.git, taskId).catch(() => undefined);
  if (record?.kind === "outcome") history.issues.push({ code: "eval-workflow-mismatch", path: workRecordPath(taskId), message: "The task was opened as an outcome, not delivered as a change" });
  const runs = readRuns(repo, taskId);
  const head = await history.git.head();
  const last = runs.at(-1);
  const completed = last?.passed === true && last.input === head && history.activeWork === null;
  if (!completed) history.issues.push({ code: "eval-change-not-done", path: ".", message: `No passing \`ways done\` of ${taskId} on the final HEAD` });
  const failures = runs.filter((run) => !run.passed).length;
  return graded("change", history, {
    completed,
    worksStarted: worksIn(history.commits),
    worksClosed: completed ? 1 : 0,
    remediationAttempts: failures,
    validationFailures: failures,
    humanApprovals: record?.approval ? 1 : 0,
    effectivePolicy: null,
  });
}

/** Grades an outcome (E): the task's record is closed on a clean audit, opened with the policy the run asked for. */
export async function gradeOutcomeCompliance(repo: string, taskId: string, startRevision: string, expected: OutcomeEvalPolicy = DEFAULT_OUTCOME_POLICY): Promise<HarnessCompliance> {
  const history = await gradeHistory(repo, taskId, startRevision);
  let record: WorkRecord | undefined;
  try {
    record = await committedRecord(history.git, taskId);
  } catch (error) {
    history.issues.push({ code: "eval-record-invalid", path: workRecordPath(taskId), message: error instanceof Error ? error.message : String(error) });
  }
  if (record && record.kind !== "outcome") history.issues.push({ code: "eval-workflow-mismatch", path: workRecordPath(taskId), message: "The task's record is not an outcome" });
  const completed = record?.kind === "outcome" && record.closed !== undefined;
  if (!completed) history.issues.push({ code: "eval-outcome-not-closed", path: ".", message: `No outcome ${taskId} was closed` });
  const policy: OutcomeEvalPolicy | null = record ? { review: record.policy.review, approval: record.policy.approval } : null;
  if (policy) {
    const differing = (Object.keys(expected) as (keyof OutcomeEvalPolicy)[]).filter((field) => policy[field] !== expected[field]);
    if (differing.length > 0) history.issues.push({ code: "eval-policy-mismatch", path: workRecordPath(taskId), message: `Outcome opened with ${differing.map((field) => `${field}=${policy[field]}`).join(", ")}, not the configured ${differing.map((field) => `${field}=${expected[field]}`).join(", ")}` });
  }
  const failures = record?.evidence?.earlierRuns.filter((run) => !run.passed).length ?? readRuns(repo, taskId).filter((run) => !run.passed).length;
  return graded("outcome", history, {
    completed,
    worksStarted: worksIn(history.commits),
    worksClosed: completed ? 1 : 0,
    remediationAttempts: failures,
    validationFailures: failures,
    humanApprovals: record?.approval ? 1 : 0,
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
    remediationAttempts: 0,
    validationFailures: 0,
    humanApprovals: 0,
    effectivePolicy: null,
    activeWork: null,
    issues: [{ code: "eval-compliance-error", path: ".", message: error instanceof Error ? error.message : String(error) }],
  };
}

export const HARNESS_WORKFLOWS: Partial<Record<HarnessLabel, EvalWorkflow>> = { "lightweight-state": "change", "outcome": "outcome" };

/** Grades the workflow a Ways harness asked for; baselines are not applicable. */
export async function gradeCompliance(harness: HarnessLabel, repo: string, taskId: string, startRevision: string, policy?: OutcomeEvalPolicy): Promise<HarnessCompliance> {
  const workflow = HARNESS_WORKFLOWS[harness];
  if (!workflow) return { applicable: false, reason: `harness ${harness} does not run a Ways workflow` };
  const grade = workflow === "outcome" ? gradeOutcomeCompliance(repo, taskId, startRevision, policy) : gradeChangeCompliance(repo, taskId, startRevision);
  return grade.catch((error: unknown) => complianceGradingError(workflow, error));
}
