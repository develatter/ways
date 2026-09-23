import { access, appendFile, mkdir, readdir, readFile, realpath, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_VERSION } from "../index.js";
import { bootstrap } from "../bootstrap/bootstrap.js";
import { sha256 } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { auditHistory, commitsAfter, manifestIntroduction } from "../integrity/history.js";
import { checkIntegrity } from "../integrity/integrity.js";
import { loadState } from "../state/store.js";
import type { EvalCheck, EvalTask, HarnessCompliance, HarnessPrompt, WaysRevision } from "./types.js";

const PACKAGE_LINK = "node_modules/@develatter/ways";
const BIN_LINK = "node_modules/.bin/ways";

export const FULL_SDD_PROMPT: HarnessPrompt = {
  initial: "Deliver this task with Ways full SDD: run `npx ways sdd start <task-id>` and certify every phase through close. Do not downgrade, bypass or edit gates, reviews or checks.",
  resume: "Resume the active Ways work (`npx ways status`) and continue it through close. Do not downgrade, bypass or edit gates, reviews or checks.",
};

export function fullSddPrompt(template: string, taskId: string, prompt: string): string {
  return `${template.replaceAll("<task-id>", taskId)}\n\n${prompt}`;
}

export function packageRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

async function files(root: string, directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return files(root, path);
    return entry.isFile() ? [path] : [];
  }));
  return nested.flat();
}

async function sourceRevision(root: string): Promise<Pick<WaysRevision, "sourceRevision" | "sourceRevisionReason">> {
  const git = new GitRepository(root);
  try {
    if (await realpath(await git.run(["rev-parse", "--show-toplevel"], undefined, true)) !== await realpath(root)) {
      return { sourceRevision: null, sourceRevisionReason: "installed package is not a Git checkout; contentDigest identifies it" };
    }
    const head = await git.run(["rev-parse", "HEAD"], undefined, true);
    const dirty = (await git.run(["status", "--porcelain", "--", "src", "assets", "package.json"], undefined, true)) !== "";
    return dirty
      ? { sourceRevision: head, sourceRevisionReason: "source has uncommitted changes; contentDigest identifies the running content" }
      : { sourceRevision: head };
  } catch {
    return { sourceRevision: null, sourceRevisionReason: "installed package is not a Git checkout; contentDigest identifies it" };
  }
}

/** Identifies the exact Ways content a run used, whether it is a checkout or an installed package. */
export async function captureWaysRevision(root = packageRoot()): Promise<WaysRevision> {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name: string; version: string };
  const paths = [...await files(root, "dist"), ...await files(root, "assets")].sort();
  const lines = await Promise.all(paths.map(async (path) => `${path}\0${sha256(await readFile(join(root, path)))}\n`));
  return {
    packageName: manifest.name,
    packageVersion: manifest.version,
    harnessVersion: HARNESS_VERSION,
    ...await sourceRevision(root),
    contentDigest: sha256(lines.join("")),
  };
}

/** A test command that runs the task's regression checks, so SDD validation exercises real checks. */
export function regressionTestCommand(checks: readonly EvalCheck[]): string[] {
  const script = [
    "const { spawnSync } = require('node:child_process');",
    `for (const check of ${JSON.stringify(checks)}) {`,
    "  const [command, ...args] = check.command;",
    "  const result = spawnSync(command, args, { encoding: 'utf8' });",
    "  const failed = result.status !== check.expectedExitCode",
    "    || (check.expectedStdout !== undefined && result.stdout !== check.expectedStdout)",
    "    || (check.expectedStderr !== undefined && result.stderr !== check.expectedStderr);",
    "  if (failed) { console.error(`regression check ${check.id} failed`); process.exit(1); }",
    "}",
  ].join("\n");
  return ["node", "-e", script];
}

/** Installs the running Ways package into a disposable repository and commits it before any session runs. */
export async function prepareFullSdd(repo: string, task: EvalTask, gitEnv: NodeJS.ProcessEnv, root = packageRoot()): Promise<{ revision: string; waysBin: string }> {
  const cli = join(root, "dist/cli.js");
  try {
    await access(cli);
  } catch {
    throw new Error(`Ways CLI is not built at ${cli}; run npm run build before full-sdd evals`);
  }
  await bootstrap({ cwd: repo, testCommand: regressionTestCommand(task.regressions) });
  await mkdir(join(repo, "node_modules/.bin"), { recursive: true });
  await mkdir(join(repo, "node_modules/@develatter"), { recursive: true });
  await symlink(root, join(repo, PACKAGE_LINK), "dir");
  await symlink(relative(join(repo, "node_modules/.bin"), join(repo, PACKAGE_LINK, "dist/cli.js")), join(repo, BIN_LINK));
  await appendFile(join(repo, ".gitignore"), "node_modules/\n", "utf8");
  const git = new GitRepository(repo);
  await git.run(["add", "."], gitEnv, true);
  await git.run(["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "eval harness: bootstrap ways"], gitEnv, true);
  return { revision: await git.run(["rev-parse", "HEAD"], gitEnv, true), waysBin: join(repo, BIN_LINK) };
}

/** Grades SDD compliance from committed repository evidence, never from what the agent claims. */
export async function gradeFullSddCompliance(repo: string): Promise<HarnessCompliance> {
  const git = new GitRepository(repo);
  const issues: { code: string; path: string; message: string }[] = [];
  let activeWork: string | null = null;
  try {
    activeWork = (await loadState(repo))?.id ?? null;
  } catch (error) {
    issues.push({ code: "eval-unreadable-state", path: ".ways/state", message: error instanceof Error ? error.message : String(error) });
  }
  const anchor = await manifestIntroduction(git);
  const commits = anchor ? await commitsAfter(git, anchor) : [];
  const audit = await auditHistory(git, commits, activeWork ?? undefined);
  issues.push(...audit.issues, ...await checkIntegrity(repo));
  const uncommitted = (await git.run(["status", "--porcelain"], undefined, true)).split("\n").filter(Boolean);
  if (uncommitted.length > 0) issues.push({ code: "eval-uncommitted-changes", path: ".", message: `Run ended with ${uncommitted.length} uncommitted path(s)` });
  if (activeWork !== null) issues.push({ code: "eval-active-work", path: ".ways/state", message: `Work ${activeWork} is still active` });

  const sddWorks = new Set(commits.filter((commit) => commit.trailers.work && commit.trailers.phase).map((commit) => commit.trailers.work));
  const closed = new Set(audit.checkpoints.filter((checkpoint) => checkpoint.kind === "certification" && checkpoint.phase === "close").map((checkpoint) => checkpoint.work));
  const compliant = issues.length === 0;
  return {
    applicable: true,
    compliant,
    fullSddCompleted: compliant && closed.size > 0,
    sddWorksStarted: sddWorks.size,
    sddWorksClosed: closed.size,
    downgrades: commits.filter((commit) => commit.trailers.state?.startsWith("downgraded")).length,
    remediationAttempts: audit.checkpoints.filter((checkpoint) => checkpoint.kind === "remediation").length,
    validationFailures: commits.filter((commit) => commit.trailers.state === "validation-failed").length,
    activeWork,
    issues,
  };
}
