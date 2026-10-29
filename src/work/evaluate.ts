import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { runChecks } from "../check/check.js";
import { committedContract, effectiveContract } from "../check/contract.js";
import { execute, type CapturedResult } from "../check/process.js";
import { compactSummary, runCommand, shownLogPath } from "../run/run.js";
import { gitDirs } from "../runtime/runtime.js";
import { cleanCheckout, DEPENDENCY_DIRS } from "../check/sandbox.js";
import { loadConfig, verifierPaths } from "../config/config.js";
import { CONFIG_PATH, DEFAULT_VERIFIER_PATHS, WAYS_DIR, WORK_DIR } from "../domain/constants.js";
import { STRENGTHS, type ApprovalsConfig, type BaselineResult, type CheckContract, type Criterion, type CriterionEvidence, type EnvironmentResult, type EvaluationMode, type Evidence, type RunnerInfo, type RunOutput, type Strength, type TestsRatchet } from "../domain/types.js";
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
 * CI pipelines. Changing or deleting one counts; adding one does not: a new
 * pipeline adds jobs, it cannot stop the others from running, and which
 * checks are required is the branch protection's to say.
 */
const CI_CONFIG: readonly string[] = [".github/workflows/**", ".gitlab-ci.yml"];

/**
 * Check configuration on the verifier surface: any change to it decides what
 * runs, so it counts, adding it included (but see {@link CI_CONFIG}).
 * Everything else on the surface (tests, fixtures, helpers) is judged by what
 * changed inside it.
 */
const CHECK_CONFIG: readonly string[] = [
  CONFIG_PATH,
  `${WAYS_DIR}/allowed_signers`,
  "package.json",
  ...CI_CONFIG,
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  "**/jest.config.*",
  "**/playwright.config.*",
  "**/cypress.config.*",
  "**/karma.conf.*",
  "**/.mocharc*",
  "**/conftest.py",
  "**/pytest.ini",
];

/** Directories of dependencies and build output: a test glob matching a file there is an accident, not a test of the project. */
const OUTSIDE_SURFACE = new Set(["node_modules", "vendor", "dist", "build", "coverage", ".git", ".venv", "venv", "__pycache__", ".tox", "target", ".next"]);

/**
 * Added lines that turn tests off, narrow the run to some of them, or end a
 * test file early. Extended by `testMarkers` in the base's config.
 */
export const TEST_MARKERS: readonly string[] = [
  "\\.(skip|skipIf|runIf|only|todo)\\s*[(.`]",
  "\\b(xit|xdescribe|xtest|xcontext|fit|fdescribe|ftest)\\s*\\(",
  "@(Disabled|Ignore)\\b",
  "@pytest\\.mark\\.(skip|skipif|xfail)\\b",
  "\\bpytest\\.(skip|xfail)\\s*\\(",
  "@unittest\\.(skip|expectedFailure)",
  "\\bt\\.Skip(Now|f)?\\s*\\(",
  "#\\[ignore\\]",
  "\\b(process\\.exit|sys\\.exit|os\\._exit|os\\.Exit)\\s*\\(",
];

/** The markers that narrow the run to the marked tests: in a new file too they keep existing tests from running. */
const FOCUS_MARKERS: readonly string[] = ["\\.only\\s*[(.`]", "\\b(fit|fdescribe|ftest)\\s*\\("];

function onSurface(path: string, globs: readonly string[]): boolean {
  return !path.split("/").slice(0, -1).some((segment) => OUTSIDE_SURFACE.has(segment)) && matchesAny(path, globs);
}

/**
 * The verifier checkpoint of an increment, by what changed inside each file
 * of the surface (docs/VERIFICATION.md): deleting a test file, removing or
 * modifying an existing line (except widening an import of the same module),
 * adding a line that skips, focuses or exits, and adding or changing check
 * configuration. Adding test files, or tests to an existing file, is free.
 * `extra` are exact paths whose every modification counts (the scripts a
 * criterion's verifier runs); `markers` extend {@link TEST_MARKERS}.
 */
export async function verifierChanges(git: GitRepository, base: string, input: string, globs: readonly string[], extra: readonly string[] = [], markers: readonly string[] = []): Promise<string[]> {
  const output = await git.run(["diff", "--name-status", "--no-renames", "-z", base, input, "--"]);
  const fields = output.split("\0").filter(Boolean);
  const disabling = [...TEST_MARKERS, ...markers].map((source) => new RegExp(source));
  const focusing = FOCUS_MARKERS.map((source) => new RegExp(source));
  // An increment that installs ways adds its configuration and CI; there is nothing of the base's to protect yet.
  const installs = !await git.pathExists(base, CONFIG_PATH);
  const changed: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    const path = fields[index + 1]!;
    if (path.startsWith(`${WORK_DIR}/`)) continue;
    const exact = extra.includes(path);
    if (!exact && !onSurface(path, globs)) continue;
    const added = status.startsWith("A");
    if (exact && !added) {
      changed.push(path);
      continue;
    }
    if (matchesAny(path, CHECK_CONFIG)) {
      if (added && (installs || matchesAny(path, CI_CONFIG))) continue;
      // Structured files count only when the part that decides what is verified changes.
      const watched = WATCHED_FIELDS[path];
      if (watched && await watchedValue(git, base, path, watched) === await watchedValue(git, input, path, watched)) continue;
      if (path === CONFIG_PATH && await onlyAddsChecks(git, base, input)) continue;
      changed.push(path);
      continue;
    }
    if (status.startsWith("D") || status.startsWith("T")) {
      changed.push(path);
      continue;
    }
    const diff = await lineChanges(git, base, input, path);
    if (diff === "binary" || diff.some((hunk) => !hunkIsAddition(hunk)) || diff.some((hunk) => hunk.added.some((line) => (added ? focusing : disabling).some((marker) => marker.test(line))))) changed.push(path);
  }
  return changed.sort();
}

interface Hunk {
  removed: string[];
  added: string[];
}

/** The hunks of one file's diff, without context lines. */
async function lineChanges(git: GitRepository, base: string, input: string, path: string): Promise<Hunk[] | "binary"> {
  // Literal: a file named like a pathspec (`:(glob)…`) is still only that file.
  const output = await git.run(["--literal-pathspecs", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base, input, "--", path]);
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("Binary files ")) return "binary";
    if (line.startsWith("@@")) {
      hunk = { removed: [], added: [] };
      hunks.push(hunk);
    } else if (hunk && line.startsWith("-")) hunk.removed.push(line.slice(1));
    else if (hunk && line.startsWith("+")) hunk.added.push(line.slice(1));
  }
  return hunks;
}

/**
 * A hunk that only adds: every line it removes comes back unchanged (a final
 * newline added) or as an import of the same module that names more things.
 */
function hunkIsAddition(hunk: Hunk): boolean {
  const added = [...hunk.added];
  for (const line of hunk.removed) {
    let match = added.findIndex((candidate) => candidate.trimEnd() === line.trimEnd());
    if (match < 0) match = added.findIndex((candidate) => widensImport(line, candidate));
    if (match < 0) return false;
    added.splice(match, 1);
  }
  return true;
}

function importParts(line: string): { skeleton: string; names: string[] } | undefined {
  const names = (list: string): string[] => list.split(",").map((name) => name.trim()).filter(Boolean);
  const js = /^(\s*(?:import|export|const|let|var)\b[^{]*)\{([^}]*)\}(.*)$/.exec(line);
  if (js && /\b(from|require)\b/.test(js[3]!)) return { skeleton: `${js[1]!.trim()} {} ${js[3]!.trim()}`, names: names(js[2]!) };
  const python = /^(\s*from\s+\S+\s+import\s+)\(?([^()#]*?)\)?\s*$/.exec(line);
  if (python) return { skeleton: python[1]!.trim(), names: names(python[2]!) };
  return undefined;
}

/** `import { a } from 'm'` → `import { a, b } from 'm'`: the same statement over the same module, with every name kept. */
function widensImport(before: string, after: string): boolean {
  const old = importParts(before);
  const next = importParts(after);
  return old !== undefined && next !== undefined && old.skeleton === next.skeleton && old.names.every((name) => next.names.includes(name));
}

/**
 * The ways config counts when what decides verification changes (commands,
 * verifier globs and markers, review and approval policy, where evaluations
 * run, the reviewer), not its version; `package.json` when its scripts or a
 * test runner's settings change (not a dependency bump). `enforcement` is not
 * watched: `ways verify` takes it from the base, so a range cannot relax it
 * for itself.
 */
const WATCHED_FIELDS: Record<string, readonly string[]> = {
  [CONFIG_PATH]: ["testCommand", "commands", "verifierPaths", "testMarkers", "review", "evaluation", "approvals", "reviewer"],
  "package.json": ["scripts", "jest", "vitest", "mocha", "ava", "c8", "nyc"],
};

async function watchedValue(git: GitRepository, ref: string, path: string, names: readonly string[]): Promise<string> {
  // A file the ref does not have watches nothing, so adding one without those fields is free.
  const text = await git.pathExists(ref, path) ? await git.run(["show", `${ref}:${path}`]) : "{}";
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(names.map((name) => value[name] ?? null));
  } catch {
    return "unreadable";
  }
}

/**
 * Adding a check is free, like adding a test: the config counts as unchanged
 * when every watched field but `commands` is the same and every check the
 * base ran is still there, with the same command and still required (a base
 * with only `testCommand` ran it as `test`). Timeouts, setup and services
 * must not change either.
 */
async function onlyAddsChecks(git: GitRepository, base: string, input: string): Promise<boolean> {
  const read = async (ref: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const value: unknown = JSON.parse(await git.run(["show", `${ref}:${CONFIG_PATH}`]));
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  };
  const before = await read(base);
  const after = await read(input);
  if (!before || !after) return false;
  const others = WATCHED_FIELDS[CONFIG_PATH]!.filter((name) => name !== "commands" && name !== "testCommand");
  if (JSON.stringify(others.map((name) => before[name] ?? null)) !== JSON.stringify(others.map((name) => after[name] ?? null))) return false;
  type Commands = Record<string, unknown> & { required?: unknown };
  const commandsOf = (config: Record<string, unknown>): Commands => (config.commands && typeof config.commands === "object" ? config.commands as Commands : { required: ["test"], test: config.testCommand });
  const old = commandsOf(before);
  const next = commandsOf(after);
  if (!Array.isArray(old.required) || !Array.isArray(next.required)) return false;
  for (const name of ["timeoutMs", "setup", "services"]) if (JSON.stringify(old[name] ?? null) !== JSON.stringify(next[name] ?? null)) return false;
  const required = new Set(next.required as unknown[]);
  return (old.required as unknown[]).every((name) => typeof name === "string" && required.has(name) && JSON.stringify(old[name] ?? null) === JSON.stringify(next[name] ?? null));
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

/** The extra test markers as the base configured them (only valid expressions). */
export async function baseTestMarkers(git: GitRepository, base: string, current: readonly string[]): Promise<readonly string[]> {
  const config = await baseConfig(git, base);
  const markers = config ? config.testMarkers : current;
  return Array.isArray(markers) ? markers.filter((marker): marker is string => typeof marker === "string" && validRegex(marker)) : [];
}

function validRegex(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

const INTERPRETERS = new Set(["node", "bash", "sh", "zsh", "python", "python3", "deno", "bun", "ruby", "perl", "tsx", "ts-node", "php"]);

/**
 * The script a verifier runs, when it is a file of the repository that exists
 * in `ref`: the program itself (`./scripts/verify.sh`) or an interpreter's
 * script (`node test/ac1.mjs`). Editing it changes what the criterion checks,
 * so it is on the verifier surface. Files a verifier only reads (`grep x
 * src/a.js`) are the code under test and are not.
 */
export async function verifierFiles(git: GitRepository, ref: string, criteria: readonly Criterion[]): Promise<string[]> {
  const files = new Set<string>();
  for (const criterion of criteria) {
    const [program = "", ...args] = criterion.verify ?? [];
    const name = program.slice(program.lastIndexOf("/") + 1);
    const script = INTERPRETERS.has(name) ? args.find((arg) => !arg.startsWith("-")) : program.includes("/") ? program : undefined;
    const path = script?.replace(/^\.\//, "");
    if (!path || !/^[\w@.][\w@./-]*$/.test(path) || path.split("/").includes("..")) continue;
    if (await git.pathExists(ref, path)) files.add(path);
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
  /** Only integrity and the criteria's verifiers: `ways verify` runs the checks once for the whole range. */
  skipChecks?: boolean;
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
  // Committed evidence counts too: in CI the local ledger is empty.
  const committed = new Map<string, number>();
  let names: string[] = [];
  try {
    names = (await git.run(["ls-tree", "--name-only", `${base}:${WORK_DIR}`])).split("\n").filter((name) => name.endsWith(".json"));
  } catch {
    // No records at the base.
  }
  for (const name of names) {
    try {
      const evidence = (JSON.parse(await git.run(["show", `${base}:${WORK_DIR}/${name}`])) as { evidence?: Evidence }).evidence;
      if (evidence?.tests && evidence.passed) committed.set(evidence.input.commit, evidence.tests.ran);
    } catch {
      // An unreadable record says nothing about tests.
    }
  }
  for (const commit of commits) {
    const ran = testsRanAt(cwd, commit) ?? committed.get(commit);
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
export async function evaluate({ cwd, git, base, criteria, work, mode = "clean", notes = {}, input: requested, skipChecks = false }: EvaluationInput): Promise<Evidence> {
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
  const dirs = gitDirs(cwd);
  const flaky: string[] = [];
  const evidence: Record<string, CriterionEvidence> = {};
  let result: Awaited<ReturnType<typeof runChecks>>;
  try {
    if (setupResult && setupResult.status !== "passed") {
      result = { issues: [], checks: [], environment: [setupResult], passed: false };
    } else if (skipChecks) {
      result = await runChecks(dir, { integrityOnly: true });
    } else {
      const cachedDetail = checkout?.setupCached ? checkout.dependencies : setupResult?.detail;
      result = await runChecks(dir, { services: true, capture: true, contract, retries: RETRIES, runs: { dirs, ...(checkout ? { commit: input } : {}) }, ...(cachedDetail && setup ? { setupCached: cachedDetail } : {}) });
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
      const { record, result: run } = await runCommand(dirs, `criterion:${criterion.id}`, criterion.verify, { cwd: dir, timeoutMs, retries: RETRIES, ...(checkout ? { commit: input } : {}) });
      if (run.flakyFailure) {
        flaky.push(criterion.id);
        quarantine(cwd, { key: `${work ?? "work"}/${criterion.id}`, command: [...criterion.verify], lastAt: new Date().toISOString(), lastCommit: input, ...(run.flakyFailure.tail ? { tail: run.flakyFailure.tail } : {}) });
      }
      evidence[criterion.id] = { id: criterion.id, strength: criterion.strength, status: run.status === "passed" ? "passed" : "failed", command: [...criterion.verify], ...output(run), summary: compactSummary(record), run: record.id, log: shownLogPath(dirs, record.id), runs: [criterion.id], ...note };
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
  const changes = await verifierChanges(git, base, input, surface, await verifierFiles(git, base, criteria), await baseTestMarkers(git, base, config.testMarkers ?? []));
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
    lines.push(...details(check));
  }
  for (const [id, entry] of Object.entries(evidence.criteria)) {
    if (entry.status !== "failed") continue;
    lines.push(`criterion ${id} (${entry.strength}): failed${entry.exitCode === undefined ? "" : ` (exit ${entry.exitCode})`}${entry.attempts ? ` after ${entry.attempts} attempts` : ""}${entry.detail ? ` — ${entry.detail}` : ""}`);
    lines.push(...details(entry));
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

/** The failures `ways run`'s reading found, and where the whole log is; the raw tail when there is no reading. */
function details(entry: Pick<RunOutput, "summary" | "tail" | "run">): string[] {
  const failures = entry.summary?.split("\n").slice(1) ?? [];
  if (failures.length === 0) return entry.tail ? indent(entry.tail) : [];
  return [...failures.map((line) => `  ${line}`), ...(entry.run ? [`    full log: ways run --show ${entry.run}`] : [])];
}
