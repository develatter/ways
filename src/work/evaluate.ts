import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { runChecks } from "../check/check.js";
import { committedContract, effectiveContract } from "../check/contract.js";
import { execute, executeWithRetries, type CapturedResult } from "../check/process.js";
import { cleanCheckout, DEPENDENCY_DIRS } from "../check/sandbox.js";
import { loadConfig, verifierPaths } from "../config/config.js";
import { CONFIG_PATH, DEFAULT_VERIFIER_PATHS, WAYS_DIR, WORK_DIR } from "../domain/constants.js";
import { STRENGTHS, type ApprovalsConfig, type BaselineResult, type CheckContract, type Criterion, type CriterionEvidence, type EnvironmentResult, type EvaluationMode, type Evidence, type RunnerInfo, type Strength, type TestsRatchet } from "../domain/types.js";
import type { GitRepository } from "../git/git.js";
import { matchesAny } from "../memory/glob.js";
import { quarantine, readBaseline, recordTestsRan, testsRanAt, writeBaseline, type BaselineRun } from "../runtime/ledger.js";
import { HARNESS_VERSION } from "../version.js";

const DEFAULT_VERIFIER_TIMEOUT_MS = 120_000;
/** A failing check or verifier runs again this many times before the failure is recorded. */
export const RETRIES = 2;
/** The pseudo-path a test-count drop is accepted under, like a changed test file. */
export const TESTS_RAN = "tests-ran";

/**
 * Existing verifier-surface files (tests, check configuration, CI) that the
 * increment modified or deleted. Added files are free: adding tests never
 * needs approval. `extra` are exact paths that count too (the files a
 * criterion's verifier names).
 */
export async function verifierChanges(git: GitRepository, base: string, input: string, globs: readonly string[], extra: readonly string[] = []): Promise<string[]> {
  const output = await git.run(["diff", "--name-status", "--no-renames", "-z", base, input, "--"]);
  const fields = output.split("\0").filter(Boolean);
  const changed: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    const path = fields[index + 1]!;
    if (!(status.startsWith("M") || status.startsWith("D") || status.startsWith("T")) || path.startsWith(`${WORK_DIR}/`) || !(matchesAny(path, globs) || extra.includes(path))) continue;
    // Structured files count only when the part that decides what is verified changes.
    const watched = WATCHED_FIELDS[path];
    if (watched && await watchedValue(git, base, path, watched) === await watchedValue(git, input, path, watched)) continue;
    changed.push(path);
  }
  return changed.sort();
}

/**
 * The ways config counts when what decides verification changes (commands,
 * verifier globs, review and approval policy, where evaluations run, the
 * reviewer), not its version; `package.json` when its scripts change (not a
 * dependency bump).
 */
const WATCHED_FIELDS: Record<string, readonly string[]> = {
  [CONFIG_PATH]: ["testCommand", "commands", "verifierPaths", "review", "evaluation", "approvals", "reviewer"],
  "package.json": ["scripts"],
};

async function watchedValue(git: GitRepository, ref: string, path: string, names: readonly string[]): Promise<string> {
  try {
    const value = JSON.parse(await git.run(["show", `${ref}:${path}`])) as Record<string, unknown>;
    return JSON.stringify(names.map((name) => value[name] ?? null));
  } catch {
    return "unreadable";
  }
}

/** The base's config as committed, or undefined when it has none (the work installs ways). */
export async function baseConfig(git: GitRepository, base: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await git.run(["show", `${base}:${CONFIG_PATH}`]));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The verifier globs as the base configured them, so an increment cannot narrow them for itself. */
export async function baseVerifierPaths(git: GitRepository, base: string, current: readonly string[]): Promise<readonly string[]> {
  const config = await baseConfig(git, base);
  if (!config) return current;
  const globs = config.verifierPaths;
  return Array.isArray(globs) && globs.every((glob) => typeof glob === "string") ? globs as string[] : DEFAULT_VERIFIER_PATHS;
}

/** Repository paths a verifier's arguments name that exist in `ref`: a script or test it runs is on the surface. */
export async function verifierFiles(git: GitRepository, ref: string, criteria: readonly Criterion[]): Promise<string[]> {
  const files = new Set<string>();
  for (const criterion of criteria) {
    for (const arg of criterion.verify?.slice(1) ?? []) {
      const path = arg.replace(/^\.\//, "");
      if (!/^[\w@.][\w@./-]*$/.test(path) || path.includes("..") || !path.includes("/") && !path.includes(".")) continue;
      if (await git.pathExists(ref, path)) files.add(path);
    }
  }
  return [...files].sort();
}

/** `e2e` when the verifier is plainly an end-to-end run, `test` otherwise; `--strength` overrides. */
export function inferStrength(verify: readonly string[]): Strength {
  return /(^|[^a-z])(e2e|playwright|cypress)([^a-z]|$)/i.test(verify.join(" ")) ? "e2e" : "test";
}

export interface EvaluationInput {
  cwd: string;
  git: GitRepository;
  base: string;
  criteria: readonly Criterion[];
  /** Work id, for the quarantine keys of its verifiers. */
  work?: string;
  /** `clean` (default) runs in a clean checkout of HEAD; `fast` in the working tree, without red-on-base. */
  mode?: EvaluationMode;
  /** The agent's notes per criterion, the only part of the evidence it writes. */
  notes?: Readonly<Record<string, string>>;
  /** Evaluate this commit instead of HEAD (`ways verify`). */
  input?: string;
}

function output(run: CapturedResult & { attempts?: number }): Partial<CriterionEvidence> {
  return {
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    ...(run.detail ? { detail: run.detail } : {}),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(run.outputSha256 ? { outputSha256: run.outputSha256 } : {}),
    ...(run.tail !== undefined ? { tail: run.tail } : {}),
    ...(run.attempts && run.attempts > 1 ? { attempts: run.attempts } : {}),
  };
}

/**
 * The tests the base ran, from this machine's ledger: the base itself, or the
 * nearest first-parent ancestor reached through commits that only touch
 * `.ways/` (record commits change no code, so their counts carry over).
 */
async function testsBaseline(cwd: string, git: GitRepository, base: string): Promise<{ commit: string; ran: number } | undefined> {
  const commits = (await git.run(["rev-list", "--first-parent", "--max-count=20", base])).split("\n").filter(Boolean);
  for (const commit of commits) {
    const ran = testsRanAt(cwd, commit);
    if (ran !== undefined) return { commit, ran };
    const touched = (await git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit])).split("\n").filter(Boolean);
    if (touched.some((path) => !path.startsWith(`${WAYS_DIR}/`))) return undefined;
  }
  return undefined;
}

async function runSetupIn(dir: string, setup: string[], timeoutMs: number): Promise<EnvironmentResult> {
  const run = await execute(setup, dir, timeoutMs, true, "capture");
  return {
    kind: "setup",
    name: "setup",
    status: run.status === "passed" ? "passed" : run.status,
    command: [...setup],
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    detail: run.status === "passed" ? `ran in the clean checkout (${run.durationMs ?? 0} ms)` : `${run.detail ?? "failed"}${run.tail ? `: ${run.tail.split("\n").slice(-3).join(" | ")}` : ""}`,
  };
}

/** Runs each verifier on the base once (cached per base and command) to see that it fails there. */
async function baselines(cwd: string, git: GitRepository, base: string, criteria: readonly Criterion[], contract: CheckContract, timeoutMs: number): Promise<Map<string, BaselineRun>> {
  const results = new Map<string, BaselineRun>();
  const missing = criteria.filter((criterion) => {
    const cached = readBaseline(cwd, base, JSON.stringify(criterion.verify));
    if (cached) results.set(criterion.id, cached);
    return !cached;
  });
  if (missing.length === 0) return results;
  const setup = contract.commands?.setup;
  let setupResult: EnvironmentResult | undefined;
  const checkout = await cleanCheckout(git, base, {
    ...(setup ? { setup, runSetup: async (dir) => (setupResult = await runSetupIn(dir, setup, timeoutMs)).status === "passed" } : {}),
  });
  try {
    for (const criterion of missing) {
      let run: BaselineRun;
      if (setupResult && setupResult.status !== "passed") {
        run = { status: "error", detail: `the setup failed on the base: ${setupResult.detail ?? setupResult.status}` };
      } else {
        const result = await execute(criterion.verify!, checkout.dir, timeoutMs, true, "capture");
        // A verifier that cannot even start on the base (its script is added by the work) fails there.
        run = {
          status: result.status === "passed" ? "passed" : "failed",
          ...output(result) as Pick<BaselineRun, "exitCode" | "durationMs" | "outputSha256" | "tail" | "detail">,
        };
        writeBaseline(cwd, base, JSON.stringify(criterion.verify), run);
      }
      results.set(criterion.id, run);
    }
  } finally {
    checkout.release();
  }
  return results;
}

/**
 * Runs, once, everything `done` relies on against a committed input: in a
 * clean checkout of it (default) or the working tree (`fast`), with the check
 * contract of the base (an increment cannot loosen its own checks): integrity,
 * the checks (with setup and services), every criterion's verifier, and each
 * verifier again on the base, where it must fail. A failure is retried twice
 * before it is recorded; a pass after a failure is recorded as flaky. The
 * result is the evidence; the agent never writes it, except a note per
 * criterion.
 */
export async function evaluate({ cwd, git, base, criteria, work, mode = "clean", notes = {}, input: requested }: EvaluationInput): Promise<Evidence> {
  const config = await loadConfig(cwd);
  const input = requested ?? await git.head();
  const tree = await git.treeId(input);
  const fromBase = await committedContract(git, base);
  const contract = fromBase ?? effectiveContract(config);
  const timeoutMs = contract.commands?.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS;
  const clean = mode === "clean" || requested !== undefined && requested !== await git.head();
  const setup = contract.commands?.setup;
  let setupResult: EnvironmentResult | undefined;
  const checkout = clean
    ? await cleanCheckout(git, input, { ...(setup ? { setup, runSetup: async (dir) => (setupResult = await runSetupIn(dir, setup, timeoutMs)).status === "passed" } : {}) })
    : undefined;
  const dir = checkout?.dir ?? cwd;
  const flaky: string[] = [];
  const evidence: Record<string, CriterionEvidence> = {};
  let result: Awaited<ReturnType<typeof runChecks>>;
  try {
    if (setupResult && setupResult.status !== "passed") {
      result = { issues: [], checks: [], environment: [setupResult], passed: false };
    } else {
      const cachedDetail = checkout?.setupCached ? checkout.dependencies : setupResult?.detail;
      result = await runChecks(dir, { services: true, capture: true, contract, retries: RETRIES, ...(cachedDetail && setup ? { setupCached: cachedDetail } : {}) });
    }
    for (const [id, failure] of Object.entries(result.flaky ?? {})) {
      flaky.push(id);
      const check = result.checks.find((entry) => entry.id === id);
      quarantine(cwd, { key: id, command: check?.command ?? [], lastAt: new Date().toISOString(), lastCommit: input, ...(failure.tail ? { tail: failure.tail } : {}) });
    }
    for (const criterion of criteria) {
      const note = notes[criterion.id] ? { note: notes[criterion.id]! } : {};
      if (!criterion.verify) {
        evidence[criterion.id] = { id: criterion.id, strength: criterion.strength, effective: "review-only", status: "review-only", ...note };
        continue;
      }
      if (!result.passed && (result.issues.length > 0 || (result.environment ?? []).some((entry) => entry.status !== "passed"))) {
        evidence[criterion.id] = { id: criterion.id, strength: criterion.strength, status: "failed", command: [...criterion.verify], detail: result.issues.length > 0 ? "Skipped because integrity checks failed" : "Skipped because the environment is not healthy", ...note };
        continue;
      }
      const run = await executeWithRetries(criterion.verify, dir, timeoutMs, true, RETRIES);
      if (run.flakyFailure) {
        flaky.push(criterion.id);
        quarantine(cwd, { key: `${work ?? "work"}/${criterion.id}`, command: [...criterion.verify], lastAt: new Date().toISOString(), lastCommit: input, ...(run.flakyFailure.tail ? { tail: run.flakyFailure.tail } : {}) });
      }
      evidence[criterion.id] = { id: criterion.id, strength: criterion.strength, status: run.status === "passed" ? "passed" : "failed", command: [...criterion.verify], ...output(run), runs: [criterion.id], ...note };
    }
  } finally {
    checkout?.release();
  }

  // Red on the base: a verifier that already passes before the work does not show the work did anything.
  const verified = criteria.filter((criterion) => criterion.verify && evidence[criterion.id]?.status === "passed");
  if (verified.length > 0) {
    const runs = clean ? await baselines(cwd, git, base, verified, contract, timeoutMs) : undefined;
    for (const criterion of verified) {
      const entry = evidence[criterion.id]!;
      const run = runs?.get(criterion.id);
      const baseline: BaselineResult = run
        ? { id: `${criterion.id}@base`, commit: base, ...run }
        : { id: `${criterion.id}@base`, commit: base, status: "not-run", detail: "--fast: `ways verify` checks the base in CI" };
      entry.baseline = baseline;
      entry.runs = [criterion.id, baseline.id];
      entry.effective = baseline.status === "passed" || baseline.status === "error" ? "review-only" : criterion.strength;
    }
  }

  const surface = await baseVerifierPaths(git, base, verifierPaths(config));
  const changes = await verifierChanges(git, base, input, surface, await verifierFiles(git, base, criteria));
  const testCheck = result.checks.find((check) => check.name === "test");
  let tests: TestsRatchet | undefined;
  if (testCheck?.tests !== undefined) {
    const baseline = await testsBaseline(cwd, git, base);
    tests = { ran: testCheck.tests, ...(baseline ? { baseline } : {}), dropped: baseline !== undefined && testCheck.tests < baseline.ran };
    if (testCheck.status === "passed") recordTestsRan(cwd, input, testCheck.tests);
  }
  const passed = result.passed && Object.values(evidence).every((entry) => entry.status !== "failed");
  const approvals = ((await baseConfig(git, base)) ?? config as unknown as Record<string, unknown>).approvals as ApprovalsConfig | undefined;
  const runner: RunnerInfo = {
    clean,
    platform: platform(),
    arch: arch(),
    node: process.version,
    ways: HARNESS_VERSION,
    dependencies: checkout ? (setup ? (checkout.setupCached ? checkout.dependencies : "setup") : missingDependencies(checkout.dir) ?? checkout.dependencies) : "the working tree's own",
    contractFrom: fromBase ? "base" : "input",
  };
  return {
    base,
    input: { commit: input, tree },
    contract,
    integrity: result.issues,
    checks: result.checks,
    ...(result.environment ? { environment: result.environment } : {}),
    criteria: evidence,
    verifierChanges: changes,
    passed,
    ranAt: new Date().toISOString(),
    earlierRuns: [],
    runner,
    ...(tests ? { tests } : {}),
    ...(flaky.length > 0 ? { flaky } : {}),
    approvals: { signature: approvals?.signature === "required" ? "required" : "optional", verifierChanges: approvals?.verifierChanges === "human" ? "human" : "human-or-review" },
  };
}

const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "Pipfile"];

/** "none (...)" when the checkout got no dependencies although a manifest says the project has some. */
function missingDependencies(dir: string): string | undefined {
  const found = MANIFESTS.find((name) => existsSync(join(dir, name)));
  if (!found || DEPENDENCY_DIRS.some((name) => existsSync(join(dir, name)))) return undefined;
  return `none (${found} is there, but no \`commands.setup\` is configured and the working tree has nothing to link)`;
}

/** Criteria by the strength the evidence supports: what backs what was delivered. */
export function strengthSummary(evidence: Pick<Evidence, "criteria">): string {
  const counts = new Map<Strength, number>();
  for (const entry of Object.values(evidence.criteria)) {
    const strength = entry.effective ?? (entry.status === "review-only" ? "review-only" : entry.strength);
    counts.set(strength, (counts.get(strength) ?? 0) + 1);
  }
  return STRENGTHS.filter((strength) => counts.has(strength)).map((strength) => `${counts.get(strength)} ${strength}`).join(", ");
}

/** One line per failure, with the tail of its output, for the agent to act on. */
export function evidenceFailures(evidence: Evidence): string[] {
  const lines: string[] = [];
  for (const issue of evidence.integrity) lines.push(`integrity ${issue.code}: ${issue.path}: ${issue.message}`);
  for (const entry of evidence.environment ?? []) {
    if (entry.status !== "passed") lines.push(`${entry.kind === "setup" ? "setup" : `service ${entry.name}`}: ${entry.status}${entry.detail ? ` — ${entry.detail}` : ""}${entry.log ? ` [log: ${entry.log}]` : ""}`);
  }
  for (const check of evidence.checks) {
    if (check.status === "passed" || check.status === "skipped") continue;
    lines.push(`check ${check.name}: ${check.status}${check.exitCode === undefined ? "" : ` (exit ${check.exitCode})`}${check.attempts ? ` after ${check.attempts} attempts` : ""}${check.detail ? ` — ${check.detail}` : ""}`);
    if (check.tail) lines.push(...indent(check.tail));
  }
  for (const [id, entry] of Object.entries(evidence.criteria)) {
    if (entry.status !== "failed") continue;
    lines.push(`criterion ${id} (${entry.strength}): failed${entry.exitCode === undefined ? "" : ` (exit ${entry.exitCode})`}${entry.attempts ? ` after ${entry.attempts} attempts` : ""}${entry.detail ? ` — ${entry.detail}` : ""}`);
    if (entry.tail) lines.push(...indent(entry.tail));
  }
  const runner = evidence.runner;
  if (lines.length > 0 && runner?.clean && runner.dependencies.startsWith("none (")) {
    lines.push(`ways ran this in a clean checkout of ${evidence.input.commit.slice(0, 12)} without dependencies: ${runner.dependencies.slice("none (".length, -1)}. Configure \`commands.setup\` (e.g. ["npm","ci"]) in ${CONFIG_PATH}, or run \`ways done --fast\` to evaluate in place and leave the clean run to CI.`);
  }
  return lines;
}

function indent(text: string): string[] {
  return text.split("\n").slice(-10).map((line) => `    ${line}`);
}
