#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { installAdapter, PROVIDERS } from "./adapters/install.js";
import { bootstrap } from "./bootstrap/bootstrap.js";
import { runChecks } from "./check/check.js";
import { effectiveMemoryConfig, loadConfig } from "./config/config.js";
import { runCommitMsgHook } from "./hooks/hook.js";
import { checkHistory } from "./integrity/history.js";
import { stableJson, writeAtomic } from "./fs/files.js";
import { HARNESS_NAME, HARNESS_VERSION } from "./index.js";
import { writeIndexes } from "./knowledge/indexes.js";
import type { MemoryState, ReconciliationEvidence } from "./memory/model.js";
import { inspectOkf } from "./knowledge/okf.js";
import type { NamedChecksConfig } from "./domain/types.js";
import {
  inspectReconciliationCandidate,
  validateBackSyncMerge,
  validatePublicationMerge,
  validateReconciliationEvidence,
  type ReconciliationRequest,
} from "./memory/reconciliation.js";
import {
  commitMemory,
  completeDiscovery,
  discoveryReviewDigest,
  MEMORY_STATE_PATH,
  memoryCommitReviewDigest,
  requestDiscovery,
} from "./memory/workflow.js";
import { buildContext, renderContext } from "./context/context.js";
import { queryKnowledgeResult } from "./query/query.js";
import { adoptHead, diagnose, restoreStateFromHead, rollbackToLastGate } from "./repair/repair.js";
import { projectStatus, readStatus, statusMatches } from "./state/status.js";
import { loadState } from "./state/store.js";
import { abandonPlan, finishPlan, promotePlan, proposePlan, startPlan } from "./work/plan.js";
import { cancelQuick, finishQuick, startQuick } from "./work/quick.js";
import { approveInteractively } from "./work/approve.js";
import { reviewDigest, submitReview } from "./work/review.js";
import { advanceSdd, downgradeSdd, startSdd } from "./work/sdd.js";
import { cancelOutcome, closeOutcome, evaluateOutcome, openOutcome, parseCriterion, remediateOutcome } from "./work/outcome.js";
import { remediateSdd } from "./work/remediation.js";
import { recordValidationFailure } from "./work/validation-failure.js";
import { addTask, integrateTask, prepareTask } from "./work/tasks.js";
import { applyUpgrade, planUpgrade } from "./upgrade/upgrade.js";
import { runEvals } from "./evals/runner.js";
import { commandAdapter, fakeAdapter } from "./evals/adapters.js";
import { compareResultFiles, renderComparisonMarkdown } from "./evals/compare.js";
import { HARNESS_LABELS, type HarnessLabel } from "./evals/types.js";

function option(args: readonly string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function options(args: readonly string[], name: string): string[] {
  return args.filter((arg) => arg.startsWith(`${name}=`)).map((arg) => arg.slice(name.length + 1));
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`Missing required option ${name}=<value>`);
  return value;
}

function userPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

async function readJson<T>(cwd: string, path: string): Promise<T> {
  return JSON.parse(await readFile(isAbsolute(path) ? path : join(cwd, path), "utf8")) as T;
}

function printIssues(issues: readonly { code: string; path: string; message: string }[]): number {
  for (const issue of issues) console.error(`${issue.code}: ${issue.path}: ${issue.message}`);
  return issues.length === 0 ? 0 : 1;
}

export async function run(argv: readonly string[], cwd = process.cwd()): Promise<number> {
  const [command, ...args] = argv;

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(HARNESS_VERSION);
    return 0;
  }

  if (command === "--help" || command === "-h" || command === undefined) {
    console.log(`${HARNESS_NAME} ${HARNESS_VERSION}\n\nUsage: ways <command>`);
    return 0;
  }

  if (command === "upgrade") {
    const plan = await planUpgrade(cwd);
    if (!args.includes("--apply")) {
      console.log(`Upgrade ${plan.from} -> ${plan.to}`);
      for (const path of plan.modifiedManagedFiles) console.log(`- [ ] overwrite ${path}`);
      return 0;
    }
    const approved = args.includes("--overwrite-all") ? new Set(["*"]) : new Set(args.filter((arg) => arg.startsWith("--overwrite=")).map((arg) => arg.slice(12)));
    await applyUpgrade(cwd, approved);
    console.log(`Harness upgraded to ${plan.to}.`);
    return 0;
  }

  if (command === "repair") {
    const [strategy] = args;
    if (!strategy || strategy === "diagnose") {
      const result = await diagnose(cwd);
      console.log(result.message);
      return result.consistent ? 0 : 1;
    }
    if (strategy === "adopt-head") {
      await adoptHead(cwd);
      console.log("State adopted from certified HEAD history.");
      return 0;
    }
    if (strategy === "restore-state") {
      await restoreStateFromHead(cwd);
      console.log("State restored from HEAD.");
      return 0;
    }
    if (strategy === "last-gate") {
      console.log(`Rolled back to ${await rollbackToLastGate(cwd, args.includes("--discard"))}`);
      return 0;
    }
    throw new Error("Usage: ways repair [diagnose|adopt-head|restore-state|last-gate --discard]");
  }

  if (command === "context") {
    const packet = await buildContext(cwd);
    process.stdout.write(args.includes("--json") ? stableJson(packet) : renderContext(packet));
    return 0;
  }

  if (command === "status") {
    const state = await loadState(cwd);
    if (args.includes("--json")) {
      const artifact = await readStatus(cwd);
      console.log(JSON.stringify(statusMatches(artifact, state) ? artifact : projectStatus(state), null, 2));
      return 0;
    }
    console.log(state ? JSON.stringify(state, null, 2) : "No active mutating work.");
    return 0;
  }

  if (command === "hook") {
    const [name, messagePath] = args;
    if (name !== "commit-msg" || !messagePath) throw new Error("Usage: ways hook commit-msg <message-file>");
    const verdict = await runCommitMsgHook(cwd, messagePath);
    if (!verdict.accepted) console.error(`ways: ${verdict.reason}`);
    return verdict.accepted ? 0 : 1;
  }

  if (command === "review") {
    const [action, path] = args;
    if (action === "submit" && path) {
      const result = await submitReview(cwd, path);
      console.log(`Review recorded: ${result.verdict}`);
      return 0;
    }
    if (action === "digest") {
      console.log(await reviewDigest(cwd));
      return 0;
    }
    throw new Error("Usage: ways review submit <review.json> | digest");
  }

  if (command === "approve") {
    const record = await approveInteractively(cwd);
    console.log(`Approved ${record.phase} of ${record.workId} as ${record.approvedBy}.`);
    return 0;
  }

  if (command === "task") {
    const [action, id] = args;
    if (action === "add" && id) {
      const title = args.find((arg) => arg.startsWith("--title="))?.slice(8) ?? "";
      const dependencies = args.find((arg) => arg.startsWith("--depends="))?.slice(10).split(",").filter(Boolean) ?? [];
      console.log(JSON.stringify(await addTask(cwd, id, title, dependencies), null, 2));
      return 0;
    }
    if (action === "prepare" && id) {
      console.log(JSON.stringify(await prepareTask(cwd, id), null, 2));
      return 0;
    }
    if (action === "integrate" && id) {
      const commits = args.find((arg) => arg.startsWith("--commits="))?.slice(10).split(",").filter(Boolean) ?? [];
      console.log(JSON.stringify(await integrateTask(cwd, id, commits), null, 2));
      return 0;
    }
    throw new Error("Usage: ways task add <id> --title=<text> [--depends=a,b] | prepare <id> | integrate <id> --commits=a,b");
  }

  if (command === "outcome") {
    const [action, id] = args;
    const usage = "Usage: ways outcome open <id> --goal=<text> --criterion=<ID>:<text>... | evaluate | remediate --reason=<text> | close | cancel";
    if (action === "open" && id) {
      const criteria = options(args, "--criterion").map(parseCriterion);
      await openOutcome(cwd, id, requiredOption(args, "--goal"), criteria);
      console.log(`Outcome ${id} opened with ${criteria.length} acceptance criteria; execute through tasks, then run ways outcome evaluate.`);
      return 0;
    }
    if (action === "evaluate") {
      const { commit, evaluation } = await evaluateOutcome(cwd);
      console.log(`Evaluation passed on ${evaluation.inputCommit.slice(0, 12)}; execution certified: ${commit}. Obtain an independent review of \`ways review digest\`.`);
      return 0;
    }
    if (action === "remediate") {
      console.log(`Remediation attempt opened: ${await remediateOutcome(cwd, requiredOption(args, "--reason"))}. Fix it through new tasks, then run ways outcome evaluate.`);
      return 0;
    }
    if (action === "close") {
      console.log(`Outcome closed: ${await closeOutcome(cwd)}`);
      return 0;
    }
    if (action === "cancel") {
      console.log(`Outcome cancelled: ${await cancelOutcome(cwd)}`);
      return 0;
    }
    throw new Error(usage);
  }

  if (command === "sdd") {
    const [action, id] = args;
    if (action === "start" && id) {
      const profile = args.includes("--supervised") ? "supervised" : "autonomous";
      const execution = args.includes("--delegated") ? "delegated" : "inline";
      const state = await startSdd(cwd, id, profile, execution);
      console.log(`SDD started at ${state.phase} (${profile}, ${execution}).`);
      return 0;
    }
    if (action === "advance") {
      console.log(`SDD gate committed: ${await advanceSdd(cwd)}`);
      return 0;
    }
    if (action === "downgrade" && (id === "quick" || id === "plan")) {
      console.log(`SDD downgraded: ${await downgradeSdd(cwd, id)}`);
      return 0;
    }
    if (action === "validate" && id === undefined) {
      const failure = await recordValidationFailure(cwd);
      if (!failure) {
        console.log("SDD validation passed.");
        return 0;
      }
      console.error(`SDD validation failed and was recorded: ${failure.digest}`);
      return 1;
    }
    if (action === "remediate") {
      if (id !== "implement" && id !== "decompose" && id !== "plan" && id !== "specify") {
        throw new Error("Usage: ways sdd remediate <implement|decompose|plan|specify> --reason=<text>");
      }
      const reason = args.find((arg) => arg.startsWith("--reason="))?.slice(9);
      if (!reason?.trim()) throw new Error("Usage: ways sdd remediate <implement|decompose|plan|specify> --reason=<text>");
      const commit = await remediateSdd(cwd, id, reason);
      const state = await loadState(cwd);
      console.log(`SDD remediation opened: ${commit} (attempt ${state?.attempt ?? 0}, ${state?.remediation?.source ?? "unknown"} -> ${id}).`);
      return 0;
    }
    throw new Error("Usage: ways sdd start <id> [--supervised] [--delegated] | advance | validate | remediate <implement|decompose|plan|specify> --reason=<text> | downgrade <quick|plan>");
  }

  if (command === "adapter") {
    const [action, provider] = args;
    if (action === "list") {
      for (const adapter of PROVIDERS) console.log(adapter.id);
      return 0;
    }
    if (action === "install" && provider) {
      const result = await installAdapter(cwd, provider, args.includes("--force"));
      console.log(`Adapter ${result.provider} installed: ${result.files.length} files${result.merged.length ? `, merged ${result.merged.join(", ")}` : ""}.`);
      for (const note of result.notes) console.log(`- ${note}`);
      return 0;
    }
    throw new Error("Usage: ways adapter list | install <provider> [--force]");
  }

  if (command === "evals") {
    const [action] = args;
    if (action === "compare") {
      const inputs = options(args, "--input");
      if (inputs.length === 0) throw new Error("Usage: ways evals compare --input=<result.json>... [--output=<report.json>] [--markdown=<report.md>]");
      const report = await compareResultFiles(inputs.map((input) => userPath(cwd, input)), (path) => relative(cwd, path) || path);
      const output = stableJson(report);
      const outputPath = option(args, "--output");
      const markdownPath = option(args, "--markdown");
      if (outputPath) await writeAtomic(userPath(cwd, outputPath), output);
      if (markdownPath) await writeAtomic(userPath(cwd, markdownPath), renderComparisonMarkdown(report));
      process.stdout.write(output);
      return report.runs.some((entry) => entry.status === "comparable") ? 0 : 1;
    }
    if (action !== "run") throw new Error("Usage: ways evals run [--adapter=fake|command] [--command=<executable>] | compare --input=<result.json>...");
    const adapterName = option(args, "--adapter") ?? "fake";
    const adapter = adapterName === "fake"
      ? fakeAdapter
      : adapterName === "command"
        ? commandAdapter(requiredOption(args, "--command"), options(args, "--arg"))
        : (() => { throw new Error(`Unknown eval adapter: ${adapterName}`); })();
    const maxMilliseconds = Number(option(args, "--timeout-ms") ?? "30000");
    const maxOutputBytes = Number(option(args, "--max-output-bytes") ?? "1048576");
    const seed = Number(option(args, "--seed") ?? "0");
    const corpusPath = option(args, "--corpus");
    const harness = option(args, "--harness") ?? "checks-only";
    if (!HARNESS_LABELS.includes(harness as HarnessLabel)) throw new Error(`--harness must be one of ${HARNESS_LABELS.join(", ")}`);
    if (!Number.isSafeInteger(maxMilliseconds) || maxMilliseconds <= 0) throw new Error("--timeout-ms must be a positive integer");
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error("--max-output-bytes must be a positive integer");
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");
    const result = await runEvals({
      ...(corpusPath ? { corpusPath } : {}),
      adapter,
      configuration: {
        adapter: { id: adapter.id, argv: adapter.argv },
        harness: harness as HarnessLabel,
        model: option(args, "--model") ?? "unspecified",
        startingRevision: option(args, "--revision") ?? "corpus-v2",
        budgets: { maxMilliseconds, maxOutputBytes },
        seed,
      },
    });
    const output = stableJson(result);
    const outputPath = option(args, "--output");
    if (outputPath) await writeAtomic(userPath(cwd, outputPath), output);
    process.stdout.write(output);
    return result.tasks.every((task) => task.success) ? 0 : 1;
  }

  if (command === "check") {
    if (args.includes("--history")) {
      const since = args.find((arg) => arg.startsWith("--since="))?.slice(8);
      const to = args.find((arg) => arg.startsWith("--to="))?.slice(5);
      const issues = await checkHistory(cwd, {
        ...(since ? { since } : {}),
        ...(to ? { to } : {}),
      });
      for (const issue of issues) console.error(`${issue.code}: ${issue.path}: ${issue.message}`);
      if (issues.length > 0) return 1;
      console.log("History checks passed.");
      return 0;
    }
    const result = await runChecks(cwd, args.includes("--integrity-only"), undefined, { services: args.includes("--with-services") });
    for (const issue of result.issues) console.error(`${issue.code}: ${issue.path}: ${issue.message}`);
    if (result.checks) console.log(JSON.stringify({ checks: result.checks, ...(result.environment ? { environment: result.environment } : {}) }));
    if (result.issues.length > 0 || (result.testExitCode !== undefined && result.testExitCode !== 0)) return 1;
    console.log("Checks passed.");
    return 0;
  }

  if (command === "plan") {
    const [action, id] = args;
    if (action === "start" && id) {
      const state = await startPlan(cwd, id);
      console.log(`Plan started: ${state.planPath}`);
      return 0;
    }
    if (action === "propose") {
      console.log(`Plan committed: ${await proposePlan(cwd)}`);
      return 0;
    }
    if (action === "promote") {
      const state = await promotePlan(cwd, args.includes("--supervised") ? "supervised" : "autonomous", args.includes("--delegated") ? "delegated" : "inline");
      console.log(`Plan promoted to SDD at ${state.phase}.`);
      return 0;
    }
    if (action === "finish") {
      const message = args.find((arg) => arg.startsWith("--message="))?.slice(10) ?? "";
      console.log(`Plan completed: ${await finishPlan(cwd, message)}`);
      return 0;
    }
    if (action === "abandon") {
      console.log(`Plan abandoned: ${await abandonPlan(cwd)}`);
      return 0;
    }
    throw new Error("Usage: ways plan start <id> | propose | promote [--supervised] [--delegated] | finish --message=<subject> | abandon");
  }

  if (command === "quick") {
    const [action, id] = args;
    if (action === "start" && id) {
      await startQuick(cwd, id);
      console.log(`Quick work started: ${id}`);
      return 0;
    }
    if (action === "finish") {
      const message = args.find((arg) => arg.startsWith("--message="))?.slice(10) ?? "";
      const commit = await finishQuick(cwd, message);
      console.log(`Quick work committed: ${commit}`);
      return 0;
    }
    if (action === "cancel") {
      await cancelQuick(cwd);
      console.log("Quick work cancelled; project changes were preserved.");
      return 0;
    }
    throw new Error("Usage: ways quick start <id> | finish --message=<subject> | cancel");
  }

  if (command === "memory") {
    const [action, subaction, positional] = args;
    if (action === "index") {
      const indexes = await writeIndexes(cwd);
      console.log(`Indexed ${indexes.catalog.documents.length} concepts.`);
      return 0;
    }
    if (action === "check") {
      const result = await inspectOkf(cwd);
      for (const issue of result.issues) console.error(`${issue.code}: ${issue.path}: ${issue.message}`);
      return result.issues.length === 0 ? 0 : 1;
    }
    if (action === "discovery") {
      if (subaction === "request") {
        const request = await requestDiscovery(cwd, args.includes("--rediscover"));
        console.log(JSON.stringify(request, null, 2));
        return 0;
      }
      if (subaction === "digest") {
        console.log(await discoveryReviewDigest(cwd));
        return 0;
      }
      if (subaction === "complete" && positional) {
        console.log(JSON.stringify(await completeDiscovery(cwd, userPath(cwd, positional)), null, 2));
        return 0;
      }
      throw new Error("Usage: ways memory discovery request [--rediscover] | digest | complete <review.json>");
    }
    if (action === "commit") {
      const implementation = requiredOption(args, "--implementation");
      if (subaction === "digest") {
        console.log(await memoryCommitReviewDigest(cwd, implementation));
        return 0;
      }
      if (subaction === "create") {
        const review = userPath(cwd, requiredOption(args, "--review"));
        const message = requiredOption(args, "--message");
        console.log(`Memory committed: ${await commitMemory(cwd, implementation, review, message)}`);
        return 0;
      }
      throw new Error("Usage: ways memory commit digest --implementation=<from>..<to> | create --implementation=<from>..<to> --review=<review.json> --message=<subject>");
    }
    if (action === "reconcile") {
      const config = effectiveMemoryConfig(await loadConfig(cwd));
      if (subaction === "inspect" && positional) {
        const result = await inspectReconciliationCandidate(cwd, config, await readJson<ReconciliationRequest>(cwd, positional));
        const output = option(args, "--output");
        if (output && result.issues.length === 0) await writeAtomic(userPath(cwd, output), stableJson(result.evidence));
        console.log(JSON.stringify(result, null, 2));
        return printIssues(result.issues);
      }
      if (subaction === "validate" && positional) {
        const evidence = await readJson<ReconciliationEvidence>(cwd, positional);
        const statePath = option(args, "--state") ?? join(cwd, MEMORY_STATE_PATH);
        const claims = JSON.parse(requiredOption(args, "--unresolved-claims")) as unknown;
        if (!Array.isArray(claims) || !claims.every((claim) => typeof claim === "string")) throw new Error("--unresolved-claims must be a JSON string array");
        const issues = await validateReconciliationEvidence(cwd, config, evidence, {
          state: await readJson<MemoryState>(cwd, statePath),
          reconcileRef: requiredOption(args, "--reconcile"),
          currentTargetRef: requiredOption(args, "--target"),
          unresolvedClaims: claims,
        });
        return printIssues(issues);
      }
      if (subaction === "publication" && positional) {
        const result = await validatePublicationMerge(cwd, config, await readJson<ReconciliationEvidence>(cwd, positional), requiredOption(args, "--publication"), requiredOption(args, "--reconcile"));
        return printIssues(result.issues);
      }
      if (subaction === "back-sync") {
        const result = await validateBackSyncMerge(cwd, config, requiredOption(args, "--publication"), requiredOption(args, "--integration-before"), requiredOption(args, "--back-sync"));
        if (result.issues.length === 0) console.log(result.status);
        return printIssues(result.issues);
      }
      throw new Error("Usage: ways memory reconcile inspect <request.json> [--output=<evidence.json>] | validate <evidence.json> --state=<state.json> --reconcile=<ref> --target=<ref> --unresolved-claims='[]' | publication <evidence.json> --publication=<ref> --reconcile=<ref> | back-sync --publication=<ref> --integration-before=<ref> --back-sync=<ref>");
    }
    throw new Error("Usage: ways memory check | index | discovery ... | commit ... | reconcile ...");
  }

  if (command === "query") {
    const query = args.join(" ").trim();
    if (!query) throw new Error("Usage: ways query <terms>");
    const result = await queryKnowledgeResult(cwd, query);
    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    for (const hit of result.hits) {
      const labels = hit.labels.length > 0 ? ` [${hit.labels.join(", ")}]` : "";
      console.log(`${hit.score}\t${hit.path}${labels}\t${hit.preview}`);
    }
    return 0;
  }

  if (command === "bootstrap") {
    const force = args.includes("--force");
    const testOption = args.find((arg) => arg.startsWith("--test-command="));
    const testCommand = testOption ? JSON.parse(testOption.slice("--test-command=".length)) as unknown : ["npm", "test"];
    if (!Array.isArray(testCommand) || !testCommand.every((part) => typeof part === "string")) {
      throw new Error("--test-command must be a JSON string array");
    }
    const commandsArg = args.find((arg) => arg.startsWith("--commands="));
    const commands = commandsArg === undefined ? undefined : JSON.parse(commandsArg.slice("--commands=".length)) as unknown;
    const relevantPaths = options(args, "--relevant-path");
    const excludedPaths = options(args, "--exclude-path");
    const integrationBranch = option(args, "--integration-branch");
    await bootstrap({
      cwd,
      testCommand,
      ...(commandsArg === undefined ? {} : { commands: commands as NamedChecksConfig }),
      force,
      adapters: !args.includes("--no-adapters"),
      memory: {
        releaseBranch: option(args, "--release-branch") ?? "main",
        ...(integrationBranch ? { integrationBranch } : {}),
        reconciliationBranchPattern: option(args, "--reconciliation-branch-pattern") ?? "reconcile/*",
        ...(relevantPaths.length ? { relevantPaths } : {}),
        ...(excludedPaths.length ? { excludedPaths } : {}),
      },
    });
    console.log("Harness installed; complete the required discovery review with `ways memory discovery digest` and `ways memory discovery complete <review.json>`. ");
    return 0;
  }

  console.error(`Unknown command: ${command}`);
  return 1;
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
