export type HarnessLabel = "no-ways" | "checks-only" | "lightweight-state" | "full-sdd" | "outcome";
export const HARNESS_LABELS: readonly HarnessLabel[] = ["no-ways", "checks-only", "lightweight-state", "full-sdd", "outcome"];
/** Harnesses whose disposable repository has the running Ways package installed and committed. */
export const WAYS_HARNESSES: readonly HarnessLabel[] = ["lightweight-state", "full-sdd", "outcome"];
/** The A–E letters used in issues and reports; results record the label. */
export const HARNESS_LETTERS: Record<HarnessLabel, string> = { "no-ways": "A", "checks-only": "B", "lightweight-state": "C", "full-sdd": "D", "outcome": "E" };

/** Policies an outcome (E) run asks the agent to open with; the committed spec is graded against them. */
export interface OutcomeEvalPolicy {
  isolation: "required" | "optional";
  parallel: "allowed" | "disabled";
  evaluation: "independent" | "self";
  memory: "none" | "normal" | "high";
}
export const DEFAULT_OUTCOME_POLICY: OutcomeEvalPolicy = { isolation: "required", parallel: "allowed", evaluation: "independent", memory: "normal" };

export const TASK_KINDS = ["feature", "resume", "failed-evaluation-remediation", "false-done-claim", "concurrent-conflict"] as const;
export type TaskKind = typeof TASK_KINDS[number];

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
  /** Absent reads as "feature". */
  kind?: TaskKind;
  description: string;
  setup: EvalFile[];
  prompt: string;
  success: EvalCheck[];
  regressions: EvalCheck[];
  /** Checks the task environment exposes to every harness (their files are in setup); Ways harnesses also configure them as the test command. */
  environmentChecks?: EvalCheck[];
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
  /** Present exactly for the outcome (E) harness. */
  outcomePolicy?: OutcomeEvalPolicy;
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
  /** Absolute path of the installed Ways CLI; present only for Ways harnesses (C, D, E). */
  waysBin?: string;
  outcomePolicy?: OutcomeEvalPolicy;
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

export type TaskMetrics = Record<AdapterMetricName | "timeouts" | "remediationAttempts" | "humanApprovals", ObservedMetric> & {
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

export interface ComplianceIssue {
  code: string;
  path: string;
  message: string;
}

/** The Ways workflow a harness asks for: quick work plus an evidence file (C), SDD (D) or the outcome loop (E). */
export type EvalWorkflow = "quick-evidence" | "sdd" | "outcome";

export type HarnessCompliance =
  | { applicable: false; reason: string }
  | {
    applicable: true;
    workflow: EvalWorkflow;
    compliant: boolean;
    /** The task's work reached the workflow's terminal state: quick finish with evidence, SDD close or outcome close. */
    completed: boolean;
    worksStarted: number;
    worksClosed: number;
    downgrades: number;
    remediationAttempts: number;
    /** Recorded check failures: SDD validation failures or failed outcome evaluations. */
    validationFailures: number;
    /** Human approval commits (Harness-State: approved) in the graded history. */
    humanApprovals: number;
    /** Policy the repository recorded for the task's work; null when none was recorded. */
    effectivePolicy: Record<string, string> | null;
    activeWork: string | null;
    issues: ComplianceIssue[];
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

export interface EvalEnvironment {
  waysInstalled: boolean;
  /** Configured Ways test command (regression plus environment checks); null without Ways. */
  testCommand: string[] | null;
  environmentChecks: EvalCheck[];
}

export interface EvalTaskResult {
  taskId: string;
  kind: TaskKind;
  startingRevision: string;
  environment: EvalEnvironment;
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
  schemaVersion: 3;
  runId: string;
  corpus: { id: string; revision: string; digest: string; taskCount: number };
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
    completedCount: number | null;
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
