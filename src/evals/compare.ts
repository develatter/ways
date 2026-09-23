import { readFile } from "node:fs/promises";
import { sha256, stableJson } from "../fs/files.js";
import { ADAPTER_METRICS, HARNESS_LABELS, type EvalRunResult, type EvidenceKind, type HarnessLabel, type TaskMetrics } from "./types.js";

export interface ArtifactLink {
  path: string;
  sha256: string;
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
  total: number | null;
  available: number;
  unavailable: number;
  reasons: string[];
}

export interface HarnessScore {
  harness: HarnessLabel;
  runs: number;
  artifacts: ArtifactLink[];
  taskSuccess: { succeeded: number; tasks: number; rate: number | null };
  regressions: number;
  incorrectDoneClaims: number;
  harnessCompliance:
    | { applicable: false; reason: string }
    | { applicable: true; compliant: number; fullSddCompleted: number; tasks: number; rate: number | null };
  metrics: Record<keyof TaskMetrics | "totalTokens" | "costUsd", MetricSummary>;
}

export interface ComparedTask {
  taskId: string;
  harness: HarnessLabel;
  success: boolean;
  compliant: boolean | null;
  artifact: string;
  pointer: string;
}

export interface ComparisonReport {
  schemaVersion: 1;
  architecturalClaim: false;
  evidenceKind: EvidenceKind | null;
  warning: string;
  reference: ComparabilityKey | null;
  runs: ComparedRun[];
  harnesses: HarnessScore[];
  tasks: ComparedTask[];
}

type ComparabilityKey = Pick<EvalRunResult["configuration"], "model" | "seed" | "budgets" | "adapter"> & { corpus: string; revision: string; runnerDigest: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "result is not a JSON object";
  if (value.schemaVersion !== 2) return `result schemaVersion ${String(value.schemaVersion)} is not 2; re-run with the current runner`;
  const { corpus, configuration, evidence, waysRevision, tasks } = value;
  if (typeof value.runId !== "string" || !isObject(corpus) || typeof corpus.id !== "string" || typeof corpus.revision !== "string") return "result lacks runId or corpus identity";
  if (!isObject(configuration) || !HARNESS_LABELS.includes(configuration.harness as HarnessLabel) || typeof configuration.model !== "string"
    || typeof configuration.seed !== "number" || !isObject(configuration.budgets) || !isObject(configuration.adapter)) return "result configuration is malformed";
  if (!isObject(evidence) || (evidence.kind !== "fixture" && evidence.kind !== "real")) return "result evidence kind is missing";
  if (!isObject(waysRevision) || typeof waysRevision.contentDigest !== "string") return "result lacks the Ways revision";
  if (!Array.isArray(tasks) || tasks.some((task) => !isObject(task) || typeof task.taskId !== "string" || typeof task.success !== "boolean"
    || !isObject(task.metrics) || !isObject(task.compliance) || !isObject(task.usage))) return "result tasks are malformed";
  return undefined;
}

function keyOf(result: EvalRunResult): ComparabilityKey {
  const { model, seed, budgets, adapter } = result.configuration;
  return { corpus: result.corpus.id, revision: result.corpus.revision, model, seed, budgets, adapter, runnerDigest: result.waysRevision.contentDigest };
}

function differences(reference: ComparabilityKey, key: ComparabilityKey): string[] {
  return (Object.keys(reference) as (keyof ComparabilityKey)[])
    .filter((field) => stableJson(reference[field]) !== stableJson(key[field]))
    .map((field) => `${field} differs from the reference run`);
}

function metricSummary(values: readonly { value: number | boolean | null; reason?: string }[]): MetricSummary {
  const available = values.filter((metric) => metric.value !== null);
  const reasons = [...new Set(values.flatMap((metric) => metric.value === null && metric.reason ? [metric.reason] : []))].sort();
  return {
    total: available.length === 0 ? null : available.reduce((sum, metric) => sum + Number(metric.value), 0),
    available: available.length,
    unavailable: values.length - available.length,
    reasons,
  };
}

function score(harness: HarnessLabel, runs: readonly { result: EvalRunResult; artifact: ArtifactLink }[]): HarnessScore {
  const tasks = runs.flatMap(({ result }) => result.tasks);
  const metricNames = [...ADAPTER_METRICS, "timeouts", "remediationAttempts", "resumeSuccess"] as const;
  const metrics = Object.fromEntries(metricNames.map((name) => [name, metricSummary(tasks.map((task) => task.metrics[name]))])) as HarnessScore["metrics"];
  for (const field of ["totalTokens", "costUsd"] as const) {
    metrics[field] = metricSummary(tasks.map((task) => ({ value: task.usage[field], ...(task.usage.reason ? { reason: task.usage.reason } : {}) })));
  }
  const graded = tasks.flatMap((task) => task.compliance.applicable ? [task.compliance] : []);
  const succeeded = tasks.filter((task) => task.success).length;
  return {
    harness,
    runs: runs.length,
    artifacts: runs.map(({ artifact }) => artifact),
    taskSuccess: { succeeded, tasks: tasks.length, rate: tasks.length === 0 ? null : succeeded / tasks.length },
    regressions: tasks.filter((task) => task.regressions).length,
    incorrectDoneClaims: tasks.filter((task) => task.incorrectDoneClaim).length,
    harnessCompliance: harness === "full-sdd"
      ? {
        applicable: true,
        compliant: graded.filter((compliance) => compliance.compliant).length,
        fullSddCompleted: graded.filter((compliance) => compliance.fullSddCompleted).length,
        tasks: tasks.length,
        rate: tasks.length === 0 ? null : graded.filter((compliance) => compliance.compliant).length / tasks.length,
      }
      : { applicable: false, reason: `harness ${harness} does not run Ways SDD` },
    metrics,
  };
}

/** Compares raw run results; only runs that hold every controlled variable constant are scored. */
export function compareResults(inputs: readonly { path: string; content: string }[]): ComparisonReport {
  const parsed = inputs.map(({ path, content }) => {
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
  const runs: ComparedRun[] = [];
  const comparable: { result: EvalRunResult; artifact: ArtifactLink }[] = [];
  for (const entry of parsed) {
    if (!entry.result) {
      runs.push({ artifact: entry.artifact, status: "invalid", reasons: [entry.problem], harness: null, evidenceKind: null });
      continue;
    }
    const reasons = referenceKey ? differences(referenceKey, keyOf(entry.result)) : [];
    if (reference && entry.result.evidence.kind !== reference.result.evidence.kind) reasons.push("mixes fixture and real evidence");
    if (seen.has(entry.result.runId)) reasons.push("duplicate run");
    seen.add(entry.result.runId);
    runs.push({ artifact: entry.artifact, status: reasons.length === 0 ? "comparable" : "non-comparable", reasons, harness: entry.result.configuration.harness, evidenceKind: entry.result.evidence.kind });
    if (reasons.length === 0) comparable.push({ result: entry.result, artifact: entry.artifact });
  }
  const evidenceKind = reference?.result.evidence.kind ?? null;
  return {
    schemaVersion: 1,
    architecturalClaim: false,
    evidenceKind,
    warning: evidenceKind === "fixture"
      ? "Runner fixtures only: these scores exercise the runner and grader and say nothing about harness quality."
      : "Scores compare the listed real runs only; they are not an architectural claim without repeated runs and review of the raw artifacts.",
    reference: referenceKey,
    runs,
    harnesses: HARNESS_LABELS.flatMap((harness) => {
      const selected = comparable.filter(({ result }) => result.configuration.harness === harness);
      return selected.length === 0 ? [] : [score(harness, selected)];
    }),
    tasks: comparable.flatMap(({ result, artifact }) => result.tasks.map((task, index) => ({
      taskId: task.taskId,
      harness: result.configuration.harness,
      success: task.success,
      compliant: task.compliance.applicable ? task.compliance.compliant : null,
      artifact: artifact.path,
      pointer: `/tasks/${index}`,
    }))),
  };
}

export async function compareResultFiles(paths: readonly string[], display: (path: string) => string = (path) => path): Promise<ComparisonReport> {
  return compareResults(await Promise.all(paths.map(async (path) => ({ path: display(path), content: await readFile(path, "utf8") }))));
}

function cell(summary: MetricSummary): string {
  return summary.total === null ? `n/a (${summary.unavailable} unavailable)` : `${summary.total} (${summary.available}/${summary.available + summary.unavailable})`;
}

function percent(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

export function renderComparisonMarkdown(report: ComparisonReport): string {
  const lines = ["# Harness comparison", "", `> ${report.warning}`, "", "## Runs", "", "| Artifact | sha256 | Harness | Evidence | Status | Reasons |", "| --- | --- | --- | --- | --- | --- |"];
  for (const run of report.runs) {
    lines.push(`| \`${run.artifact.path}\` | \`${run.artifact.sha256.slice(0, 12)}\` | ${run.harness ?? "-"} | ${run.evidenceKind ?? "-"} | ${run.status} | ${run.reasons.join("; ") || "-"} |`);
  }
  lines.push("", "## Task success (independent functional grading)", "", "| Harness | Runs | Succeeded | Rate | Regressions | Incorrect done claims |", "| --- | --- | --- | --- | --- | --- |");
  for (const harness of report.harnesses) {
    lines.push(`| ${harness.harness} | ${harness.runs} | ${harness.taskSuccess.succeeded}/${harness.taskSuccess.tasks} | ${percent(harness.taskSuccess.rate)} | ${harness.regressions} | ${harness.incorrectDoneClaims} |`);
  }
  lines.push("", "## Harness compliance (graded from repository history)", "", "| Harness | Compliant | Full SDD completed | Rate |", "| --- | --- | --- | --- |");
  for (const harness of report.harnesses) {
    const compliance = harness.harnessCompliance;
    lines.push(compliance.applicable
      ? `| ${harness.harness} | ${compliance.compliant}/${compliance.tasks} | ${compliance.fullSddCompleted}/${compliance.tasks} | ${percent(compliance.rate)} |`
      : `| ${harness.harness} | n/a | n/a | ${compliance.reason} |`);
  }
  const metricNames = Object.keys(report.harnesses[0]?.metrics ?? {}) as (keyof HarnessScore["metrics"])[];
  lines.push("", "## Observable metrics (total, available/tasks)", "", `| Harness | ${metricNames.join(" | ")} |`, `| --- |${metricNames.map(() => " --- |").join("")}`);
  for (const harness of report.harnesses) lines.push(`| ${harness.harness} | ${metricNames.map((name) => cell(harness.metrics[name])).join(" | ")} |`);
  lines.push("", "## Sources", "");
  for (const harness of report.harnesses) {
    lines.push(`- ${harness.harness}: ${harness.artifacts.map((artifact) => `\`${artifact.path}\` (run ${artifact.runId}, sha256 ${artifact.sha256})`).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
