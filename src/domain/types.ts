export const MODES = ["query", "quick", "plan", "sdd"] as const;
export type Mode = (typeof MODES)[number];

export type SddPhase =
  | "intake"
  | "explore"
  | "assess"
  | "specify"
  | "plan"
  | "decompose"
  | "implement"
  | "review"
  | "validate"
  | "reconcile-memory"
  | "close";

export type WorkStatus = "active" | "blocked" | "completed" | "cancelled";
export type ApprovalProfile = "autonomous" | "supervised";
export type ExecutionMode = "inline" | "delegated";
export type TaskStatus = "pending" | "ready" | "active" | "review" | "completed" | "blocked";
export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingDisposition = "open" | "fixed" | "accepted" | "deferred";
export type RemediationSource = "review" | "validate";
export type RemediationTarget = "implement" | "decompose" | "plan" | "specify";

export const CHECK_NAMES = ["test", "lint", "typecheck", "build", "e2e"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];
export type CheckStatus = "passed" | "failed" | "timed-out" | "skipped" | "unavailable";

export type CommandArgv = string[];

/** Optional additive environment contract. Legacy testCommand remains the fallback. */
export interface NamedChecksConfig {
  test?: CommandArgv;
  lint?: CommandArgv;
  typecheck?: CommandArgv;
  build?: CommandArgv;
  e2e?: CommandArgv;
  required: CheckName[];
  timeoutMs?: number;
  /** Opt-in environment preparation, run only at execution boundaries before services start. */
  setup?: CommandArgv;
  /** Opt-in services started, probed for readiness and stopped around execution-boundary checks. */
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
  /** Repository-relative service log under the ignored runtime directory. */
  log?: string;
}

export interface NamedCheckResult {
  name: CheckName;
  status: CheckStatus;
  command?: CommandArgv;
  exitCode?: number;
  detail?: string;
}

export type NamedCheckEvidence = NamedCheckResult;


export interface TaskState {
  id: string;
  title: string;
  /** Absent on v1 task records and therefore interpreted as attempt zero. */
  attempt?: number;
  status: TaskStatus;
  dependsOn: string[];
  commits: string[];
  branch?: string;
  worktree?: string;
}

export interface WorkState {
  schemaVersion: 1;
  harnessVersion: string;
  id: string;
  mode: Exclude<Mode, "query">;
  status: WorkStatus;
  baseCommit: string;
  gateCommit: string;
  createdAt: string;
  updatedAt: string;
  profile?: ApprovalProfile;
  execution?: ExecutionMode;
  /** Absent on legacy SDD state and therefore interpreted as workflow version one. */
  workflowVersion?: number;
  phase?: SddPhase;
  lastCompletedPhase?: SddPhase;
  planPath?: string;
  /** Absent on v1 state files and therefore interpreted as attempt zero. */
  attempt?: number;
  remediation?: RemediationMetadata;
  tasks: TaskState[];
}

export interface MemoryConfig {
  releaseBranch: string;
  integrationBranch?: string;
  reconciliationBranchPattern: string;
  relevantPaths: string[];
  excludedPaths: string[];
}
export interface HarnessConfig {
  schemaVersion: 1;
  harnessVersion: string;
  testCommand: string[];
  commands?: NamedChecksConfig;
  defaultBranch?: string;
  historySince?: string;
  memory?: MemoryConfig;
}

export interface ManagedManifest {
  schemaVersion: 1;
  harnessVersion: string;
  generatedAt: string;
  managedFiles: Record<string, string>;
  adapters?: Record<string, Record<string, string>>;
}

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  summary: string;
  disposition: FindingDisposition;
}

export interface ReviewResult {
  schemaVersion: 1;
  workId: string;
  reviewer: string;
  digest: string;
  verdict: "pass" | "fail";
  findings: ReviewFinding[];
  /** Absent on v1 review records and therefore interpreted as attempt zero. */
  attempt?: number;
  taskId?: string;
}

export interface ApprovalRecord {
  schemaVersion: 1;
  workId: string;
  phase: SddPhase;
  gateCommit: string;
  digest: string;
  approvedBy: string;
  approvedAt: string;
  /** Absent on v1 approval records and therefore interpreted as attempt zero. */
  attempt?: number;
}

export interface ReviewFailureEvidence {
  kind: "review";
  review: ReviewResult & { verdict: "fail" };
}

export interface ValidationCheckFailure {
  check: string;
  detail: string;
}

export interface ValidationFailureRecord {
  schemaVersion: 1;
  workId: string;
  attempt: number;
  phase: "validate";
  /** Immutable commit and tree on which the checks were run. */
  inputCommit: string;
  inputTree: string;
  /** Legacy fallback command, retained for v1 records. */
  testCommand: string[];
  /** Immutable selected named-check contract, absent on legacy records. */
  commands?: NamedChecksConfig;
  checks: {
    integrity: Array<{ code: string; path: string; message: string }>;
    testExitCode?: number;
    named?: NamedCheckEvidence[];
    environment?: EnvironmentResult[];
  };
  digest: string;
}

/** Legacy inline failures remain readable; new remediation links a committed failure record. */
export interface LegacyValidationFailureEvidence {
  kind: "validate";
  failures: ValidationCheckFailure[];
}

export interface ValidationFailureEvidence {
  kind: "validate";
  failureRecord: {
    commit: string;
    tree: string;
    digest: string;
  };
}

export type RemediationEvidence = ReviewFailureEvidence | LegacyValidationFailureEvidence | ValidationFailureEvidence;

/** The attempt-scoped state needed to reopen an SDD work without erasing its prior gate. */
export interface RemediationMetadata {
  source: RemediationSource;
  target: RemediationTarget;
  reason: string;
  evidence: RemediationEvidence;
  priorCheckpoint: string;
  attempt: number;
  timestamp: string;
}

/** Immutable transition record written when a remediation attempt is opened. */
export interface RemediationRecord extends RemediationMetadata {
  schemaVersion: 1;
  workId: string;
}
