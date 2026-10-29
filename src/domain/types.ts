export const CHECK_NAMES = ["test", "lint", "typecheck", "build", "e2e"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];
export type CheckStatus = "passed" | "failed" | "timed-out" | "skipped" | "unavailable";

export type CommandArgv = string[];

/** Optional additive environment contract. `testCommand` remains the fallback. */
export interface NamedChecksConfig {
  test?: CommandArgv;
  lint?: CommandArgv;
  typecheck?: CommandArgv;
  build?: CommandArgv;
  e2e?: CommandArgv;
  required: CheckName[];
  timeoutMs?: number;
  /** Opt-in environment preparation, run before services start. */
  setup?: CommandArgv;
  /** Opt-in services started, probed for readiness and stopped around the checks. */
  services?: ServiceConfig[];
}

/** Exactly one bounded readiness probe. */
export type ServiceReadiness = { command: CommandArgv } | { tcp: { port: number; host?: string } } | { http: string };

export interface ServiceConfig {
  name: string;
  command: CommandArgv;
  ready: ServiceReadiness;
  /** Readiness deadline in milliseconds; defaults to 30000. */
  timeoutMs?: number;
}

/** Setup and service outcome; any non-passed status makes the evaluation unhealthy. */
export interface EnvironmentResult {
  kind: "setup" | "service";
  name: string;
  status: "passed" | "failed" | "timed-out" | "unavailable";
  command?: CommandArgv;
  exitCode?: number;
  detail?: string;
  /** Path of the service log under the runtime directory. */
  log?: string;
}

/** What the harness records about one command it ran. */
export interface RunOutput {
  durationMs?: number;
  /** sha256 of the combined stdout and stderr. */
  outputSha256?: string;
  /** Last lines of the combined output. */
  tail?: string;
}

export interface NamedCheckResult extends RunOutput {
  name: CheckName;
  status: CheckStatus;
  command?: CommandArgv;
  exitCode?: number;
  detail?: string;
}

/** The commands an evaluation ran under: the test command plus the optional named contract. */
export interface CheckContract {
  testCommand: CommandArgv;
  commands?: NamedChecksConfig;
}

/** observe: the commit hook only refuses commits that break a guarantee. enforce: also refuses commits outside an active work. */
export type Enforcement = "observe" | "enforce";
export const ENFORCEMENTS: readonly Enforcement[] = ["observe", "enforce"];

export interface HarnessConfig {
  schemaVersion: 2;
  harnessVersion: string;
  enforcement?: Enforcement;
  testCommand: string[];
  commands?: NamedChecksConfig;
  /** Default review policy of new outcomes; absent reads as required. */
  review?: ReviewPolicy;
  /** Globs of the verifier surface: modifying or deleting an existing file here needs human approval. */
  verifierPaths?: string[];
  /** Oldest commit the history audit looks at. */
  historySince?: string;
}

export interface ManagedManifest {
  schemaVersion: 1;
  harnessVersion: string;
  generatedAt: string;
  managedFiles: Record<string, string>;
  adapters?: Record<string, Record<string, string>>;
}

/** How strong the evidence a verifier gives is, strongest first. `review-only` has no verifier. */
export const STRENGTHS = ["proof", "property", "test", "e2e", "review-only"] as const;
export type Strength = (typeof STRENGTHS)[number];

export interface Criterion {
  id: string;
  text: string;
  /** Executable verifier, run without a shell. Absent exactly when strength is review-only. */
  verify?: CommandArgv;
  strength: Strength;
}

export type ReviewPolicy = "required" | "none";
export type ApprovalPolicy = "required" | "none";

export interface WorkPolicy {
  review: ReviewPolicy;
  approval: ApprovalPolicy;
}

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingDisposition = "open" | "fixed" | "accepted" | "deferred";

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  summary: string;
  disposition?: FindingDisposition;
}

export interface Review {
  reviewer: string;
  /** The evaluated input commit the reviewer looked at. */
  commit: string;
  verdict: "pass" | "fail";
  findings: ReviewFinding[];
  submittedAt: string;
}

export interface Approval {
  by: string;
  at: string;
  /** Evaluated input commit the human approved. */
  input: string;
  /** Digest of the criteria, evidence and review the human saw. */
  digest: string;
  reasons: string[];
}

export interface CriterionEvidence extends RunOutput {
  strength: Strength;
  status: "passed" | "failed" | "review-only";
  command?: CommandArgv;
  exitCode?: number;
  detail?: string;
}

export interface IntegrityIssue {
  code: string;
  path: string;
  message: string;
}

export interface EarlierRun {
  at: string;
  input: string;
  passed: boolean;
  failed: string[];
}

/** Written only by `ways done`: what ran, on which input, and what it returned. */
export interface Evidence {
  base: string;
  input: { commit: string; tree: string };
  contract: CheckContract;
  integrity: IntegrityIssue[];
  checks: NamedCheckResult[];
  /** Setup and services started around the checks, when configured. */
  environment?: EnvironmentResult[];
  criteria: Record<string, CriterionEvidence>;
  /** Existing verifier-surface files the increment modified or deleted. */
  verifierChanges: string[];
  passed: boolean;
  ranAt: string;
  earlierRuns: EarlierRun[];
}

export type WorkKind = "outcome" | "change";

/**
 * The only committed work artifact, `.ways/work/<id>.json`. An outcome opens
 * it with its goal, criteria and policy, which never change afterwards; a
 * change gets one only when it must persist a human approval. Every other
 * field is written by the harness.
 */
export interface WorkRecord {
  schemaVersion: 2;
  id: string;
  kind: WorkKind;
  goal?: string;
  criteria: Criterion[];
  policy: WorkPolicy;
  openedAt: string;
  evidence?: Evidence;
  review?: Review;
  approval?: Approval;
  closed?: { at: string };
  cancelled?: { at: string };
}

/** The work active in one worktree; runtime, never committed. */
export interface ActiveWork {
  schemaVersion: 1;
  id: string;
  kind: WorkKind;
  /** HEAD when the work started; the increment is base..HEAD. */
  base: string;
  startedAt: string;
  /** How it started: `ways start`, `ways outcome open`, or a commit in observe mode. */
  origin: "start" | "outcome" | "commit";
}
