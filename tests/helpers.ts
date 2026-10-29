import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { GitRepository } from "../src/git/git.js";
import { done, startChange, type Terminal } from "../src/work/work.js";

/** A repository with one commit and a local identity; hooks off until ways installs them. */
export async function repository(prefix = "ways-test-"): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const git = new GitRepository(cwd);
  await git.run(["init", "-q", "-b", "main"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await git.run(["config", "commit.gpgSign", "false"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  return { cwd, git };
}

/**
 * A repository with ways installed and committed. The commit hooks run the
 * built CLI through WAYS_CLI (set by vitest.config.ts), so `npm run build`
 * must have run.
 */
export async function installed(options: { testCommand?: string[]; agents?: string[]; prefix?: string } = {}): Promise<{ cwd: string; git: GitRepository }> {
  const repo = await repository(options.prefix);
  await bootstrap({ cwd: repo.cwd, testCommand: options.testCommand ?? ["node", "-e", "process.exit(0)"], agents: options.agents ?? [] });
  await repo.git.run(["add", "-A"]);
  await repo.git.run(["commit", "-q", "-m", "chore: install ways"]);
  return repo;
}

export async function commitFile(git: GitRepository, cwd: string, path: string, content: string, message: string): Promise<string> {
  await writeFile(join(cwd, path), content);
  await git.run(["add", "--", path]);
  await git.run(["commit", "-q", "-m", message]);
  return git.head();
}

export async function sshKey(name: string): Promise<{ key: string; pub: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ways-key-"));
  const key = join(dir, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key]);
  return { key, pub: (await readFile(`${key}.pub`, "utf8")).trim() };
}

export function human(answer: string, interactive = true): Terminal & { lines: string[] } {
  const lines: string[] = [];
  return { interactive, ask: async () => answer, say: (line) => lines.push(line), lines };
}

/** A repository whose base commits the human's key and, optionally, requires signed approvals; one existing test. */
export async function signedProject(signature: "required" | "optional"): Promise<Awaited<ReturnType<typeof installed>> & { alex: { key: string; pub: string } }> {
  const repo = await installed({ testCommand: ["node", "-e", "process.exit(0)"] });
  const alex = await sshKey("alex");
  const path = join(repo.cwd, ".ways/config.json");
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")) as object, approvals: { signature } }, null, 2));
  await writeFile(join(repo.cwd, ".ways/allowed_signers"), `alex@example.test namespaces="ways-approval" ${alex.pub}\n`);
  await mkdir(join(repo.cwd, "tests"), { recursive: true });
  await writeFile(join(repo.cwd, "tests/existing.test.js"), "// existing\n");
  await repo.git.run(["add", "-A"]);
  await repo.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: signed approvals"]);
  return { ...repo, alex };
}

/** A change that edits an existing test, so it waits for the human. */
export async function waitingForHuman(repo: { cwd: string; git: Awaited<ReturnType<typeof installed>>["git"] }): Promise<void> {
  await startChange(repo.cwd, "edit-test");
  await commitFile(repo.git, repo.cwd, "tests/existing.test.js", "// changed\n", "test: change the test");
  const result = await done(repo.cwd);
  expect(result.status).toBe("verifying");
  expect(result.pending.approval).toMatch(/existing tests[\s\S]*SSH-signed|existing tests/);
}
