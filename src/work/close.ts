import { STATE_PATH } from "../domain/constants.js";
import { GitRepository, type CommitTrailers } from "../git/git.js";
import { writeStatus } from "../state/status.js";
import { loadState, removeState, saveState } from "../state/store.js";

async function stateIsTracked(git: GitRepository): Promise<boolean> {
  try {
    await git.run(["cat-file", "-e", `HEAD:${STATE_PATH}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes a work with one traced commit. When HEAD tracks the state file, the
 * commit records its deletion and the hook validates against HEAD. When the
 * state only ever lived on disk (quick, unproposed plan), the state stays in
 * place until the commit is accepted so the hook can trace it, and is removed
 * afterwards without entering the commit.
 */
export async function closeWork(cwd: string, subject: string, trailers: CommitTrailers): Promise<string> {
  const git = new GitRepository(cwd);
  const state = await loadState(cwd);
  try {
    await writeStatus(cwd, undefined);
    if (await stateIsTracked(git)) {
      await removeState(cwd);
      return await git.commit(await git.changedPaths(), subject, trailers);
    }
    const paths = (await git.changedPaths()).filter((path) => path !== STATE_PATH);
    const hash = await git.commit(paths, subject, trailers);
    await removeState(cwd);
    return hash;
  } catch (error) {
    // A refused close leaves the work active: restore its state and status mirror.
    if (state) {
      await git.run(["reset", "-q", "--", STATE_PATH]).catch(() => undefined);
      await saveState(cwd, state);
    }
    throw error;
  }
}
