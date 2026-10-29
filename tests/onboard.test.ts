import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrief } from "../src/context/brief.js";
import { checkMemory } from "../src/memory/memory.js";
import { confirmConcept } from "../src/memory/verify.js";
import { onboard } from "../src/onboard/onboard.js";
import { readOnboarding } from "../src/onboard/state.js";
import { readChecksFile } from "../src/run/checks-file.js";
import { gitDirs } from "../src/runtime/runtime.js";
import { installed } from "./helpers.js";

/** A fake onboarder: reads the brief on stdin and writes what a real one would, two facts ways must refuse and one bad check among them. */
const GOOD = `
const fs = require("node:fs");
const path = require("node:path");
const brief = fs.readFileSync(0, "utf8");
if (!brief.includes("You are the onboarder") || !brief.includes("Onboarding brief")) process.exit(3);
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
write(".ways/map-notes.json", JSON.stringify({ src: "The shop's pricing code", "gone/": "a folder that does not exist" }));
write(".ways/knowledge/pitfalls/money-in-cents.md", "---\\ntype: pitfall\\ntitle: Prices are integer cents\\npaths: [\\"src/**\\"]\\nsources:\\n  - resource: /src/money.js\\n---\\nPrices are integer cents; never add floats (see src/money.js).\\n");
write(".ways/knowledge/conventions/no-source.md", "---\\ntype: convention\\ntitle: Something heard somewhere\\npaths: [\\"src/**\\"]\\n---\\nNo source for this.\\n");
write(".ways/knowledge/decisions/ghost.md", "---\\ntype: decision\\ntitle: A ghost file\\nsources:\\n  - resource: /src/ghost.js\\n---\\nRead in a file that does not exist.\\n");
const checks = JSON.parse(fs.readFileSync(".ways/checks.json", "utf8"));
checks.proposed = { lint: { command: [process.execPath, "-e", "console.log('0 problems')"], why: "CI runs it" }, e2e: { command: ["ways-no-such-e2e-runner"], why: "the README mentions it" } };
write(".ways/checks.json", JSON.stringify(checks, null, 2));
write(".ways/agents-proposal.md", "- Prices are integer cents; convert only at the edges.\\n");
console.log("Wrote 3 facts, 2 notes, 2 proposed checks.");
`;

const ROGUE = `
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
fs.writeFileSync("src/money.js", "module.exports = 'hacked';\\n");
fs.writeFileSync(".ways/map-notes.json", JSON.stringify({ src: "x" }));
`;

async function agent(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ways-fake-onboarder-"));
  await writeFile(join(dir, "agent.js"), source);
  return `${process.execPath} ${join(dir, "agent.js")}`;
}

async function shop(): Promise<Awaited<ReturnType<typeof installed>>> {
  const repo = await installed({ testCommand: [process.execPath, "-e", "process.exit(0)"], layers: true });
  await mkdir(join(repo.cwd, "src"));
  await writeFile(join(repo.cwd, "src/money.js"), "module.exports = (cents) => cents;\n");
  await repo.git.run(["add", "-A"]);
  await repo.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "feat: money"]);
  return repo;
}

describe("ways onboard", () => {
  it("never starts an agent without the human's yes under the ask policy", async () => {
    const repo = await shop();
    const lines: string[] = [];
    const result = await onboard(repo.cwd, { agent: await agent(GOOD) }, (line) => lines.push(line));
    expect(result).toMatchObject({ status: "needs-consent", exitCode: 2 });
    expect(lines.join("\n")).toMatch(/may read the \d+ files of this repository/);
    expect(lines.join("\n")).toContain("ways onboard --yes");
    expect(readOnboarding(repo.cwd)?.status).toBe("pending");
  });

  it("with a fake onboarder: MAP.md annotated, facts stamped and validated, checks run before they are kept, done", async () => {
    const repo = await shop();
    const result = await onboard(repo.cwd, { agent: await agent(GOOD), yes: true }, () => undefined);
    expect(result.status).toBe("done");
    expect(await readFile(join(repo.cwd, "MAP.md"), "utf8")).toContain("| `src/` | 1 | The shop's pricing code |");
    expect(JSON.parse(await readFile(join(repo.cwd, ".ways/map-notes.json"), "utf8"))).toEqual({ "src/": "The shop's pricing code" });

    // The fact with a source is kept, stamped by ways and unverified; the other two are dropped.
    const fact = await readFile(join(repo.cwd, ".ways/knowledge/pitfalls/money-in-cents.md"), "utf8");
    expect(fact).toMatch(/generated:\n\s+by: process:ways-onboard/);
    expect(fact).toMatch(/resource: \/src\/money\.js\n\s+hash: [0-9a-f]{12}/);
    await expect(readFile(join(repo.cwd, ".ways/knowledge/conventions/no-source.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(repo.cwd, ".ways/knowledge/decisions/ghost.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const memory = await checkMemory(repo.cwd);
    expect(memory.issues).toEqual([]);
    expect(memory.warnings.map((warning) => warning.code)).toContain("unverified");

    // Proposed checks: the one that runs is kept with its line base, the missing program is rejected.
    expect(readChecksFile(repo.cwd).checks.lint).toMatchObject({ source: "proposed by the onboarder", baseline: { status: "passed" } });
    expect(readChecksFile(repo.cwd).checks.e2e).toBeUndefined();
    expect(readChecksFile(repo.cwd).proposed).toBeUndefined();
    const config = JSON.parse(await readFile(join(repo.cwd, ".ways/config.json"), "utf8")) as { commands: { required: string[] } };
    expect(config.commands.required).toEqual(["test", "lint"]);

    // The AGENTS.md proposal lands in its marked block; the rest of AGENTS.md is untouched.
    const agents = await readFile(join(repo.cwd, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/<!-- ways:onboarder:start[^\n]*-->\n## Conventions and pitfalls\n\n- Prices are integer cents; convert only at the edges\.\n<!-- ways:onboarder:end -->/);
    expect(agents.split("\n").length).toBeLessThanOrEqual(100);

    const state = readOnboarding(repo.cwd)!;
    expect(state.status).toBe("done");
    expect(state.summary).toMatchObject({ facts: ["pitfalls/money-in-cents"], unverified: ["pitfalls/money-in-cents"], checks: ["test", "lint"], agentsProposal: true });
    expect(state.summary!.rejected).toEqual([expect.objectContaining({ check: "e2e" })]);
    expect(state.summary!.missing.join("\n")).toMatch(/fact dropped: .*no-source\.md.*sources/);
    expect(state.summary!.missing.join("\n")).toMatch(/note dropped \(no such path\): gone\//);

    // The agent learns the fact is unverified when it touches the code; a person's confirmation clears the mark.
    const brief = await buildBrief(gitDirs(repo.cwd), { touched: ["src/money.js"] });
    expect(brief.sections.find((section) => section.id.startsWith("memory:"))?.text).toContain("(unverified: seeded by onboarding");
    await confirmConcept(repo.cwd, "pitfalls/money-in-cents", "human:alex@example.test");
    expect((await checkMemory(repo.cwd)).warnings.map((warning) => warning.code)).not.toContain("unverified");

    // The session is on the bus with its role; a second run says it is done already.
    const dir = join(gitDirs(repo.cwd).common, "ways", "events");
    const logged = (await Promise.all((await readdir(dir)).map((name) => readFile(join(dir, name), "utf8")))).join("");
    expect(logged).toMatch(/"type":"session\.started".*"hook":"onboard".*"role":"onboarder"|"role":"onboarder".*"type":"session\.started"/);
    expect((await onboard(repo.cwd, {}, () => undefined)).status).toBe("up-to-date");
  }, 120_000);

  it("fails and does not mark done when the onboarder writes outside its paths", async () => {
    const repo = await shop();
    const lines: string[] = [];
    const result = await onboard(repo.cwd, { agent: await agent(ROGUE), yes: true }, (line) => lines.push(line));
    expect(result).toMatchObject({ status: "failed", exitCode: 1, strays: ["src/money.js"] });
    expect(lines.join("\n")).toContain("git restore -- <path>");
    expect(readOnboarding(repo.cwd)?.status).toBe("pending");
  }, 60_000);

  it("without an agent: the deterministic part, and what is missing said plainly", async () => {
    const repo = await shop();
    const lines: string[] = [];
    const result = await onboard(repo.cwd, { agent: "none" }, (line) => lines.push(line));
    expect(result).toMatchObject({ status: "pending", exitCode: 0 });
    expect(lines.join("\n")).toMatch(/not done: no agent was found .*`ways onboard --agent=claude`/);
    expect(await readFile(join(repo.cwd, "MAP.md"), "utf8")).toContain("| `src/` | 1 |");
  }, 60_000);
});
