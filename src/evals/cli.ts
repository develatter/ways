import { stableJson, writeAtomic } from "../fs/files.js";
import { commandAdapter, fakeAdapter } from "./adapters.js";
import { compareResultFiles, renderComparisonMarkdown } from "./compare.js";
import { runEvals } from "./runner.js";
import { DEFAULT_OUTCOME_POLICY, HARNESS_LABELS, type HarnessLabel, type OutcomeEvalPolicy } from "./types.js";

interface Helpers {
  option(args: readonly string[], name: string): string | undefined;
  options(args: readonly string[], name: string): string[];
  requiredOption(args: readonly string[], name: string): string;
  userPath(cwd: string, path: string): string;
  relative(from: string, to: string): string;
}

/** `ways evals run|compare`, loaded only when asked for. */
export async function runEvalsCommand(args: readonly string[], cwd: string, { option, options, requiredOption, userPath, relative }: Helpers): Promise<number> {
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
  if (action !== "run") throw new Error("Usage: ways evals run [--adapter=fake|command] [--command=<executable>] [--harness=<label>] [--review=required|none --approval=required|none with --harness=outcome] | compare --input=<result.json>...");
  const adapterName = option(args, "--adapter") ?? "fake";
  const adapter = adapterName === "fake"
    ? fakeAdapter
    : adapterName === "command"
      ? commandAdapter(requiredOption(args, "--command"), options(args, "--arg"))
      : (() => { throw new Error(`Unknown eval adapter: ${adapterName}; use fake or command`); })();
  const maxMilliseconds = Number(option(args, "--timeout-ms") ?? "30000");
  const maxOutputBytes = Number(option(args, "--max-output-bytes") ?? "1048576");
  const seed = Number(option(args, "--seed") ?? "0");
  const corpusPath = option(args, "--corpus");
  const harness = option(args, "--harness") ?? "checks-only";
  if (!HARNESS_LABELS.includes(harness as HarnessLabel)) throw new Error(`--harness must be one of ${HARNESS_LABELS.join(", ")}`);
  if (!Number.isSafeInteger(maxMilliseconds) || maxMilliseconds <= 0) throw new Error("--timeout-ms must be a positive integer");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error("--max-output-bytes must be a positive integer");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");
  const policyFlags = { review: option(args, "--review"), approval: option(args, "--approval") };
  const policy = Object.fromEntries(Object.entries(policyFlags).filter(([, value]) => value !== undefined)) as Partial<OutcomeEvalPolicy>;
  if (harness !== "outcome" && Object.keys(policy).length > 0) throw new Error("--review and --approval apply only to --harness=outcome");
  const result = await runEvals({
    ...(corpusPath ? { corpusPath } : {}),
    adapter,
    configuration: {
      adapter: { id: adapter.id, argv: adapter.argv },
      harness: harness as HarnessLabel,
      model: option(args, "--model") ?? "unspecified",
      startingRevision: option(args, "--revision") ?? "corpus-v3",
      budgets: { maxMilliseconds, maxOutputBytes },
      seed,
      ...(harness === "outcome" ? { outcomePolicy: { ...DEFAULT_OUTCOME_POLICY, ...policy } } : {}),
    },
  });
  const output = stableJson(result);
  const outputPath = option(args, "--output");
  if (outputPath) await writeAtomic(userPath(cwd, outputPath), output);
  process.stdout.write(output);
  return result.tasks.every((task) => task.success) ? 0 : 1;
}
