import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { sha256, stableJson } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { fakeAdapter, unavailableUsage } from "./adapters.js";
import { loadCorpus } from "./corpus.js";
import { gradeTask } from "./grader.js";
import { captureWaysRevision, FULL_SDD_PROMPT, fullSddPrompt, gradeFullSddCompliance, prepareFullSdd } from "./ways.js";
import { ADAPTER_METRICS, type AdapterExecution, type AdapterInput, type EvalAdapter, type EvalConfiguration, type EvalRunOptions, type EvalRunResult, type EvalSessionResult, type EvalTask, type EvalTaskResult, type HarnessCompliance, type ObservedMetric, type TaskMetrics, type UsageMetrics } from "./types.js";

interface DisposableRepository {
  path: string;
  revision: string;
  waysBin?: string;
}

const GIT_ENV = { GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_NOGLOBAL: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" };

function repositoryPath(repo: string, path: string): string {
  const target = resolve(repo, path);
  const relativePath = relative(repo, target);
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.includes("/../")) throw new Error(`Eval setup path escapes repository: ${path}`);
  return target;
}

async function createRepository(task: EvalTask, config: EvalConfiguration): Promise<DisposableRepository> {
  const path = await mkdtemp(join(tmpdir(), "ways-eval-repo-"));
  try {
    for (const file of task.setup) {
      const target = repositoryPath(path, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    if (task.setup.length === 0) await writeFile(join(path, ".eval-fixture"), "", "utf8");
    const git = new GitRepository(path);
    const gitEnv = GIT_ENV;
    await git.run(["init", "-q", "-b", "main"], gitEnv, true);
    await git.run(["config", "user.name", "Ways Eval"], gitEnv, true);
    await git.run(["config", "user.email", "ways-eval@example.test"], gitEnv, true);
    await git.run(["add", "."], gitEnv, true);
    await git.run(["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "eval fixture"], gitEnv, true);
    if (config.harness === "full-sdd") return { path, ...await prepareFullSdd(path, task, gitEnv) };
    return { path, revision: await git.run(["rev-parse", "HEAD"], gitEnv, true) };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

async function invoke(adapter: EvalAdapter, input: AdapterInput, timeoutMs: number): Promise<{ execution: AdapterExecution; timedOut: boolean; error: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const execution = await adapter.run({ ...input, signal: controller.signal });
    return { execution, timedOut: controller.signal.aborted, error: null };
  } catch (error) {
    return { execution: { doneClaim: false, exitCode: null, stdout: "", stderr: "", overflow: false }, timedOut: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function aggregateUsage(sessions: readonly EvalSessionResult[]): UsageMetrics {
  const values = sessions.map((session) => session.usage);
  const sum = (field: "inputTokens" | "outputTokens" | "totalTokens" | "costUsd"): number | null => values.every((usage) => usage.available && usage[field] !== null) ? values.reduce((total, usage) => total + (usage[field] ?? 0), 0) : null;
  const available = values.every((usage) => usage.available);
  return { available, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens"), costUsd: sum("costUsd"), ...(available ? {} : { reason: "one or more sessions did not provide usage metrics" }) };
}

function unavailableMetrics(reason: string): TaskMetrics {
  const missing = (source: ObservedMetric["source"]): ObservedMetric => ({ value: null, source, reason });
  return {
    ...Object.fromEntries(ADAPTER_METRICS.map((name) => [name, missing("adapter")])) as Record<typeof ADAPTER_METRICS[number], ObservedMetric>,
    timeouts: missing("runner"),
    remediationAttempts: missing("repository"),
    resumeSuccess: { value: null, source: "runner", reason },
  };
}

function taskMetrics(task: EvalTask, sessions: readonly EvalSessionResult[], compliance: HarnessCompliance): TaskMetrics {
  const adapterMetric = (name: typeof ADAPTER_METRICS[number]): ObservedMetric => {
    const missing = sessions.find((session) => typeof session.metrics[name] !== "number");
    return missing
      ? { value: null, source: "adapter", reason: `adapter did not report ${name} for the ${missing.session} session` }
      : { value: sessions.reduce((total, session) => total + (session.metrics[name] ?? 0), 0), source: "adapter" };
  };
  const resume = sessions.find((session) => session.session === "resume");
  return {
    ...Object.fromEntries(ADAPTER_METRICS.map((name) => [name, adapterMetric(name)])) as Record<typeof ADAPTER_METRICS[number], ObservedMetric>,
    timeouts: { value: sessions.filter((session) => session.adapter.timedOut).length, source: "runner" },
    remediationAttempts: compliance.applicable
      ? { value: compliance.remediationAttempts, source: "repository" }
      : { value: null, source: "repository", reason: "remediation attempts are only observable with the full-sdd harness" },
    resumeSuccess: task.freshSessionResume === undefined
      ? { value: null, source: "runner", reason: "task has no fresh-session resume" }
      : { value: resume !== undefined && sessionSucceeded(resume) && resume.grading.success, source: "runner" },
  };
}

function sessionSucceeded(session: EvalSessionResult): boolean {
  return session.adapter.error === null && session.adapter.exitCode === 0 && !session.adapter.timedOut && !session.adapter.overflow;
}

async function runSession(repo: string, revision: string, task: EvalTask, adapter: EvalAdapter, config: EvalConfiguration, session: "initial" | "resume", prompt: string, waysBin?: string): Promise<EvalSessionResult> {
  const started = Date.now();
  const harnessPrompt = config.harness === "full-sdd" ? fullSddPrompt(FULL_SDD_PROMPT[session], task.id, prompt) : prompt;
  const result = await invoke(adapter, {
    task,
    repo,
    prompt: harnessPrompt,
    session,
    harness: config.harness,
    model: config.model,
    startingRevision: revision,
    seed: config.seed,
    maxOutputBytes: config.budgets.maxOutputBytes,
    ...(waysBin ? { waysBin } : {}),
    signal: new AbortController().signal,
  }, config.budgets.maxMilliseconds);
  const grading = await gradeTask(repo, task, config.budgets.maxMilliseconds, config.budgets.maxOutputBytes);
  return {
    session,
    doneClaim: result.execution.doneClaim,
    elapsedMs: Date.now() - started,
    usage: result.execution.usage ?? unavailableUsage,
    metrics: result.execution.metrics ?? {},
    adapter: { exitCode: result.execution.exitCode, timedOut: result.timedOut, overflow: result.execution.overflow, error: result.error ?? result.execution.error ?? null },
    grading,
  };
}

async function runTask(task: EvalTask, adapter: EvalAdapter, config: EvalConfiguration): Promise<EvalTaskResult> {
  const started = Date.now();
  let disposable: DisposableRepository | undefined;
  try {
    disposable = await createRepository(task, config);
    const sessions = [await runSession(disposable.path, disposable.revision, task, adapter, config, "initial", task.prompt, disposable.waysBin)];
    if (task.freshSessionResume) sessions.push(await runSession(disposable.path, disposable.revision, task, adapter, config, "resume", task.freshSessionResume.prompt, disposable.waysBin));
    const final = sessions.at(-1);
    if (!final) throw new Error("Eval task produced no session");
    const incorrectDoneClaim = sessions.some((session) => session.doneClaim && !session.grading.success);
    const compliance: HarnessCompliance = config.harness === "full-sdd"
      ? await gradeFullSddCompliance(disposable.path)
      : { applicable: false, reason: `harness ${config.harness} does not run Ways SDD` };
    return {
      taskId: task.id,
      startingRevision: disposable.revision,
      freshSessionResume: task.freshSessionResume !== undefined,
      success: final.grading.success && sessions.every(sessionSucceeded),
      regressions: sessions.some((session) => session.grading.regressions),
      incorrectDoneClaim,
      elapsedMs: Date.now() - started,
      usage: aggregateUsage(sessions),
      metrics: taskMetrics(task, sessions, compliance),
      compliance,
      sessions,
    };
  } catch (error) {
    const reason = `task failed before grading: ${error instanceof Error ? error.message : String(error)}`;
    return {
      taskId: task.id,
      startingRevision: disposable?.revision ?? "unavailable",
      freshSessionResume: task.freshSessionResume !== undefined,
      success: false,
      regressions: false,
      incorrectDoneClaim: false,
      elapsedMs: Date.now() - started,
      usage: unavailableUsage,
      metrics: unavailableMetrics(reason),
      compliance: { applicable: false, reason },
      sessions: [{
        session: "initial",
        doneClaim: false,
        elapsedMs: Date.now() - started,
        usage: unavailableUsage,
        metrics: {},
        adapter: { exitCode: null, timedOut: false, overflow: false, error: error instanceof Error ? error.message : String(error) },
        grading: { success: false, regressions: false, successCriteria: [], regressionCriteria: [] },
      }],
    };
  } finally {
    if (disposable) await rm(disposable.path, { recursive: true, force: true });
  }
}

export async function runEvals(options: EvalRunOptions): Promise<EvalRunResult> {
  const corpus = options.corpus ?? await loadCorpus(options.corpusPath);
  const adapter = options.adapter ?? fakeAdapter;
  const configuration = options.configuration;
  if (configuration.adapter.id !== adapter.id || JSON.stringify(configuration.adapter.argv) !== JSON.stringify(adapter.argv)) throw new Error("Eval configuration adapter identity does not match the adapter being run");
  if (configuration.startingRevision !== corpus.revision) throw new Error("Eval configuration revision must match corpus revision");
  const now = options.now ?? (() => new Date());
  const waysRevision = await captureWaysRevision();
  const evidenceKind = adapter.synthetic ? "fixture" : "real";
  const startedDate = now();
  const runId = sha256(stableJson({ corpus: corpus.id, revision: corpus.revision, configuration, waysRevision, startedAt: startedDate.toISOString() })).slice(0, 16);
  const tasks = [];
  for (const task of corpus.tasks) tasks.push(await runTask(task, adapter, configuration));
  const finishedDate = now();
  return {
    schemaVersion: 2,
    runId,
    corpus: { id: corpus.id, revision: corpus.revision, taskCount: corpus.tasks.length },
    configuration,
    waysRevision,
    harnessPrompt: configuration.harness === "full-sdd" ? FULL_SDD_PROMPT : null,
    startedAt: startedDate.toISOString(),
    finishedAt: finishedDate.toISOString(),
    evidence: evidenceKind === "fixture"
      ? { kind: evidenceKind, architecturalBenchmark: false, warning: "Runner fixture: synthetic adapter output is neither real-run nor architectural evidence." }
      : { kind: evidenceKind, architecturalBenchmark: false, warning: "Real run: task outcomes only; a single run is not architectural evidence." },
    tasks,
    summary: {
      taskCount: tasks.length,
      successCount: tasks.filter((task) => task.success).length,
      regressionCount: tasks.filter((task) => task.regressions).length,
      incorrectDoneClaimCount: tasks.filter((task) => task.incorrectDoneClaim).length,
      compliantCount: configuration.harness === "full-sdd" ? tasks.filter((task) => task.compliance.applicable && task.compliance.compliant).length : null,
      elapsedMs: tasks.reduce((sum, task) => sum + task.elapsedMs, 0),
    },
  };
}
