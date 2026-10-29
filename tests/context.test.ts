import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrief, BRIEF_MAX_CHARS, relevantMemory, renderBrief } from "../src/context/brief.js";
import { loadMemory, type MemoryFact } from "../src/context/memory.js";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { run } from "../src/cli.js";
import { checkMemory, remember } from "../src/memory/memory.js";
import { gitDirs } from "../src/runtime/runtime.js";
import { done, openOutcome } from "../src/work/work.js";
import { commitFile, installed, repository } from "./helpers.js";

const NOISY_FAILURE = (label: string) => [process.execPath, "-e", `for (let i = 0; i < 80; i++) console.log("${label} line " + i + " " + "x".repeat(150)); process.exit(1)`];

/** An outcome with three criteria, two checks failing with long output, and 12 concepts about the code. */
async function busyRepository(): Promise<string> {
  const { cwd, git } = await repository();
  for (const dir of ["src/auth", "src/billing", "src/api", "lib"]) await mkdir(join(cwd, dir), { recursive: true });
  await commitFile(git, cwd, "lib/util.ts", "export const u = 1;\n", "feat: util");
  await bootstrap({ cwd, testCommand: NOISY_FAILURE("test"), agents: ["claude"], commands: { test: NOISY_FAILURE("test"), lint: NOISY_FAILURE("lint"), required: ["test", "lint"] } });
  await git.run(["add", "-A"]);
  await git.run(["commit", "-q", "-m", "chore: install ways"]);
  await openOutcome(cwd, "billing-export", {
    goal: "Export invoices as CSV",
    criteria: ["AC1:exports one row per invoice", "AC2:amounts are integer cents", "AC3:the export is readable by a human"],
    verify: ["AC1:false", "AC2:true"],
    strength: [],
    review: "required",
  });
  const facts: Array<[string, string, string]> = [
    ["Billing amounts are integer cents; never floats", "src/billing/**", "pitfall"],
    ["CSV exports use RFC 4180 quoting through lib/csv", "src/billing/**", "convention"],
    ["Invoices are immutable once issued; corrections are credit notes", "src/billing/**", "decision"],
    ["Run the billing tests with npm test -- billing", "src/billing/**", "howto"],
    ["Tokens refresh 60 s before expiry", "src/auth/**", "convention"],
    ["Never log tokens or session ids", "src/auth/**", "pitfall"],
    ["API handlers validate input with the shared schema module", "src/api/**", "convention"],
    ["API errors use problem+json", "src/api/**", "decision"],
    ["Pagination is cursor based", "src/api/**", "decision"],
    ["Feature flags are read once at startup", "src/**", "pitfall"],
    ["Dates are stored in UTC and rendered in the user's zone", "src/**", "convention"],
    ["lib/util is shared by every package; keep it dependency free", "lib/**", "convention"],
  ];
  for (const [fact, path, type] of facts) await remember(cwd, fact, { paths: [path], type: type as "convention" });
  await git.run(["add", "-A"]);
  await git.run(["commit", "-q", "-m", "docs: memory"]);
  // lib/** changes after its concept was written: that concept is possibly stale.
  await commitFile(git, cwd, "lib/util.ts", "export const u = 2;\n", "fix: util");
  await commitFile(git, cwd, "src/billing/export.ts", "export const rows = [];\n", "feat: billing export");
  await commitFile(git, cwd, "src/auth/token.ts", "export const t = 1;\n", "feat: token");
  expect((await done(cwd)).status).toBe("failed");
  return cwd;
}

describe("ways context --brief", () => {
  it("fits 6,000 characters with active work, failing checks and twelve concepts, and states facts only", async () => {
    const cwd = await busyRepository();
    const dirs = gitDirs(cwd);
    const brief = await buildBrief(dirs, { touched: ["src/billing/export.ts"] });
    const text = renderBrief(brief);
    if (process.env.WAYS_SHOW_BRIEF) console.log(`${text}\n[${text.length} characters]`);
    expect(text.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(text).toMatch(/^Work: outcome billing-export — Export invoices as CSV \(branch main, base [0-9a-f]{12}\)\n/);
    // A failed run leaves no evidence; the criteria still show what the last run on HEAD said.
    expect(text).toContain("- AC1 [test] failed: exports one row per invoice");
    expect(text).toContain("- AC2 [test] passed: amounts are integer cents");
    expect(text).toContain("- AC3 [review-only] needs review: the export is readable by a human");
    expect(text).toMatch(/Failing: the last `ways done` ran on [0-9a-f]{12} \(HEAD\):\n- check test: failed \(exit 1\) after 3 attempts\n {4}test line 77 x+…?\n {4}test line 78 x+…?\n {4}test line 79 x+…?\n- check lint: failed \(exit 1\) after 3 attempts\n/);
    expect(text).toContain("\n- criterion AC1 (test): failed (exit 1)");
    expect(text).toContain("Next: fix what fails, commit, then `ways done`; if it cannot pass without weakening a test or check, `ways block \"<what is missing>\"` instead.");
    // At most five memories, the touched area first, each with the concept path to read more.
    expect(brief.memory).toHaveLength(5);
    expect(brief.memory.slice(0, 4).every((concept) => concept.paths.includes("src/billing/**"))).toBe(true);
    expect(text).toContain("- [pitfall] Billing amounts are integer cents; never floats — src/billing/** (.ways/knowledge/pitfalls/");
    // No procedure: no step lists, no manual of the harness.
    expect(text).not.toMatch(/^\s*\d+\.\s/m);
    expect(text).not.toMatch(/AGENTS\.md|Harness-Work/);
    expect(brief.blockers).toEqual([expect.objectContaining({ who: "agent", key: expect.stringMatching(/^failing:/) })]);

    // The same through the CLI.
    const cli = spawnSync(process.execPath, [process.env.WAYS_CLI!, "context", "--brief"], { cwd, encoding: "utf8" });
    expect(cli.status).toBe(0);
    expect(cli.stdout.trimEnd().length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(cli.stdout).toContain("Work: outcome billing-export");
    // Without --brief nothing is capped: every concept for the code the work changed is listed (all but the three about src/api).
    const full = spawnSync(process.execPath, [process.env.WAYS_CLI!, "context"], { cwd, encoding: "utf8" }).stdout;
    expect((full.match(/^- \[/gm) ?? []).length).toBe(9);
    const json = JSON.parse(spawnSync(process.execPath, [process.env.WAYS_CLI!, "context", "--brief", "--json"], { cwd, encoding: "utf8" }).stdout) as { work: { id: string }; next: string };
    expect(json.work.id).toBe("billing-export");
  });

  it("marks a concept whose code changed since it was written instead of hiding it", async () => {
    const cwd = await busyRepository();
    const brief = await buildBrief(gitDirs(cwd), { touched: ["lib/util.ts"] });
    const util = brief.memory.find((concept) => concept.paths.includes("lib/**"));
    expect(util?.stale).toBe(true);
    expect(renderBrief(brief)).toContain("lib/util is shared by every package; keep it dependency free — lib/** (.ways/knowledge/conventions/lib-util-is-shared-by-every-package-keep-it.md) (possibly stale: its code changed after it was written)");
    // Concepts whose code did not move since they were written are fresh.
    const api = (await loadMemory(gitDirs(cwd))).filter((concept) => concept.paths.includes("src/api/**"));
    expect(api).toHaveLength(3);
    expect(api.every((concept) => !concept.stale)).toBe(true);
  });

  it("is empty when nothing is in play, and refuses outside a ways repository", async () => {
    const { cwd } = await installed();
    const brief = await buildBrief(gitDirs(cwd));
    expect(brief).toMatchObject({ installed: true, work: null, sections: [], blockers: [] });
    expect(spawnSync(process.execPath, [process.env.WAYS_CLI!, "context"], { cwd, encoding: "utf8" }).stdout).toBe("Nothing in play: no active work, and no memory covers the files being changed.\n");
    const { cwd: bare } = await repository();
    await expect(run(["context"], bare)).rejects.toThrow(/ways is not installed in this repository.*ways bootstrap/);
  });

  it("ranks touched areas first, then uncommitted, then changed; fresh before stale; specific before broad", () => {
    const concept = (path: string, paths: string[], stale = false): MemoryFact => ({ path, title: path, type: "convention", paths, fact: path, stale });
    const all = [concept("broad", ["src/**"]), concept("auth-stale", ["src/auth/**"], true), concept("auth", ["src/auth/**"]), concept("api", ["src/api/**"]), concept("docs", ["docs/**"])];
    const ranked = relevantMemory(all, { touched: ["src/auth/a.ts"], uncommitted: ["src/api/b.ts"], changed: ["docs/x.md"] }).map((entry) => entry.path);
    expect(ranked).toEqual(["auth", "auth-stale", "broad", "api", "docs"]);
    expect(relevantMemory(all, { touched: [], uncommitted: [], changed: [] })).toEqual([]);
  });
});

describe("path rules for Claude Code", () => {
  it("are generated from concepts with paths, kept in sync and never touch the user's own rules", async () => {
    const { cwd, git } = await installed({ agents: ["claude"] });
    await mkdir(join(cwd, ".claude", "rules"), { recursive: true });
    await writeFile(join(cwd, ".claude/rules/ways-mine.md"), "my own rule\n");
    expect(await run(["remember", "Billing amounts are integer cents", "--path=src/billing/**", "--type=pitfall"], cwd)).toBe(0);
    await remember(cwd, "No paths here, so no rule");
    const rulePath = join(cwd, ".claude/rules/ways-pitfalls-billing-amounts-are-integer-cents.md");
    const rule = await readFile(rulePath, "utf8");
    expect(rule).toBe([
      "---",
      "paths:",
      "  - \"src/billing/**\"",
      "---",
      "<!-- Generated by ways from .ways/knowledge/pitfalls/billing-amounts-are-integer-cents.md; edit that concept, not this file, and run `ways memory index`. -->",
      "",
      "ways memory (pitfall): Billing amounts are integer cents",
      "",
      "Source: .ways/knowledge/pitfalls/billing-amounts-are-integer-cents.md",
      "",
    ].join("\n"));
    expect((await checkMemory(cwd)).warnings.filter((warning) => warning.code.startsWith("rule-"))).toEqual([]);

    const concept = join(cwd, ".ways/knowledge/pitfalls/billing-amounts-are-integer-cents.md");
    await writeFile(concept, (await readFile(concept, "utf8")).replace(/\n\nBilling amounts are integer cents\n$/, "\n\nBilling amounts are integer cents.\nRound half to even.\n"));
    expect((await checkMemory(cwd)).warnings.map((warning) => warning.code)).toContain("rule-outdated");
    expect(await run(["memory", "index"], cwd)).toBe(0);
    expect(await readFile(rulePath, "utf8")).toContain("Round half to even.");

    await rm(concept);
    expect((await checkMemory(cwd)).warnings.map((warning) => warning.code)).toContain("rule-orphaned");
    expect(await run(["memory", "index"], cwd)).toBe(0);
    await expect(readFile(rulePath, "utf8")).rejects.toThrow();
    expect(await readFile(join(cwd, ".claude/rules/ways-mine.md"), "utf8")).toBe("my own rule\n");
    await git.run(["add", "-A"]);
  });

  it("are not written without the Claude Code adapter", async () => {
    const { cwd } = await installed({ agents: ["pi"] });
    expect(await run(["remember", "Billing amounts are integer cents", "--path=src/billing/**"], cwd)).toBe(0);
    await expect(readFile(join(cwd, ".claude/rules/ways-conventions-billing-amounts-are-integer-cents.md"), "utf8")).rejects.toThrow();
  });
});
