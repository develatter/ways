import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { GitRepository } from "../src/git/git.js";

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
