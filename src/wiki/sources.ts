import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitRepository } from "../git/git.js";
import { matchesGlob, normalizeRepoPath } from "../memory/glob.js";

/**
 * What a wiki page documents, and the fingerprint of it when the page was
 * written. A file source hashes like `git hash-object` (the blob id), cut to
 * HASH_LENGTH; a directory source (a path ending in `/`) hashes the list of
 * files under it, so adding, removing or renaming a file makes the page stale
 * and editing one does not: cite the files themselves to follow their content.
 * Hashes are taken over the working tree, so a page can be checked before the
 * change it documents is committed.
 */
export const HASH_LENGTH = 12;

export function blobHash(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** A `sources:` entry as a repository-relative path; a trailing `/` marks a directory. */
export function normalizeSource(source: string): string {
  const directory = source.endsWith("/");
  const path = normalizeRepoPath(source.replace(/\/+$/, "") || ".");
  if (path === ".") throw new Error("a source cannot be the whole repository");
  return directory ? `${path}/` : path;
}

/** The files git knows (tracked or new and not ignored) that still exist on disk. */
export async function repositoryFiles(cwd: string): Promise<string[]> {
  const output = await new GitRepository(cwd).run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return [...new Set(output.split("\0").filter(Boolean))].sort();
}

async function fileHash(cwd: string, path: string): Promise<string | undefined> {
  try {
    return blobHash(await readFile(join(cwd, path))).slice(0, HASH_LENGTH);
  } catch {
    return undefined;
  }
}

/** Fingerprints of `sources` (normalized); undefined for a source that does not exist. */
export async function hashSources(cwd: string, sources: readonly string[], files?: readonly string[]): Promise<Map<string, string | undefined>> {
  const known = files ?? await repositoryFiles(cwd);
  const result = new Map<string, string | undefined>();
  for (const source of sources) {
    if (source.endsWith("/")) {
      const inside: string[] = [];
      for (const path of known) {
        if (!path.startsWith(source)) continue;
        if (await fileHash(cwd, path) !== undefined) inside.push(path);
      }
      result.set(source, inside.length === 0 ? undefined : createHash("sha1").update(inside.join("\n")).digest("hex").slice(0, HASH_LENGTH));
    } else {
      result.set(source, await fileHash(cwd, source));
    }
  }
  return result;
}

/** True when the recorded hash names the same content as the current one (either may be abbreviated, at least 7 characters). */
export function sameHash(recorded: string, current: string): boolean {
  const length = Math.min(recorded.length, current.length);
  return length >= 7 && recorded.slice(0, length) === current.slice(0, length);
}

/**
 * The code units a glob names (for example every directory directly under
 * `src`): with a trailing `/` the directories it matches, otherwise the files.
 * Each unit is a path, with a trailing `/` for a directory.
 */
export function unitsOf(files: readonly string[], globs: readonly string[]): string[] {
  const units = new Set<string>();
  for (const glob of globs) {
    const directory = glob.endsWith("/");
    const pattern = glob.replace(/\/+$/, "");
    const depth = pattern.split("/").length;
    for (const path of files) {
      const segments = path.split("/");
      if (directory) {
        if (segments.length <= depth) continue;
        const prefix = segments.slice(0, depth).join("/");
        if (matchesGlob(prefix, pattern)) units.add(`${prefix}/`);
      } else if (matchesGlob(path, pattern)) {
        units.add(path);
      }
    }
  }
  return [...units].sort();
}

/** A unit is documented when a page cites it, a directory around it, or (for a directory) a file inside it. */
export function unitCovered(unit: string, sources: readonly string[]): boolean {
  return sources.some((source) => {
    if (source === unit) return true;
    if (source.endsWith("/") && unit.startsWith(source)) return true;
    return unit.endsWith("/") && source.startsWith(unit);
  });
}
