import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkHistory } from "../src/integrity/history.js";
import { committedRecord } from "../src/work/record.js";
import { approvalPayloadOf, approve, done, startChange, type Terminal } from "../src/work/work.js";
import { commitFile, installed } from "./helpers.js";

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

describe("signed approvals", () => {
  it("records an approval signed with a key from the base's allowed_signers", async () => {
    const repo = await signedProject("required");
    await waitingForHuman(repo);
    const result = await approve(repo.cwd, human("edit-test"), { key: repo.alex.key });
    expect(result).toMatchObject({ status: "closed", signedBy: "alex@example.test" });
    const record = await committedRecord(repo.git, "edit-test");
    expect(record?.approval).toMatchObject({ by: "alex@example.test", via: "ssh-signature", signature: { namespace: "ways-approval", principal: "alex@example.test", signature: expect.stringMatching(/^-----BEGIN SSH SIGNATURE-----/) } });
    expect(await checkHistory(repo.cwd)).toEqual([]);
  });

  it("refuses an unsigned approval when the policy requires a signature", async () => {
    const repo = await signedProject("required");
    await waitingForHuman(repo);
    await expect(approve(repo.cwd, human("edit-test"))).rejects.toThrow(/requires SSH-signed approvals[\s\S]*--key/);
    expect((await committedRecord(repo.git, "edit-test"))?.approval).toBeUndefined();
  });

  it("refuses a signature by a key that is not in the base's allowed_signers, even one the change adds", async () => {
    const repo = await signedProject("required");
    const agent = await sshKey("agent");
    await startChange(repo.cwd, "edit-test");
    // The change itself adds the agent's key and edits the test: the base's list still decides.
    await writeFile(join(repo.cwd, ".ways/allowed_signers"), `alex@example.test namespaces="ways-approval" ${repo.alex.pub}\nagent@example.test namespaces="ways-approval" ${agent.pub}\n`);
    await writeFile(join(repo.cwd, "tests/existing.test.js"), "// changed\n");
    await repo.git.run(["add", "-A"]);
    await repo.git.run(["commit", "-q", "-m", "test: change the test and trust me"]);
    expect((await done(repo.cwd)).evidence.verifierChanges).toEqual([".ways/allowed_signers", "tests/existing.test.js"]);
    await expect(approve(repo.cwd, human("edit-test"), { key: agent.key })).rejects.toThrow(/not by any key in \.ways\/allowed_signers of the base/);
  });

  it("accepts a signature made elsewhere over the payload, without a terminal, and refuses one over another payload", async () => {
    const repo = await signedProject("required");
    await waitingForHuman(repo);
    const payload = await approvalPayloadOf(repo.cwd);
    expect(payload).toMatch(/^ways-approval v1\nwork: edit-test\ninput: [0-9a-f]{40}\ndigest: [0-9a-f]{64}\n$/);
    const sign = (text: string): string => execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-n", "ways-approval", "-f", repo.alex.key], { input: text, encoding: "utf8" });
    await expect(approve(repo.cwd, human("", false), { signature: sign(payload.replace(/digest: .*/, `digest: ${"0".repeat(64)}`)) })).rejects.toThrow(/does not verify for this approval/);
    const result = await approve(repo.cwd, human("", false), { signature: sign(payload) });
    expect(result).toMatchObject({ status: "closed", signedBy: "alex@example.test" });
  });

  it("signs with Git's SSH signing key when the base has allowed_signers, and falls back to the terminal when it has none", async () => {
    const repo = await signedProject("optional");
    await repo.git.run(["config", "gpg.format", "ssh"]);
    await repo.git.run(["config", "user.signingkey", repo.alex.key]);
    await waitingForHuman(repo);
    expect((await approve(repo.cwd, human("edit-test"))).signedBy).toBe("alex@example.test");

    const plain = await installed({ testCommand: ["node", "-e", "process.exit(0)"] });
    await plain.git.run(["config", "gpg.format", "ssh"]);
    await plain.git.run(["config", "user.signingkey", repo.alex.key]);
    await mkdir(join(plain.cwd, "tests"), { recursive: true });
    await writeFile(join(plain.cwd, "tests/existing.test.js"), "// existing\n");
    await plain.git.run(["add", "-A"]);
    await plain.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: tests"]);
    await waitingForHuman(plain);
    const result = await approve(plain.cwd, human("edit-test"));
    expect(result.signedBy).toBeUndefined();
    expect((await committedRecord(plain.git, "edit-test"))?.approval?.via).toBe("terminal");
  });
});
