import { readFile } from "node:fs/promises";
import { sha256, stableJson } from "../fs/files.js";
import { ADAPTER_METRICS, HARNESS_LABELS, HARNESS_LETTERS, TASK_KINDS, type EvalRunResult, type EvalTaskResult, type EvalWorkflow, type EvidenceKind, type HarnessLabel, type OutcomeEvalPolicy, type TaskKind, type TaskMetrics } from "./types.js";

export interface ArtifactLink {
  path: string;
  sha256: string | null;
  runId: string | null;
}

export interface ComparedRun {
  artifact: ArtifactLink;
  status: "comparable" | "non-comparable" | "invalid";
  reasons: string[];
  harness: HarnessLabel | null;
  evidenceKind: EvidenceKind | null;
}

export interface MetricSummary {
  /** Null unless every task observed the metric; partial sums are never presented as totals. */
  total: number | null;
  observedTotal: number | null;
  available: number;
  unavailable: number;
  reasons: string[];
}

/** A count over graded task runs with its 95% Wilson score interval; null rate and interval without trials. */
export interface RateSummary {
  count: number;
  trials: number;
  rate: number | null;
  interval95: [number, number] | null;
}

export interface HarnessScore {
  harness: HarnessLabel;
  configuration: string;
  runs: number;
  artifacts: ArtifactLink[];
  outcomePolicy: OutcomeEvalPolicy | null;
  taskSuccess: RateSummary;
  byKind: Partial<Record<TaskKind, { succeeded: number; trials: number }>>;
  assurance: {
    regressions: RateSummary;
    incorrectDoneClaims: RateSummary;
    /** The Ways workflow reported the task finished while independent functional grading failed; null without a workflow. */
    completedWithoutSuccess: RateSummary | null;
    /** Compliance issue codes observed across task runs. */
    complianceIssues: Record<string, number>;
  };
  harnessCompliance:
    | { applicable: false; reason: string }
    | { applicable: true; workflow: EvalWorkflow; compliant: RateSummary; completed: RateSummary; effectivePolicies: string[] };
  time: { totalMs: number; medianTaskMs: number | null; maxTaskMs: number | null };
  metrics: Record<keyof TaskMetrics | "totalTokens" | "costUsd", MetricSummary>;
}

/** Raw per-task evidence: every graded task run with a pointer into its artifact. */
export interface ComparedTask {
  taskId: string;
  kind: TaskKind;
  harness: HarnessLabel;
  runId: string;
  success: boolean;
  regressions: boolean;
  incorrectDoneClaim: boolean;
  completed: boolean | null;
  compliant: boolean | null;
  complianceIssues: string[];
  elapsedMs: number;
  totalTokens: number | null;
  costUsd: number | null;
  humanInterventions: number | null;
  remediationAttempts: number | null;
  artifact: string;
  pointer: string;
}

/** Matched view: the same task across harnesses, never collapsed into a score. */
export interface TaskMatrixRow {
  taskId: string;
  kind: TaskKind;
  harnesses: Partial<Record<HarnessLabel, { succeeded: number; trials: number; compliant: number | null }>>;
}

export interface ComparisonReport {
  schemaVersion: 2;
  architecturalClaim: false;
  evidenceKind: EvidenceKind | null;
  warning: string;
  reference: ComparabilityKey | null;
  runs: ComparedRun[];
  harnesses: HarnessScore[];
  matrix: TaskMatrixRow[];
  tasks: ComparedTask[];
}

type ComparabilityKey = Pick<EvalRunResult["configuration"], "model" | "seed" | "budgets" | "adapter"> & { corpus: string; revision: string; corpusDigest: string; runnerDigest: string };

const METRIC_NAMES = [...ADAPTER_METRICS, "timeouts", "remediationAttempts", "humanApprovals", "resumeSuccess"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "result is not a JSON object";
  if (value.schemaVersion !== 3) return `result schemaVersion ${String(value.schemaVersion)} is not 3; re-run with the current runner`;
  const { corpus, configuration, evidence, waysRevision, tasks } = value;
  if (typeof value.runId !== "string" || !isObject(corpus) || typeof corpus.id !== "string" || typeof corpus.revision !== "string" || typeof corpus.digest !== "string") return "result lacks runId or corpus identity";
  if (!isObject(configuration) || !HARNESS_LABELS.includes(configuration.harness as HarnessLabel) || typeof configuration.model !== "string"
    || typeof configuration.seed !== "number" || !isObject(configuration.budgets) || !isObject(configuration.adapter)
    || (configuration.harness === "outcome") !== isObject(configuration.outcomePolicy)) return "result configuration is malformed";
  if (!isObject(evidence) || (evidence.kind !== "fixture" && evidence.kind !== "real")) return "result evidence kind is missing";
  if (!isObject(waysRevision) || typeof waysRevision.contentDigest !== "string") return "result lacks the Ways revision";
  if (!Array.isArray(tasks) || tasks.some((task) => !isObject(task) || typeof task.taskId !== "string" || !(TASK_KINDS as readonly unknown[]).includes(task.kind)
    || typeof task.success !== "boolean" || typeof task.regressions !== "boolean" || typeof task.incorrectDoneClaim !== "boolean" || !metricValue(task.elapsedMs, false)
    || !isObject(task.compliance) || typeof task.compliance.applicable !== "boolean"
    || (task.compliance.applicable && (typeof task.compliance.compliant !== "boolean" || typeof task.compliance.completed !== "boolean" || !Array.isArray(task.compliance.issues))))) return "result tasks are malformed";
  for (const task of tasks as Record<string, unknown>[]) {
    const { metrics, usage } = task;
    if (!isObject(metrics) || METRIC_NAMES.some((name) => !isObject(metrics[name]) || !metricValue(metrics[name].value, name === "resumeSuccess"))) return `task ${String(task.taskId)} has malformed metrics`;
    if (!isObject(usage) || (["totalTokens", "costUsd"] as const).some((field) => !metricValue(usage[field], false))) return `task ${String(task.taskId)} has malformed usage`;
  }
  return undefined;
}

function metricValue(value: unknown, boolean: boolean): boolean {
  return value === null || (boolean ? typeof value === "boolean" : typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function keyOf(result: EvalRunResult): ComparabilityKey {
  const { model, seed, budgets, adapter } = result.configuration;
  return { corpus: result.corpus.id, revision: result.corpus.revision, corpusDigest: result.corpus.digest, model, seed, budgets, adapter, runnerDigest: result.waysRevision.contentDigest };
}

function differences(reference: ComparabilityKey, key: ComparabilityKey): string[] {
  return (Object.keys(reference) as (keyof ComparabilityKey)[])
    .filter((field) => stableJson(reference[field]) !== stableJson(key[field]))
    .map((field) => `${field} differs from the reference run`);
}

function metricSummary(values: readonly { value: number | boolean | null; reason?: string }[]): MetricSummary {
  const available = values.filter((metric) => metric.value !== null);
  const reasons = [...new Set(values.flatMap((metric) => metric.value === null && metric.reason ? [metric.reason] : []))].sort();
  const observedTotal = available.length === 0 ? null : available.reduce((sum, metric) => sum + Number(metric.value), 0);
  return {
    total: available.length === values.length ? observedTotal : null,
    observedTotal,
    available: available.length,
    unavailable: values.length - available.length,
    reasons,
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 95% Wilson score interval: honest at small n and at 0% or 100%, unlike the normal approximation. */
export function wilsonInterval(count: number, trials: number, z = 1.96): [number, number] | null {
  if (trials === 0) return null;
  const p = count / trials;
  const denominator = 1 + z * z / trials;
  const centre = (p + z * z / (2 * trials)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / denominator;
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))];
}

function rate(count: number, trials: number): RateSummary {
  return { count, trials, rate: trials === 0 ? null : round(count / trials), interval95: wilsonInterval(count, trials) };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function score(harness: HarnessLabel, runs: readonly { result: EvalRunResult; artifact: ArtifactLink }[]): HarnessScore {
  const tasks = runs.flatMap(({ result }) => result.tasks);
  const metrics = Object.fromEntries(METRIC_NAMES.map((name) => [name, metricSummary(tasks.map((task) => task.metrics[name]))])) as HarnessScore["metrics"];
  for (const field of ["totalTokens", "costUsd"] as const) {
    metrics[field] = metricSummary(tasks.map((task) => ({ value: task.usage[field], ...(task.usage.reason ? { reason: task.usage.reason } : {}) })));
  }
  const graded = tasks.flatMap((task) => task.compliance.applicable ? [{ task, compliance: task.compliance }] : []);
  const workflow = graded[0]?.compliance.workflow;
  const issueCodes: Record<string, number> = {};
  for (const { compliance } of graded) for (const issue of compliance.issues) issueCodes[issue.code] = (issueCodes[issue.code] ?? 0) + 1;
  const byKind: HarnessScore["byKind"] = {};
  for (const task of tasks) {
    const entry = byKind[task.kind] ?? { succeeded: 0, trials: 0 };
    byKind[task.kind] = { succeeded: entry.succeeded + Number(task.success), trials: entry.trials + 1 };
  }
  const elapsed = tasks.map((task) => task.elapsedMs);
  return {
    harness,
    configuration: HARNESS_LETTERS[harness],
    runs: runs.length,
    artifacts: runs.map(({ artifact }) => artifact),
    outcomePolicy: runs[0]?.result.configuration.outcomePolicy ?? null,
    taskSuccess: rate(tasks.filter((task) => task.success).length, tasks.length),
    byKind,
    assurance: {
      regressions: rate(tasks.filter((task) => task.regressions).length, tasks.length),
      incorrectDoneClaims: rate(tasks.filter((task) => task.incorrectDoneClaim).length, tasks.length),
      completedWithoutSuccess: workflow ? rate(graded.filter(({ task, compliance }) => compliance.completed && !task.success).length, tasks.length) : null,
      complianceIssues: Object.fromEntries(Object.entries(issueCodes).sort(([a], [b]) => a.localeCompare(b))),
    },
    harnessCompliance: workflow
      ? {
        applicable: true,
        workflow,
        compliant: rate(graded.filter(({ compliance }) => compliance.compliant).length, tasks.length),
        completed: rate(graded.filter(({ compliance }) => compliance.completed).length, tasks.length),
        effectivePolicies: [...new Set(graded.map(({ compliance }) => stableJson(compliance.effectivePolicy).trim()))].sort(),
      }
      : { applicable: false, reason: `harness ${harness} does not run a Ways workflow` },
    time: { totalMs: elapsed.reduce((sum, value) => sum + value, 0), medianTaskMs: median(elapsed), maxTaskMs: elapsed.length === 0 ? null : Math.max(...elapsed) },
    metrics,
  };
}

function taskRow(task: EvalTaskResult, index: number, result: EvalRunResult, artifact: ArtifactLink): ComparedTask {
  return {
    taskId: task.taskId,
    kind: task.kind,
    harness: result.configuration.harness,
    runId: result.runId,
    success: task.success,
    regressions: task.regressions,
    incorrectDoneClaim: task.incorrectDoneClaim,
    completed: task.compliance.applicable ? task.compliance.completed : null,
    compliant: task.compliance.applicable ? task.compliance.compliant : null,
    complianceIssues: task.compliance.applicable ? [...new Set(task.compliance.issues.map((issue) => issue.code))].sort() : [],
    elapsedMs: task.elapsedMs,
    totalTokens: task.usage.totalTokens,
    costUsd: task.usage.costUsd,
    humanInterventions: task.metrics.humanInterventions.value as number | null,
    remediationAttempts: task.metrics.remediationAttempts.value as number | null,
    artifact: artifact.path,
    pointer: `/tasks/${index}`,
  };
}

function matrix(rows: readonly ComparedTask[]): TaskMatrixRow[] {
  const byTask = new Map<string, TaskMatrixRow>();
  for (const row of rows) {
    const entry = byTask.get(row.taskId) ?? { taskId: row.taskId, kind: row.kind, harnesses: {} };
    const cell = entry.harnesses[row.harness] ?? { succeeded: 0, trials: 0, compliant: row.compliant === null ? null : 0 };
    entry.harnesses[row.harness] = { succeeded: cell.succeeded + Number(row.success), trials: cell.trials + 1, compliant: cell.compliant === null ? null : cell.compliant + Number(row.compliant) };
    byTask.set(row.taskId, entry);
  }
  return [...byTask.values()];
}

/** Compares raw run results; only runs that hold every controlled variable constant are scored. */
export function compareResults(inputs: readonly { path: string; content: string | null }[]): ComparisonReport {
  const parsed = inputs.map(({ path, content }) => {
    if (content === null) return { artifact: { path, sha256: null, runId: null }, problem: "input could not be read" };
    const artifact: ArtifactLink = { path, sha256: sha256(content), runId: null };
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return { artifact, problem: "result is not valid JSON" };
    }
    const problem = resultProblem(value);
    if (problem) return { artifact, problem };
    const result = value as EvalRunResult;
    return { artifact: { ...artifact, runId: result.runId }, result };
  });
  const valid = parsed.flatMap((entry) => entry.result ? [{ artifact: entry.artifact, result: entry.result }] : []);
  const reference = valid.find(({ result }) => result.evidence.kind === "real") ?? valid[0];
  const referenceKey = reference ? keyOf(reference.result) : null;
  const seen = new Set<string>();
  const policies = new Map<HarnessLabel, string>();
  const runs: ComparedRun[] = [];
  const comparable: { result: EvalRunResult; artifact: ArtifactLink }[] = [];
  for (const entry of parsed) {
    if (!entry.result) {
      runs.push({ artifact: entry.artifact, status: "invalid", reasons: [entry.problem], harness: null, evidenceKind: null });
      continue;
    }
    const { harness, outcomePolicy } = entry.result.configuration;
    const reasons = referenceKey ? differences(referenceKey, keyOf(entry.result)) : [];
    if (reference && entry.result.evidence.kind !== reference.result.evidence.kind) reasons.push("mixes fixture and real evidence");
    if (seen.has(entry.result.runId)) reasons.push("duplicate run");
    const policy = stableJson(outcomePolicy ?? null);
    if (policies.has(harness) && policies.get(harness) !== policy) reasons.push("outcome policy differs from the first comparable run of this harness");
    seen.add(entry.result.runId);
    runs.push({ artifact: entry.artifact, status: reasons.length === 0 ? "comparable" : "non-comparable", reasons, harness, evidenceKind: entry.result.evidence.kind });
    if (reasons.length === 0) {
      policies.set(harness, policy);
      comparable.push({ result: entry.result, artifact: entry.artifact });
    }
  }
  const evidenceKind = reference?.result.evidence.kind ?? null;
  const tasks = comparable.flatMap(({ result, artifact }) => result.tasks.map((task, index) => taskRow(task, index, result, artifact)));
  return {
    schemaVersion: 2,
    architecturalClaim: false,
    evidenceKind,
    warning: `${evidenceKind === "fixture"
      ? "Runner fixtures only: these scores exercise the runner and grader and say nothing about harness quality."
      : "Scores compare the listed real runs only; they are not an architectural claim without repeated runs and review of the raw artifacts."} Dimensions are reported separately, never as one score; intervals are 95% Wilson intervals that treat every task run as an independent trial.`,
    reference: referenceKey,
    runs,
    harnesses: HARNESS_LABELS.flatMap((harness) => {
      const selected = comparable.filter(({ result }) => result.configuration.harness === harness);
      return selected.length === 0 ? [] : [score(harness, selected)];
    }),
    matrix: matrix(tasks),
    tasks,
  };
}

export async function compareResultFiles(paths: readonly string[], display: (path: string) => string = (path) => path): Promise<ComparisonReport> {
  return compareResults(await Promise.all(paths.map(async (path) => ({ path: display(path), content: await readFile(path, "utf8").catch(() => null) }))));
}

function cell(summary: MetricSummary): string {
  if (summary.total !== null) return `${summary.total}`;
  if (summary.observedTotal === null) return `n/a (0/${summary.unavailable} observed)`;
  return `partial: ${summary.observedTotal} over ${summary.available}/${summary.available + summary.unavailable} observed`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function rateCell(summary: RateSummary | null): string {
  if (summary === null) return "n/a";
  if (summary.rate === null || summary.interval95 === null) return `${summary.count}/${summary.trials}`;
  return `${summary.count}/${summary.trials} (${percent(summary.rate)}, 95% CI ${percent(summary.interval95[0])}–${percent(summary.interval95[1])})`;
}

function label(harness: HarnessScore | { harness: HarnessLabel }): string {
  return `${HARNESS_LETTERS[harness.harness]} ${harness.harness}`;
}

export function renderComparisonMarkdown(report: ComparisonReport): string {
  const lines = ["# Harness comparison", "", `> ${report.warning}`, "", "## Runs", "", "| Artifact | sha256 | Harness | Evidence | Status | Reasons |", "| --- | --- | --- | --- | --- | --- |"];
  for (const run of report.runs) {
    lines.push(`| \`${run.artifact.path}\` | \`${run.artifact.sha256?.slice(0, 12) ?? "unreadable"}\` | ${run.harness ? label({ harness: run.harness }) : "-"} | ${run.evidenceKind ?? "-"} | ${run.status} | ${run.reasons.join("; ") || "-"} |`);
  }
  lines.push("", "## Task success (independent functional grading)", "", "| Harness | Runs | Succeeded | By task kind |", "| --- | --- | --- | --- |");
  for (const harness of report.harnesses) {
    const kinds = Object.entries(harness.byKind).map(([kind, entry]) => `${kind} ${entry.succeeded}/${entry.trials}`).join(", ");
    lines.push(`| ${label(harness)} | ${harness.runs} | ${rateCell(harness.taskSuccess)} | ${kinds} |`);
  }
  lines.push("", "## Assurance violations", "", "| Harness | Regressions | Incorrect done claims | Completed without success | Compliance issues |", "| --- | --- | --- | --- | --- |");
  for (const harness of report.harnesses) {
    const issues = Object.entries(harness.assurance.complianceIssues).map(([code, count]) => `${code} ×${count}`).join(", ") || "-";
    lines.push(`| ${label(harness)} | ${rateCell(harness.assurance.regressions)} | ${rateCell(harness.assurance.incorrectDoneClaims)} | ${rateCell(harness.assurance.completedWithoutSuccess)} | ${issues} |`);
  }
  lines.push("", "## Harness compliance (graded from repository history)", "", "| Harness | Workflow | Compliant | Completed | Effective policies |", "| --- | --- | --- | --- | --- |");
  for (const harness of report.harnesses) {
    const compliance = harness.harnessCompliance;
    lines.push(compliance.applicable
      ? `| ${label(harness)} | ${compliance.workflow} | ${rateCell(compliance.compliant)} | ${rateCell(compliance.completed)} | ${compliance.effectivePolicies.map((policy) => `\`${policy}\``).join(", ")} |`
      : `| ${label(harness)} | n/a | n/a | n/a | ${compliance.reason} |`);
  }
  lines.push("", "## Cost and time", "", "| Harness | Total ms | Median task ms | Max task ms | Tokens | Cost USD |", "| --- | --- | --- | --- | --- | --- |");
  for (const harness of report.harnesses) {
    lines.push(`| ${label(harness)} | ${harness.time.totalMs} | ${harness.time.medianTaskMs ?? "n/a"} | ${harness.time.maxTaskMs ?? "n/a"} | ${cell(harness.metrics.totalTokens)} | ${cell(harness.metrics.costUsd)} |`);
  }
  const metricNames = Object.keys(report.harnesses[0]?.metrics ?? {}) as (keyof HarnessScore["metrics"])[];
  lines.push("", "## Observable metrics (totals only when every task observed the metric)", "", `| Harness | ${metricNames.join(" | ")} |`, `| --- |${metricNames.map(() => " --- |").join("")}`);
  for (const harness of report.harnesses) lines.push(`| ${label(harness)} | ${metricNames.map((name) => cell(harness.metrics[name])).join(" | ")} |`);
  const present = report.harnesses.map((harness) => harness.harness);
  lines.push("", "## Matched tasks (succeeded/trials, compliant in brackets)", "", `| Task | Kind | ${present.map((harness) => label({ harness })).join(" | ")} |`, `| --- | --- |${present.map(() => " --- |").join("")}`);
  for (const row of report.matrix) {
    lines.push(`| ${row.taskId} | ${row.kind} | ${present.map((harness) => {
      const entry = row.harnesses[harness];
      return entry ? `${entry.succeeded}/${entry.trials}${entry.compliant === null ? "" : ` [${entry.compliant}]`}` : "-";
    }).join(" | ")} |`);
  }
  lines.push("", "## Raw task evidence", "", "| Harness | Task | Success | Regressions | False done | Completed | Issues | ms | Pointer |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const task of report.tasks) {
    lines.push(`| ${label({ harness: task.harness })} | ${task.taskId} | ${task.success} | ${task.regressions} | ${task.incorrectDoneClaim} | ${task.completed ?? "n/a"} | ${task.complianceIssues.join(", ") || "-"} | ${task.elapsedMs} | \`${task.artifact}#${task.pointer}\` |`);
  }
  lines.push("", "## Sources", "");
  for (const harness of report.harnesses) {
    lines.push(`- ${label(harness)}: ${harness.artifacts.map((artifact) => `\`${artifact.path}\` (run ${artifact.runId}, sha256 ${artifact.sha256})`).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
