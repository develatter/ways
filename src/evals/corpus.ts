import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { TASK_KINDS, type EvalCheck, type EvalCorpus, type EvalFile, type EvalResume, type EvalTask } from "./types.js";

export function defaultCorpusPath(): string {
  return fileURLToPath(new URL("../../assets/evals/corpus.json", import.meta.url));
}

function isFile(value: unknown): value is EvalFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as EvalFile;
  return typeof file.path === "string" && typeof file.content === "string";
}

function isCheck(value: unknown): value is EvalCheck {
  if (typeof value !== "object" || value === null) return false;
  const check = value as EvalCheck;
  return typeof check.id === "string" && Array.isArray(check.command) && check.command.length > 0
    && check.command.every((part) => typeof part === "string") && Number.isInteger(check.expectedExitCode)
    && (check.expectedStdout === undefined || typeof check.expectedStdout === "string")
    && (check.expectedStderr === undefined || typeof check.expectedStderr === "string");
}

function isResume(value: unknown): value is EvalResume {
  if (typeof value !== "object" || value === null || typeof (value as EvalResume).prompt !== "string") return false;
  const patch = (value as EvalResume).fakePatch;
  return patch === undefined || Array.isArray(patch) && patch.every(isFile);
}

function isTask(value: unknown): value is EvalTask {
  if (typeof value !== "object" || value === null) return false;
  const task = value as EvalTask;
  return typeof task.id === "string" && typeof task.description === "string" && typeof task.prompt === "string"
    && Array.isArray(task.setup) && task.setup.every(isFile)
    && Array.isArray(task.success) && task.success.length > 0 && task.success.every(isCheck)
    && Array.isArray(task.regressions) && task.regressions.length > 0 && task.regressions.every(isCheck)
    && (task.kind === undefined || (TASK_KINDS as readonly unknown[]).includes(task.kind))
    && (task.environmentChecks === undefined || Array.isArray(task.environmentChecks) && task.environmentChecks.every(isCheck))
    && (task.fakePatch === undefined || Array.isArray(task.fakePatch) && task.fakePatch.every(isFile))
    && (task.freshSessionResume === undefined || isResume(task.freshSessionResume));
}

export function validateCorpus(value: unknown): value is EvalCorpus {
  if (typeof value !== "object" || value === null) return false;
  const corpus = value as EvalCorpus;
  return corpus.schemaVersion === 1 && typeof corpus.id === "string" && typeof corpus.revision === "string"
    && Array.isArray(corpus.tasks) && corpus.tasks.length > 0 && corpus.tasks.every(isTask)
    && new Set(corpus.tasks.map((task) => task.id)).size === corpus.tasks.length;
}

export async function loadCorpus(path = defaultCorpusPath()): Promise<EvalCorpus> {
  const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (!validateCorpus(value)) throw new Error(`Invalid eval corpus: ${path}`);
  return value;
}
