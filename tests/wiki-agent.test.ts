import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { readAllEvents } from "../src/events/bus.js";
import { gitDirs } from "../src/runtime/runtime.js";
import { planLaunch, WIKI_INSTRUCTION } from "../src/wiki/update.js";
import { DEFAULT_WIKI_CONFIG } from "../src/wiki/config.js";
import { repository } from "./helpers.js";

const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
vi.spyOn(console, "error").mockImplementation(() => undefined);

let agents: string;
let marker: string;

beforeEach(async () => {
  agents = await mkdtemp(join(tmpdir(), "ways-wiki-agents-"));
  marker = join(agents, "marker.txt");
  process.env.WAYS_TEST_MARKER = marker;
});

afterEach(() => {
  delete process.env.WAYS_TEST_MARKER;
  log.mockClear();
});

function said(): string {
  return log.mock.calls.map(([line]) => String(line)).join("\n");
}

/** A fake agent: a Node script that does what the test says, in the working directory ways started it in. */
async function fake(name: string, body: string): Promise<string> {
  const path = join(agents, `${name}.mjs`);
  await writeFile(path, `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\nimport { execFileSync } from "node:child_process";\nconst prompt = readFileSync(0, "utf8");\nwriteFileSync(process.env.WAYS_TEST_MARKER, prompt + "\\nROLE=" + process.env.WAYS_ROLE + "\\nCWD=" + process.cwd() + "\\n");\n${body}\n`);
  return `--agent=node ${path}`;
}

const PAGE = (title: string, extra = ""): string => `---\ntitle: ${title}\nkind: reference\nsources:\n  - src/greet.ts\nreviewed: 2026-10-29\n---\n\n# ${title}\n\n${extra}`;

/** A wiki with one page that has never been stamped, so there is something to ask of an agent. */
async function staleWiki(): Promise<string> {
  const { cwd } = await repository();
  await run(["wiki", "init"], cwd);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src/greet.ts"), "export const hi = 1;\n");
  await mkdir(join(cwd, "docs/wiki/reference"), { recursive: true });
  await writeFile(join(cwd, "docs/wiki/reference/greet.md"), PAGE("Greet"));
  await writeFile(join(cwd, "docs/wiki/index.md"), "---\ntitle: Wiki\n---\n\n# Wiki\n\n- [Greet](reference/greet.md)\n");
  return cwd;
}

describe("ways wiki update with an agent that stays in docs/wiki", () => {
  it("hands over the role and the brief, stamps what the agent wrote, and shows the session on the bus", async () => {
    const cwd = await staleWiki();
    const agent = await fake("good", `
mkdirSync("docs/wiki/how-to", { recursive: true });
writeFileSync("docs/wiki/how-to/greet.md", "---\\ntitle: Greeting\\nkind: how-to\\nsources:\\n  - src/greet.ts\\nreviewed: 2026-10-29\\n---\\n\\n# Greeting\\n\\nrole=" + process.env.WAYS_ROLE + "\\n");
appendFileSync("docs/wiki/index.md", "- [Greeting](how-to/greet.md)\\n");
writeFileSync("docs/wiki/reference/greet.md", readFileSync("docs/wiki/reference/greet.md", "utf8").replace("reviewed: 2026-10-29", "reviewed: 2026-10-30"));
console.log("Changed how-to/greet.md and confirmed reference/greet.md. No doubts.");
`);
    expect(await run(["wiki", "update", agent], cwd)).toBe(0);

    const prompt = await readFile(marker, "utf8");
    expect(prompt).toMatch(/^You are the documentalist\./);
    expect(prompt).toContain("# Wiki update brief");
    expect(prompt).toMatch(/## Stale pages[\s\S]*docs\/wiki\/reference\/greet\.md: no hash recorded for src\/greet\.ts/);
    expect(prompt).toContain("ROLE=documentalist");
    expect(prompt).toContain(`CWD=${realpathSync(cwd)}`);
    for (const path of ["docs/wiki/how-to/greet.md", "docs/wiki/reference/greet.md"]) {
      const text = await readFile(join(cwd, path), "utf8");
      expect(text, path).toMatch(/source_hashes:\n  src\/greet\.ts: [0-9a-f]{12}\n/);
    }
    expect(await readFile(join(cwd, "docs/wiki/how-to/greet.md"), "utf8")).toContain("role=documentalist");
    // The index changed too, but documents nothing, so it is not stamped.
    expect(said()).toMatch(/Changed how-to\/greet\.md[\s\S]*3 page\(s\) changed, 2 stamped[\s\S]*Wiki is fine/);

    const events = readAllEvents(gitDirs(cwd)).filter((event) => event.role === "documentalist");
    expect(events.map((event) => [event.type, event.result, event.agent])).toEqual([["session.started", "ok", "node"], ["agent.stopped", "ok", "node"], ["session.ended", "ok", "node"]]);
    expect(events[0]).toMatchObject({ hook: "wiki", worktree: gitDirs(cwd).top, branch: "main" });
    expect(await run(["wiki", "check"], cwd)).toBe(0);
  });

  it("launches nothing when the wiki has nothing stale, missing or broken", async () => {
    const cwd = await staleWiki();
    await run(["wiki", "update", "--stamp", "reference/greet.md"], cwd);
    const agent = await fake("never", "");
    expect(await run(["wiki", "update", agent], cwd)).toBe(0);
    expect(said()).toMatch(/up to date: nothing is stale, missing or broken, so no agent was launched/);
    expect(existsSync(marker)).toBe(false);
  });

  it("prints the brief and the command with --dry-run, and starts nothing", async () => {
    const cwd = await staleWiki();
    const agent = await fake("never", "");
    expect(await run(["wiki", "update", "--dry-run", agent], cwd)).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const out = said();
    expect(out).toContain("You are the documentalist.");
    expect(out).toMatch(/## Stale pages[\s\S]*greet\.md/);
    expect(out).toMatch(/# Would run \(the prompt above goes on stdin; environment WAYS_ROLE=documentalist\):\nnode \S+never\.mjs/);
    expect(out).toMatch(/anything outside docs\/wiki\/ fails the run/);
  });

  it("says how to fix an agent that cannot start, or that failed", async () => {
    const cwd = await staleWiki();
    await expect(run(["wiki", "update", "--agent=ways-no-such-agent-here"], cwd)).rejects.toThrow(/Cannot start the documentalist `ways-no-such-agent-here`[\s\S]*--agent=claude\|pi/);
    const failing = await fake("failing", 'console.error("quota exceeded"); process.exit(3);');
    expect(await run(["wiki", "update", failing], cwd)).toBe(1);
    expect(said()).toMatch(/exited 3\. Its last output:\nquota exceeded/);
    const events = readAllEvents(gitDirs(cwd)).filter((event) => event.role === "documentalist" && event.type === "session.ended");
    expect(events.map((event) => event.result)).toEqual(["error", "error"]);
  });
});

describe("ways wiki update with an agent that leaves docs/wiki", () => {
  it("fails the run when it writes code or the memory, names the paths, and stamps nothing", async () => {
    const cwd = await staleWiki();
    const agent = await fake("outside", `
mkdirSync(".ways/knowledge/conventions", { recursive: true });
writeFileSync(".ways/knowledge/conventions/sneaky.md", "---\\ntype: convention\\n---\\nmemory written by the documentalist\\n");
writeFileSync("src/greet.ts", "export const hi = 'changed behind the docs';\\n");
writeFileSync("docs/wiki/reference/greet.md", readFileSync("docs/wiki/reference/greet.md", "utf8").replace("reviewed: 2026-10-29", "reviewed: 2026-10-30"));
`);
    expect(await run(["wiki", "update", agent], cwd)).toBe(1);
    const out = said();
    expect(out).toMatch(/changed files outside docs\/wiki\/, which it may not touch:\n  \.ways\/knowledge\/conventions\/sneaky\.md\n  src\/greet\.ts\n/);
    expect(out).toContain("Nothing was kept or stamped");
    expect(await readFile(join(cwd, "docs/wiki/reference/greet.md"), "utf8")).not.toContain("source_hashes");
    const ended = readAllEvents(gitDirs(cwd)).filter((event) => event.role === "documentalist" && event.type === "session.ended");
    expect(ended).toMatchObject([{ result: "refused", detail: "outside docs/wiki" }]);
  });

  it("sees a commit the agent made outside the wiki, even when the tree is clean afterwards", async () => {
    const cwd = await staleWiki();
    const agent = await fake("committer", `
writeFileSync("src/other.ts", "export {};\\n");
execFileSync("git", ["add", "src/other.ts"]);
execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "feat: sneaky"]);
`);
    expect(await run(["wiki", "update", agent], cwd)).toBe(1);
    expect(said()).toMatch(/changed files outside docs\/wiki\/[\s\S]*src\/other\.ts/);
  });

  it("does not blame the agent for changes that were already in the tree", async () => {
    const cwd = await staleWiki();
    await writeFile(join(cwd, "src/mine.ts"), "// my work in progress\n");
    const agent = await fake("tidy", `
writeFileSync("docs/wiki/reference/greet.md", readFileSync("docs/wiki/reference/greet.md", "utf8").replace("reviewed: 2026-10-29", "reviewed: 2026-10-30"));
`);
    expect(await run(["wiki", "update", agent], cwd)).toBe(0);
    expect(await readFile(join(cwd, "src/mine.ts"), "utf8")).toBe("// my work in progress\n");
  });
});

describe("how each agent is started", () => {
  const wikiConfig = DEFAULT_WIKI_CONFIG;

  it("starts Claude Code with edits limited to docs/wiki, no commits, and a session id of ways' choosing", async () => {
    const top = await mkdtemp(join(tmpdir(), "ways-plan-"));
    const launch = planLaunch(top, "claude", wikiConfig, "the prompt", {});
    const { command } = launch;
    expect(command.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(command.at(-1)).toBe(WIKI_INSTRUCTION);
    expect(command[command.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(command[command.indexOf("--session-id") + 1]).toBe(launch.session);
    expect(launch.session).toMatch(/^[0-9a-f-]{36}$/);
    const allowed = command[command.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Edit(docs/wiki/**)", "Write(docs/wiki/**)", "Bash(ways wiki check*)"]));
    // No unrestricted write tool and no git write is allowed.
    expect(allowed).not.toContain("Edit");
    expect(allowed).not.toContain("Write");
    expect(allowed.some((rule) => /git (commit|add|push)/.test(rule))).toBe(false);
    const denied = command[command.indexOf("--disallowedTools") + 1]!.split(",");
    expect(denied).toEqual(expect.arrayContaining(["Edit(.ways/**)", "Write(.ways/**)", "Bash(git commit*)", "Bash(git push*)", "WebFetch"]));
    expect(command).not.toContain("--settings");
  });

  it("adds ways' guard for every write and shell call to Claude Code when ways is installed", async () => {
    const top = await mkdtemp(join(tmpdir(), "ways-plan-"));
    await mkdir(join(top, ".ways/hooks"), { recursive: true });
    await writeFile(join(top, ".ways/hooks/agent-hook"), "#!/bin/sh\n");
    const { command } = planLaunch(top, "claude", wikiConfig, "p", {});
    const settings = JSON.parse(command[command.indexOf("--settings") + 1]!) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } };
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash" });
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toBe('"$CLAUDE_PROJECT_DIR"/.ways/hooks/agent-hook claude PreToolUse');
    // The positional instruction must not be swallowed by a variadic option.
    expect(command.at(-1)).toBe(WIKI_INSTRUCTION);
    expect(command.at(-3)).toBe("--session-id");
  });

  it("starts pi without a shell, and any other agent from a command line read like a shell would", () => {
    const pi = planLaunch("/repo", "pi", wikiConfig, "p", {});
    expect(pi.command).toEqual(["pi", "-p", "--no-session", "--tools", "read,grep,find,ls,edit,write", WIKI_INSTRUCTION]);
    const custom = planLaunch("/repo", "my-agent --flag 'a b' \"c d\"", wikiConfig, "p", {});
    expect(custom).toMatchObject({ agent: "command", label: "my-agent", command: ["my-agent", "--flag", "a b", "c d"] });
    const configured = planLaunch("/repo", undefined, { ...wikiConfig, agent: "command", command: ["docs-bot", "--quiet"] }, "p", {});
    expect(configured.command).toEqual(["docs-bot", "--quiet"]);
    expect(planLaunch("/repo", undefined, { ...wikiConfig, agent: "pi" }, "p", {}).agent).toBe("pi");
    expect(planLaunch("/repo", undefined, wikiConfig, "p", { CLAUDECODE: "1" }).agent).toBe("claude");
  });

  it("says what to pass when no agent is configured", () => {
    expect(() => planLaunch("/repo", undefined, wikiConfig, "p", {})).toThrow(/Which agent writes the wiki\? Run `ways wiki update --agent=claude`/);
    expect(() => planLaunch("/repo", "command", wikiConfig, "p", {})).toThrow(/No command to run/);
    expect(() => planLaunch("/repo", "   ", wikiConfig, "p", {})).toThrow(/--agent must be claude, pi or a command/);
  });
});

describe("the documentalist role", () => {
  it("is shipped with ways as a portable role, and is what the agent is told", async () => {
    const text = await readFile(join(import.meta.dirname, "..", "assets/adapters/roles/documentalist.md"), "utf8");
    expect(text).toMatch(/^---\ndescription: .*\naccess: write\n---\n/);
    const { documentalistRole } = await import("../src/wiki/update.js");
    expect(text).toContain((await documentalistRole()).split("\n")[0]!);
  });
});
