import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { committedRecord } from "../src/work/record.js";
import { extractReview, launchReview, reviewPreset, reviewPrompt } from "../src/work/review.js";
import { done, openOutcome, startChange } from "../src/work/work.js";
import { commitFile, installed } from "./helpers.js";

/**
 * A stand-in reviewer process: saves the prompt it got on stdin next to it and
 * prints `answer` (with `<COMMIT>` replaced by the commit the prompt names).
 */
async function fakeReviewer(dir: string, answer: string): Promise<{ command: string[]; prompt: string }> {
  const script = join(dir, `reviewer-${Date.now()}-${Math.random()}.mjs`);
  const prompt = `${script}.prompt`;
  await writeFile(script, `import { writeFileSync } from "node:fs";\nlet t = "";\nprocess.stdin.on("data", (c) => t += c).on("end", () => {\n  writeFileSync(${JSON.stringify(prompt)}, t);\n  const commit = /"commit": "([0-9a-f]{40})"/.exec(t)?.[1] ?? "";\n  process.stdout.write(${JSON.stringify(answer)}.replaceAll("<COMMIT>", commit));\n});\n`);
  return { command: [process.execPath, script], prompt };
}

async function project(reviewer: string[]): Promise<Awaited<ReturnType<typeof installed>>> {
  const repo = await installed({ testCommand: ["node", "-e", "process.exit(0)"] });
  const path = join(repo.cwd, ".ways/config.json");
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")) as object, reviewer: { command: reviewer } }, null, 2));
  await mkdir(join(repo.cwd, "tests"), { recursive: true });
  await writeFile(join(repo.cwd, "tests/existing.test.js"), "// existing\n");
  await repo.git.run(["add", "-A"]);
  await repo.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: reviewer"]);
  return repo;
}

describe("ways review", () => {
  it("launches the configured reviewer with ways' own prompt and records its verdict with that provenance", async () => {
    const reviewer = await fakeReviewer(await import("node:os").then((os) => os.tmpdir()), "All criteria hold.\n```json\n{\"reviewer\": \"fake\", \"commit\": \"<COMMIT>\", \"verdict\": \"pass\", \"findings\": [{\"id\": \"F1\", \"severity\": \"medium\", \"summary\": \"naming\"}]}\n```\n");
    const { cwd, git } = await project(reviewer.command);
    await openOutcome(cwd, "docs", { goal: "Document it", criteria: ["AC1:readme exists", "AC2:the wording is clear"], verify: ["AC1:test -f README.md"], strength: [] });
    await commitFile(git, cwd, "README.md", "# Docs\n", "docs: readme");
    const verifying = await done(cwd);
    expect(verifying.status).toBe("verifying");
    const prompt = await reviewPrompt(cwd);
    expect(prompt.text).toContain("AC2: the wording is clear — review-only, no verifier — REVIEW-ONLY");
    expect(prompt.text).toContain("+# Docs");
    const outcome = await launchReview(cwd);
    expect(outcome).toMatchObject({ status: "closed", blockers: [], notes: ["F1 (medium): naming"] });
    expect(await readFile(reviewer.prompt, "utf8")).toBe(prompt.text);
    const record = await committedRecord(git, "docs");
    expect(record?.review).toMatchObject({ reviewer: "fake", commit: verifying.evidence.input.commit, provenance: { via: "process", command: reviewer.command, promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
  });

  it("records nothing when the reviewer gives no review JSON", async () => {
    const reviewer = await fakeReviewer(await import("node:os").then((os) => os.tmpdir()), "I could not decide.\n");
    const { cwd, git } = await project(reviewer.command);
    await openOutcome(cwd, "docs", { goal: "Document it", criteria: ["AC1:wording is clear"], verify: [], strength: [] });
    await commitFile(git, cwd, "README.md", "# Docs\n", "docs: readme");
    await done(cwd);
    const head = await git.head();
    await expect(launchReview(cwd)).rejects.toThrow(/without a review JSON; nothing was recorded[\s\S]*I could not decide/);
    expect(await git.head()).toBe(head);
    await expect(launchReview(cwd, { agent: "codex" })).rejects.toThrow(/--agent must be claude or pi/);
  });

  it("lets an attested review accept a changed existing test, so no human approval is needed", async () => {
    const reviewer = await fakeReviewer(await import("node:os").then((os) => os.tmpdir()), "{\"reviewer\": \"fake\", \"commit\": \"<COMMIT>\", \"verdict\": \"pass\", \"findings\": [{\"id\": \"F1\", \"severity\": \"low\", \"summary\": \"the test was renamed with the API\", \"accepts\": [\"tests/existing.test.js\"]}]}");
    const { cwd, git } = await project(reviewer.command);
    await startChange(cwd, "rename");
    await commitFile(git, cwd, "tests/existing.test.js", "// renamed API\n", "test: follow the rename");
    const result = await done(cwd);
    expect(result).toMatchObject({ status: "verifying", pending: { approval: expect.stringMatching(/tests\/existing\.test\.js/) } });
    expect(await reviewPrompt(cwd).then((prompt) => prompt.text)).toContain("CHANGED VERIFIERS: tests/existing.test.js");
    expect((await launchReview(cwd)).status).toBe("closed");
  });

  it("reads the verdict from a fenced or bare JSON answer, and has read-only presets", () => {
    expect(extractReview("x {\"a\":1} then {\"verdict\":\"pass\",\"findings\":[{\"summary\":\"a } b\"}]}")).toEqual({ verdict: "pass", findings: [{ summary: "a } b" }] });
    expect(extractReview("```json\n{\"verdict\":\"fail\"}\n```")).toEqual({ verdict: "fail" });
    expect(extractReview("no json")).toBeUndefined();
    const claude = reviewPreset("claude");
    expect(claude.command).toEqual(expect.arrayContaining(["-p", "--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--session-id", claude.session!]));
    expect(reviewPreset("pi").command).toEqual(expect.arrayContaining(["-p", "--no-session", "--no-extensions", "--tools", "read,grep,find,ls"]));
  });
});
