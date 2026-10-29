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
  /** Runs made; more than one means it failed and was retried (it is then flaky if it passed). */
  attempts?: number;
}

export interface NamedCheckResult extends RunOutput {
  /** Execution id criteria and reports cite: `check:<name>`. */
  id?: string;
  name: CheckName;
  status: CheckStatus;
  command?: CommandArgv;
  exitCode?: number;
  detail?: string;
  /** Tests the run executed, when the runner printed a known summary. */
  tests?: number;
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
  /** Where `ways done` runs: a clean checkout of the commit (default) or the working tree (`fast`). */
  evaluation?: EvaluationMode;
  approvals?: ApprovalsConfig;
  /** The reviewer `ways review` launches when no `--agent` is given. */
  reviewer?: ReviewerConfig;
}

export type EvaluationMode = "clean" | "fast";

export interface ApprovalsConfig {
  /** `required`: an approval counts only with an SSH signature verified against `.ways/allowed_signers` of the base. */
  signature?: "required" | "optional";
  /** Who may accept changes to existing tests or check configuration: the human only, or also an attested independent review. */
  verifierChanges?: "human" | "human-or-review";
  /** `required`: every new outcome needs the human's approval of its criteria and evidence before it closes. */
  criteria?: "required" | "none";
}

export interface ReviewerConfig {
  agent?: "claude" | "pi";
  /** A command that reads the review prompt on stdin and prints the review JSON; replaces the agent preset. */
  command?: CommandArgv;
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
  /** Changed verifier-surface files (or `tests-ran`) the reviewer inspected and accepts as legitimate. */
  accepts?: string[];
}

/**
 * Where a review came from, as ways saw it, never as the reviewer declared:
 * - `process`: ways launched the reviewer as a new read-only process with a prompt it built;
 * - `subagent`: a Claude Code `ways-reviewer` subagent, recorded by the SubagentStop hook;
 * - `terminal`: typed by a human at an interactive terminal.
 */
export interface ReviewProvenance {
  via: "process" | "subagent" | "terminal";
  agent?: string;
  session?: string;
  agentId?: string;
  agentType?: string;
  command?: CommandArgv;
  /** sha256 of the prompt ways gave the reviewer. */
  promptSha256?: string;
  /** Tools the reviewer was limited to. */
  tools?: string[];
}

export interface Review {
  reviewer: string;
  /** The evaluated input commit the reviewer looked at. */
  commit: string;
  verdict: "pass" | "fail";
  findings: ReviewFinding[];
  submittedAt: string;
  provenance?: ReviewProvenance;
}

export interface ApprovalSignature {
  namespace: "ways-approval";
  /** The principal of `.ways/allowed_signers` (at the base) whose key verified it. */
  principal: string;
  /** Armored SSH signature over the approval payload. */
  signature: string;
}

export interface Approval {
  by: string;
  at: string;
  /** Evaluated input commit the human approved. */
  input: string;
  /** Digest of the criteria, evidence and review the human saw. */
  digest: string;
  reasons: string[];
  /** How the human was told apart from the agent: an SSH signature, or only an interactive terminal. */
  via?: "ssh-signature" | "terminal";
  signature?: ApprovalSignature;
}

/** What a verifier returned on the base commit: it should fail there and pass on the input. */
export interface BaselineResult {
  id: string;
  commit: string;
  status: "failed" | "passed" | "error" | "not-run";
  exitCode?: number;
  outputSha256?: string;
  tail?: string;
  detail?: string;
}

export interface CriterionEvidence extends RunOutput {
  /** Execution id: the criterion id for its run on the input. */
  id?: string;
  /** Declared strength. */
  strength: Strength;
  /** Strength the evidence supports: `review-only` when the verifier already passes on the base. */
  effective?: Strength;
  status: "passed" | "failed" | "review-only";
  command?: CommandArgv;
  exitCode?: number;
  detail?: string;
  /** Ids of the executions this criterion rests on (input, base). */
  runs?: string[];
  baseline?: BaselineResult;
  /** The agent's note, the only part of the evidence it writes. */
  note?: string;
}

/** Where and with what the evaluation ran: enough to reproduce or question it. */
export interface RunnerInfo {
  /** A clean checkout of the input (true) or the working tree (`--fast`). */
  clean: boolean;
  platform: string;
  arch: string;
  node: string;
  ways: string;
  /** How dependencies were present in the checkout. */
  dependencies: string;
  /** Whose configuration the checks ran with: the base's (default) or the input's (the base has none). */
  contractFrom: "base" | "input";
}

export interface TestsRatchet {
  /** Tests the test check ran on the input. */
  ran: number;
  baseline?: { commit: string; ran: number };
  /** Fewer tests ran than on the baseline: a change of the verifier surface. */
  dropped: boolean;
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
  runner?: RunnerInfo;
  tests?: TestsRatchet;
  /** Execution ids that failed first and passed on a retry. */
  flaky?: string[];
  /** The approval policy of the base this evidence is judged under. */
  approvals?: Pick<ApprovalsConfig, "signature" | "verifierChanges">;
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
  /** The agent stopped on purpose: what is missing and what would unblock it. A legitimate exit, waiting on the human. */
  blocked?: { at: string; reason: string; input: string };
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
