import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workRecordPath } from "../src/domain/constants.js";
import type { WorkRecord } from "../src/domain/types.js";
import { checkHistory } from "../src/integrity/history.js";
import { readActive, readRuns } from "../src/runtime/runtime.js";
import { parseCommandLine } from "../src/work/argv.js";
import { committedRecord } from "../src/work/record.js";
import { buildStatus } from "../src/work/status.js";
import { approve, buildCriteria, cancel, done, openOutcome, resolveActive, startChange, submitReview, type Terminal } from "../src/work/work.js";
import { commitFile, installed } from "./helpers.js";

/** Tests pass while `status.txt` says ok. */
const TOGGLED_TESTS = ["node", "-e", "process.exit(require('fs').readFileSync('status.txt','utf8').trim()==='ok'?0:1)"];

async function project(): Promise<Awaited<ReturnType<typeof installed>>> {
  const repo = await installed({ testCommand: TOGGLED_TESTS });
  await mkdir(join(repo.cwd, "tests"), { recursive: true });
  await writeFile(join(repo.cwd, "tests/existing.test.js"), "// existing test\n");
  await writeFile(join(repo.cwd, "status.txt"), "ok\n");
  await repo.git.run(["add", "-A"]);
  await repo.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: project files"]);
  return repo;
}

function terminal(answer: string): Terminal & { lines: string[] } {
  const lines: string[] = [];
  return { interactive: true, ask: async () => answer, say: (line) => lines.push(line), lines };
}

async function writeReview(cwd: string, review: Record<string, unknown>): Promise<string> {
  const path = join(cwd, "..", `review-${Date.now()}-${Math.random()}.json`);
  await writeFile(path, JSON.stringify(review));
  return path;
}

describe("a small change", () => {
  it("is started by its first commit in observe mode and closed by one `ways done`, without a commit of its own", async () => {
    const { cwd, git } = await project();
    await git.run(["checkout", "-q", "-b", "fix/button-padding"]);
    await commitFile(git, cwd, "a.txt", "a\n", "fix: button padding");
    expect((await git.commitInfo()).trailers.work).toBe("fix-button-padding");
    expect(readActive(cwd)).toMatchObject({ id: "fix-button-padding", kind: "change", origin: "commit" });
    await commitFile(git, cwd, "b.txt", "b\n", "fix: second commit is fine too");
    expect((await git.commitInfo()).trailers.work).toBe("fix-button-padding");
    const head = await git.head();
    const result = await done(cwd);
    expect(result).toMatchObject({ status: "closed", kind: "change", commits: 2 });
    expect(await git.head()).toBe(head);
    expect(readActive(cwd)).toBeUndefined();
    expect(readRuns(cwd, "fix-button-padding")).toEqual([expect.objectContaining({ passed: true, input: head })]);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("refuses to finish with uncommitted changes unless --message commits them", async () => {
    const { cwd, git } = await project();
    await startChange(cwd, "tweak");
    await writeFile(join(cwd, "c.txt"), "c\n");
    await expect(done(cwd)).rejects.toThrow(/Uncommitted changes:\n {2}c\.txt[\s\S]*--message/);
    const result = await done(cwd, { message: "feat: add c" });
    expect(result.status).toBe("closed");
    const commit = await git.commitInfo();
    expect(commit.subject).toBe("feat: add c");
    expect(commit.trailers.work).toBe("tweak");
  });

  it("starts from `ways done --message` alone when nothing is active", async () => {
    const { cwd, git } = await project();
    await writeFile(join(cwd, "d.txt"), "d\n");
    const result = await done(cwd, { message: "docs: add d" });
    expect(result).toMatchObject({ id: "docs-add-d", status: "closed" });
    expect((await git.commitInfo()).trailers.work).toBe("docs-add-d");
  });

  it("stays active after failing checks, and closes once fixed", async () => {
    const { cwd, git } = await project();
    await startChange(cwd, "risky");
    await commitFile(git, cwd, "status.txt", "broken\n", "feat: break it");
    const failed = await done(cwd);
    expect(failed.status).toBe("failed");
    expect(failed.failures.join("\n")).toMatch(/check test: failed \(exit 1\)/);
    expect(readActive(cwd)?.id).toBe("risky");
    await commitFile(git, cwd, "status.txt", "ok\n", "fix: repair it");
    expect((await done(cwd)).status).toBe("closed");
    expect(readRuns(cwd, "risky").map((run) => run.passed)).toEqual([false, true]);
  });

  it("derives its id from the branch, never from main", async () => {
    const { cwd, git } = await project();
    await expect(startChange(cwd)).rejects.toThrow(/Give the work an id/);
    await git.run(["checkout", "-q", "-b", "feature/Dark-Mode"]);
    expect((await startChange(cwd)).id).toBe("feature-dark-mode");
    await expect(startChange(cwd, "other")).rejects.toThrow(/already active/);
  });

  it("needs a human approval when it modifies an existing test, but not when it adds one", async () => {
    const { cwd, git } = await project();
    await startChange(cwd, "add-test");
    await commitFile(git, cwd, "tests/new.test.js", "// new\n", "test: add a test");
    expect((await done(cwd)).status).toBe("closed");

    await startChange(cwd, "edit-test");
    await commitFile(git, cwd, "tests/existing.test.js", "// weakened\n", "test: relax the test");
    const result = await done(cwd);
    expect(result.status).toBe("verifying");
    expect(result.pending.approval).toMatch(/tests\/existing\.test\.js/);
    const record = await committedRecord(git, "edit-test");
    expect(record).toMatchObject({ kind: "change", evidence: { verifierChanges: ["tests/existing.test.js"] } });
    await expect(approve(cwd, { ...terminal("edit-test"), interactive: false })).rejects.toThrow(/interactive terminal/);
    await expect(approve(cwd, terminal("nope"))).rejects.toThrow(/cancelled/);
    const approved = await approve(cwd, terminal("edit-test"));
    expect(approved.status).toBe("closed");
    expect((await committedRecord(git, "edit-test"))?.approval?.reasons.join(" ")).toMatch(/existing tests/);
    expect(readActive(cwd)).toBeUndefined();
    expect(await checkHistory(cwd)).toEqual([]);
  });
});

describe("an outcome", () => {
  it("closes in one `ways done` when every criterion has a passing verifier and no review is required", async () => {
    const { cwd, git } = await project();
    const opened = await openOutcome(cwd, "greeting", { goal: "Greet users", criteria: ["AC1:greeting.txt says hi"], verify: ["AC1:grep -q hi greeting.txt"], strength: [], review: "none" });
    expect(opened.criteria).toEqual([{ id: "AC1", text: "greeting.txt says hi", verify: ["grep", "-q", "hi", "greeting.txt"], strength: "test" }]);
    const open = await git.commitInfo();
    expect(open.trailers).toEqual({ work: "greeting", state: "opened" });
    await commitFile(git, cwd, "greeting.txt", "hi\n", "feat: greet");
    const input = await git.head();
    const result = await done(cwd);
    expect(result.status).toBe("closed");
    const record = await committedRecord(git, "greeting") as WorkRecord;
    expect(record.evidence).toMatchObject({ input: { commit: input, tree: await git.treeId(input) }, passed: true, verifierChanges: [] });
    expect(record.evidence?.criteria.AC1).toMatchObject({ status: "passed", strength: "test", exitCode: 0, outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(record.closed).toBeDefined();
    expect(await git.parent("HEAD")).toBe(input);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("records failing verifiers without a commit, then lists them as earlier runs", async () => {
    const { cwd, git } = await project();
    await openOutcome(cwd, "greeting", { goal: "Greet users", criteria: ["AC1:greeting.txt says hi"], verify: ["AC1:grep -q hi greeting.txt"], strength: [], review: "none" });
    await commitFile(git, cwd, "greeting.txt", "hello\n", "feat: greet");
    const head = await git.head();
    const failed = await done(cwd);
    expect(failed.status).toBe("failed");
    expect(failed.failures.join("\n")).toMatch(/criterion AC1 \(test\): failed/);
    expect(await git.head()).toBe(head);
    await commitFile(git, cwd, "greeting.txt", "hi\n", "fix: say hi");
    await done(cwd);
    const record = await committedRecord(git, "greeting");
    expect(record?.evidence?.earlierRuns).toEqual([expect.objectContaining({ input: head, passed: false, failed: ["AC1"] })]);
  });

  it("waits for an independent review bound to the evaluated commit, then closes on submit", async () => {
    const { cwd, git } = await project();
    await openOutcome(cwd, "docs", { goal: "Document it", criteria: ["AC1:readme exists", "AC2:the wording is clear"], verify: ["AC1:test -f README.md"], strength: [] });
    await commitFile(git, cwd, "README.md", "# Docs\n", "docs: readme");
    const input = await git.head();
    const result = await done(cwd);
    expect(result.status).toBe("verifying");
    expect(result.pending.review).toBe("an independent review is required");
    expect(result.evidence.criteria.AC2).toEqual({ strength: "review-only", status: "review-only" });
    expect((await buildStatus(cwd)).next).toContain(`"commit": "${input}"`);

    // A rerun of done without changes neither re-evaluates nor commits.
    const verifying = await git.head();
    expect((await done(cwd)).status).toBe("verifying");
    expect(await git.head()).toBe(verifying);

    await expect(submitReview(cwd, await writeReview(cwd, { reviewer: "someone", commit: "0".repeat(40), verdict: "pass", findings: [] }))).rejects.toThrow(/review that commit/);
    await expect(submitReview(cwd, await writeReview(cwd, { reviewer: "Ways Test <ways@example.test>", commit: input, verdict: "pass", findings: [] }))).rejects.toThrow(/authored or committed/);
    await expect(submitReview(cwd, await writeReview(cwd, { reviewer: "x", commit: input }))).rejects.toThrow(/Invalid review/);

    // Uncommitted scratch files are not part of what closes and do not get in the way.
    await writeFile(join(cwd, "scratch.txt"), "notes\n");
    const blocked = await submitReview(cwd, await writeReview(cwd, { reviewer: "ways-reviewer", commit: input, verdict: "pass", findings: [{ id: "F1", severity: "high", summary: "unclear" }, { id: "F2", severity: "low", summary: "typo" }] }));
    expect(blocked).toMatchObject({ status: "verifying", blockers: ["F1"], notes: ["F2 (low): typo"] });
    const passed = await submitReview(cwd, await writeReview(cwd, { reviewer: "ways-reviewer", commit: input.slice(0, 12), verdict: "pass", findings: [{ id: "F1", severity: "high", summary: "unclear", disposition: "fixed" }] }));
    expect(passed.status).toBe("closed");
    expect(await committedRecord(git, "docs")).toMatchObject({ review: { reviewer: "ways-reviewer", commit: input }, closed: expect.any(Object) });
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("drops a stale review when the work changes and is evaluated again", async () => {
    const { cwd, git } = await project();
    await openOutcome(cwd, "docs", { goal: "Document it", criteria: ["AC1:readme exists"], verify: ["AC1:test -f README.md"], strength: [] });
    await commitFile(git, cwd, "README.md", "# Docs\n", "docs: readme");
    const first = (await done(cwd)).evidence.input.commit;
    await submitReview(cwd, await writeReview(cwd, { reviewer: "ways-reviewer", commit: first, verdict: "fail", findings: [{ id: "F1", severity: "critical", summary: "wrong" }] }));
    await commitFile(git, cwd, "README.md", "# Docs, fixed\n", "docs: fix readme");
    const again = await done(cwd);
    expect(again.status).toBe("verifying");
    expect(again.pending.review).toBe("an independent review is required");
    expect((await committedRecord(git, "docs"))?.review).toBeUndefined();
  });

  it("asks for the human last when opened with --approval=required", async () => {
    const { cwd, git } = await project();
    await openOutcome(cwd, "gated", { goal: "Gated", criteria: ["AC1:file exists"], verify: ["AC1:test -f gated.txt"], strength: [], approval: "required" });
    await commitFile(git, cwd, "gated.txt", "x\n", "feat: gated");
    const result = await done(cwd);
    expect(result.status).toBe("verifying");
    await expect(approve(cwd, terminal("gated"))).rejects.toThrow(/Approval comes last/);
    const input = result.evidence.input.commit;
    await submitReview(cwd, await writeReview(cwd, { reviewer: "ways-reviewer", commit: input, verdict: "pass", findings: [] }));
    const shown = terminal("gated");
    expect((await approve(cwd, shown)).status).toBe("closed");
    expect(shown.lines.join("\n")).toContain("AC1 file exists — passed");
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("is found from its record when this checkout has no runtime pointer", async () => {
    const { cwd, git } = await project();
    await openOutcome(cwd, "found", { goal: "Find it", criteria: ["AC1:exists"], verify: ["AC1:test -f found.txt"], strength: [], review: "none" });
    await writeFile(join(git.cwd, ".git", "ways", "active.json"), "{}");
    expect((await resolveActive(cwd))?.active).toMatchObject({ id: "found", kind: "outcome" });
    await commitFile(git, cwd, "found.txt", "x\n", "feat: found");
    expect((await git.commitInfo()).trailers.work).toBe("found");
  });

  it("is cancelled with a committed marker", async () => {
    const { cwd, git } = await project();
    await openOutcome(cwd, "dropped", { goal: "Drop it", criteria: ["AC1:never"], verify: [], strength: [] });
    const result = await cancel(cwd);
    expect(result.commit).toBeDefined();
    expect((await committedRecord(git, "dropped"))?.cancelled).toBeDefined();
    expect(await resolveActive(cwd)).toBeUndefined();
    await expect(openOutcome(cwd, "dropped", { goal: "Again", criteria: ["AC1:x"], verify: [], strength: [] })).rejects.toThrow(/already exists/);
  });

  it("refuses a second active work", async () => {
    const { cwd } = await project();
    await startChange(cwd, "first");
    await expect(openOutcome(cwd, "second", { goal: "g", criteria: ["AC1:x"], verify: [], strength: [] })).rejects.toThrow(/first is already active/);
  });
});

describe("criteria", () => {
  it("are one line, with a verifier and a strength each", () => {
    expect(buildCriteria({ criteria: ["AC1:a", "AC2:b"], verify: ["AC1:npm test -- -t \"refresh before expiry\""], strength: ["AC1:property"] })).toEqual([
      { id: "AC1", text: "a", verify: ["npm", "test", "--", "-t", "refresh before expiry"], strength: "property" },
      { id: "AC2", text: "b", strength: "review-only" },
    ]);
    expect(() => buildCriteria({ criteria: [], verify: [], strength: [] })).toThrow(/at least one --criterion/);
    expect(() => buildCriteria({ criteria: ["AC1:a"], verify: ["AC9:true"], strength: [] })).toThrow(/AC9, which is not a --criterion/);
    expect(() => buildCriteria({ criteria: ["AC1:a"], verify: [], strength: ["AC1:test"] })).toThrow(/has no --verify/);
    expect(() => buildCriteria({ criteria: ["AC1:a"], verify: ["AC1:true"], strength: ["AC1:review-only"] })).toThrow(/cannot be review-only/);
    expect(() => buildCriteria({ criteria: ["ac1:a"], verify: [], strength: [] })).toThrow(/AC1:<value>/);
  });

  it("verifiers never reach a shell", () => {
    expect(parseCommandLine("grep -q 'a b' \"c\\\"d\" e\\ f")).toEqual(["grep", "-q", "a b", "c\"d", "e f"]);
    expect(parseCommandLine("[\"node\",\"-e\",\"process.exit(0)\"]")).toEqual(["node", "-e", "process.exit(0)"]);
    expect(parseCommandLine("echo '$(rm -rf /)' \"a;b\"")).toEqual(["echo", "$(rm -rf /)", "a;b"]);
    for (const unsafe of ["npm test && rm -rf /", "a | b", "a; b", "echo $(id)", "a > out", "echo `id`"]) {
      expect(() => parseCommandLine(unsafe)).toThrow(/shell operator/);
    }
    expect(() => parseCommandLine("echo 'open")).toThrow(/unclosed/);
  });
});

describe("the history audit", () => {
  it("flags a record committed by hand", async () => {
    const { cwd, git } = await project();
    await openOutcome(cwd, "forged", { goal: "Forge", criteria: ["AC1:x"], verify: ["AC1:true"], strength: [], review: "none" });
    const path = join(cwd, workRecordPath("forged"));
    const record = JSON.parse(await readFile(path, "utf8")) as WorkRecord;
    record.criteria[0]!.text = "something easier";
    await writeFile(path, JSON.stringify(record, null, 2));
    await git.run(["add", "-A"]);
    await expect(git.run(["commit", "-q", "-m", "chore: easier"])).rejects.toThrow(/only ways writes/);
    await git.run(["commit", "-q", "-m", "chore: easier"], { WAYS_DISABLE: "1" });
    const codes = (await checkHistory(cwd)).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["history-record-hand-made", "history-criteria-changed"]));
  });
});
