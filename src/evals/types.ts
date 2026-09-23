export type HarnessLabel = "no-ways" | "checks-only" | "full-sdd";
export const HARNESS_LABELS: readonly HarnessLabel[] = ["no-ways", "checks-only", "full-sdd"];

export interface EvalFile {
  path: string;
  content: string;
}

export interface EvalCheck {
  id: string;
  command: string[];
  expectedExitCode: number;
  expectedStdout?: string;
  expectedStderr?: string;
}

export interface EvalResume {
  prompt: string;
  fakePatch?: EvalFile[];
}

export interface EvalTask {
  id: string;
  description: string;
  setup: EvalFile[];
  prompt: string;
  success: EvalCheck[];
  regressions: EvalCheck[];
  fakePatch?: EvalFile[];
  freshSessionResume?: EvalResume;
}

export interface EvalCorpus {
  schemaVersion: 1;
  id: string;
  revision: string;
  tasks: EvalTask[];
}

export interface EvalBudgets {
  maxMilliseconds: number;
  maxOutputBytes: number;
}

export interface EvalConfiguration {
  adapter: { id: string; argv: string[] };
  harness: HarnessLabel;
  model: string;
  startingRevision: string;
  budgets: EvalBudgets;
  seed: number;
}

export interface AdapterInput {
  task: EvalTask;
  repo: string;
  prompt: string;
  session: "initial" | "resume";
  harness: HarnessLabel;
  model: string;
  startingRevision: string;
  seed: number;
  maxOutputBytes: number;
  /** Absolute path of the installed Ways CLI; present only for the full-sdd harness. */
  waysBin?: string;
  signal: AbortSignal;
}

export interface UsageMetrics {
  available: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  reason?: string;
}

export interface AdapterExecution {
  doneClaim: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  overflow: boolean;
  error?: string;
  usage?: UsageMetrics;
  metrics?: AdapterMetrics;
}

export const ADAPTER_METRICS = ["toolCalls", "contextCompactions", "retries", "humanInterventions", "stalls"] as const;
export type AdapterMetricName = typeof ADAPTER_METRICS[number];
export type AdapterMetrics = Partial<Record<AdapterMetricName, number | null>>;

export interface ObservedMetric<T extends number | boolean = number> {
  value: T | null;
  source: "adapter" | "runner" | "repository";
  reason?: string;
}

export type TaskMetrics = Record<AdapterMetricName | "timeouts" | "remediationAttempts", ObservedMetric> & {
  resumeSuccess: ObservedMetric<boolean>;
};

export interface WaysRevision {
  packageName: string;
  packageVersion: string;
  harnessVersion: string;
  sourceRevision: string | null;
  sourceRevisionReason?: string;
  contentDigest: string;
}

export type HarnessCompliance =
  | { applicable: false; reason: string }
  | {
    applicable: true;
    compliant: boolean;
    fullSddCompleted: boolean;
    sddWorksStarted: number;
    sddWorksClosed: number;
    downgrades: number;
    remediationAttempts: number;
    validationFailures: number;
    activeWork: string | null;
    issues: { code: string; path: string; message: string }[];
  };

export interface EvalCriterionResult {
  id: string;
  passed: boolean;
  expected: EvalCheck;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GradedResult {
  success: boolean;
  regressions: boolean;
  successCriteria: EvalCriterionResult[];
  regressionCriteria: EvalCriterionResult[];
}
export interface EvalSessionResult {
  session: "initial" | "resume";
  doneClaim: boolean;
  elapsedMs: number;
  usage: UsageMetrics;
  metrics: AdapterMetrics;
  adapter: { exitCode: number | null; timedOut: boolean; overflow: boolean; error: string | null };
  grading: GradedResult;
}

export interface EvalTaskResult {
  taskId: string;
  startingRevision: string;
  freshSessionResume: boolean;
  success: boolean;
  regressions: boolean;
  incorrectDoneClaim: boolean;
  elapsedMs: number;
  usage: UsageMetrics;
  metrics: TaskMetrics;
  compliance: HarnessCompliance;
  sessions: EvalSessionResult[];
}

export interface HarnessPrompt {
  initial: string;
  resume: string;
}

export type EvidenceKind = "fixture" | "real";

export interface EvalRunResult {
  schemaVersion: 2;
  runId: string;
  corpus: { id: string; revision: string; taskCount: number };
  configuration: EvalConfiguration;
  waysRevision: WaysRevision;
  harnessPrompt: HarnessPrompt | null;
  startedAt: string;
  finishedAt: string;
  evidence: { kind: EvidenceKind; architecturalBenchmark: false; warning: string };
  tasks: EvalTaskResult[];
  summary: {
    taskCount: number;
    successCount: number;
    regressionCount: number;
    incorrectDoneClaimCount: number;
    compliantCount: number | null;
    elapsedMs: number;
  };
}

export interface EvalRunOptions {
  corpus?: EvalCorpus;
  corpusPath?: string;
  configuration: EvalConfiguration;
  adapter?: EvalAdapter;
  now?: () => Date;
}

export interface EvalAdapter {
  id: string;
  argv: string[];
  /** Synthetic adapters produce runner fixtures, never real-run evidence. */
  synthetic?: boolean;
  run(input: AdapterInput): Promise<AdapterExecution>;
}
