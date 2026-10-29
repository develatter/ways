import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORK_DIR, workRecordPath } from "../domain/constants.js";
import type { WorkRecord } from "../domain/types.js";
import { validateWorkRecord, validationDetails } from "../domain/validation.js";
import { stableJson, writeAtomic } from "../fs/files.js";
import type { GitRepository } from "../git/git.js";
import { isOpen } from "./policy.js";

export { approvalDigest, approvalReasons, isOpen, pending, reviewBlockers, reviewNotes, reviewRequired, type Pending } from "./policy.js";

export async function committedRecord(git: GitRepository, id: string, ref = "HEAD"): Promise<WorkRecord | undefined> {
  let content: string;
  try {
    content = await git.run(["show", `${ref}:${workRecordPath(id)}`]);
  } catch {
    return undefined;
  }
  const value: unknown = JSON.parse(content);
  if (!validateWorkRecord(value)) throw new Error(`${workRecordPath(id)} at ${ref.slice(0, 12)} is invalid: ${validationDetails("work", value).errors.join("; ")}`);
  return value;
}

export async function writeRecord(cwd: string, record: WorkRecord): Promise<string> {
  if (!validateWorkRecord(record)) throw new Error(`Refusing to write an invalid work record: ${validationDetails("work", record).errors.join("; ")}`);
  const path = workRecordPath(record.id);
  await writeAtomic(join(cwd, path), stableJson(record));
  return path;
}

export async function workingRecordText(cwd: string, id: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, workRecordPath(id)), "utf8");
  } catch {
    return undefined;
  }
}

/** Records in `ref` that are neither closed nor cancelled. */
export async function openRecords(git: GitRepository, ref = "HEAD"): Promise<WorkRecord[]> {
  let names: string[];
  try {
    names = (await git.run(["ls-tree", "--name-only", `${ref}:${WORK_DIR}`])).split("\n").filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const records: WorkRecord[] = [];
  for (const name of names) {
    const record = await committedRecord(git, name.slice(0, -5), ref).catch(() => undefined);
    if (record && isOpen(record)) records.push(record);
  }
  return records;
}

/** The commit that added the record, which for an outcome is its opening. */
export async function recordIntroduction(git: GitRepository, id: string, ref = "HEAD"): Promise<string | undefined> {
  const hashes = (await git.run(["log", "--format=%H", "--diff-filter=A", ref, "--", workRecordPath(id)])).split("\n").filter(Boolean);
  return hashes[0];
}
