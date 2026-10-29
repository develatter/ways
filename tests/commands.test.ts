import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { ACTION_BUDGET, actionCount, COMMANDS, README_COMMANDS_END, README_COMMANDS_START, renderReadmeTable, renderWikiReference, WIKI_COMMANDS_END, WIKI_COMMANDS_START } from "../src/commands.js";

const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

afterEach(() => {
  log.mockClear();
  error.mockClear();
  stdout.mockClear();
});

function printed(): string {
  return stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
}

describe("command registry", () => {
  it("covers every command the CLI dispatches", async () => {
    const source = await readFile(join(process.cwd(), "src/cli.ts"), "utf8");
    const dispatched = new Set([...source.matchAll(/command === "([a-z][a-z-]*)"/g)].map((match) => match[1]!));
    // Handled before dispatch: `ways version` is an alias of --version and `ways help` renders the registry itself.
    dispatched.delete("version");
    dispatched.delete("help");
    expect([...dispatched].sort()).toEqual(COMMANDS.map((command) => command.name).sort());
  });

  it("has complete, unique entries", () => {
    expect(new Set(COMMANDS.map((command) => command.name)).size).toBe(COMMANDS.length);
    for (const command of COMMANDS) {
      expect(command.summary, command.name).not.toBe("");
      expect(command.usage.length, command.name).toBeGreaterThan(0);
      expect(command.examples.length, command.name).toBeGreaterThan(0);
      for (const line of command.usage.filter((entry) => entry.startsWith("ways "))) expect(line, command.name).toContain(`ways ${command.name}`);
    }
  });

  it("lists every registered command in `ways --help`, and prints it with no arguments", async () => {
    expect(await run(["--help"])).toBe(0);
    const help = printed();
    expect(help).toMatch(/^ways \d+\.\d+\.\d+/);
    for (const command of COMMANDS) expect(help).toMatch(new RegExp(`^  ${command.name}\\s+\\S`, "m"));
    stdout.mockClear();
    expect(await run([])).toBe(0);
    expect(printed()).toBe(help);
  });

  it("prints usage and examples for each command with --help, `help <command>` and -h", async () => {
    for (const command of COMMANDS) {
      stdout.mockClear();
      expect(await run([command.name, "--help"])).toBe(0);
      const help = printed();
      for (const line of [...command.usage, ...command.examples]) expect(help, command.name).toContain(line);
      stdout.mockClear();
      expect(await run(["help", command.name])).toBe(0);
      expect(printed()).toBe(help);
      stdout.mockClear();
      expect(await run([command.name, "-h"])).toBe(0);
      expect(printed()).toBe(help);
    }
  });

  it("fails an unknown command with the next useful command", async () => {
    expect(await run(["frobnicate"])).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain("ways --help");
    expect(await run(["help", "frobnicate"])).toBe(1);
  });

  it("points usage errors at the command help", async () => {
    await expect(run(["review", "bogus"])).rejects.toThrow(/Usage: ways review \[--agent=claude\|pi\][\s\S]*ways review --help/);
    await expect(run(["outcome", "open", "x"])).rejects.toThrow(/Missing required option --goal[\s\S]*ways outcome --help/);
  });

  it("stays within the lean action budget, and counts every action once", () => {
    const actions = COMMANDS.flatMap((command) => command.actions);
    expect(new Set(actions).size).toBe(actions.length);
    for (const command of COMMANDS) for (const action of command.actions) expect(action.startsWith(command.name), action).toBe(true);
    expect(actionCount()).toBe(actions.length);
    expect(actionCount()).toBeLessThanOrEqual(ACTION_BUDGET);
    // 27 for the lean core, plus six for the control plane (serve, ask, and the inbox's list/answer/close/tell: ADR 0008), plus four for the wiki (ADR 0009).
    expect(ACTION_BUDGET).toBe(37);
  });

  it("no longer offers the removed workflows", async () => {
    // `context` came back in 0.3 as the agent's bounded brief (ADR 0006), not as the 0.2 packet.
    for (const removed of ["sdd", "plan", "quick", "task", "repair"]) {
      expect(COMMANDS.some((command) => command.name === removed), removed).toBe(false);
      expect(await run([removed])).toBe(1);
    }
  });

  it("keeps the README command table generated from the registry", async () => {
    const path = join(process.cwd(), "README.md");
    const readme = await readFile(path, "utf8");
    const start = readme.indexOf(README_COMMANDS_START);
    const end = readme.indexOf(README_COMMANDS_END);
    expect(start, "README.md is missing the commands markers").toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const expected = `${README_COMMANDS_START}\n${renderReadmeTable()}\n${README_COMMANDS_END}`;
    if (process.env.UPDATE_README === "1") await writeFile(path, `${readme.slice(0, start)}${expected}${readme.slice(end + README_COMMANDS_END.length)}`);
    else expect(readme.slice(start, end + README_COMMANDS_END.length), "run `UPDATE_README=1 npx vitest run tests/commands.test.ts`").toBe(expected);
  });

  it("names only commands and flags the CLI has, in the README and the guides", async () => {
    const files = ["README.md", ...(await readdir(join(process.cwd(), "docs"))).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
    const wrong: string[] = [];
    for (const file of files) {
      const text = (await readFile(join(process.cwd(), file), "utf8")).replace(/\\\n\s*/g, " ");
      const code = [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)].map((block) => block[1]!).join("\n");
      const mentions = [...text.matchAll(/`(?:npx )?ways ([a-z][a-z-]*)([^`\n]*)`/g), ...code.matchAll(/^(?:npx (?:--no-install )?)?ways ([a-z][a-z-]*)(.*)$/gm)];
      for (const [, name, rest] of mentions) {
        const command = COMMANDS.find((entry) => entry.name === name);
        if (!command) {
          wrong.push(`${file}: ways ${name}`);
          continue;
        }
        const usage = command.usage.join(" ");
        for (const [flag] of (rest ?? "").replace(/\s#.*$/, "").matchAll(/(?<=^|\s)--[a-z][a-z-]*/g)) {
          if (flag !== "--help" && !usage.includes(flag)) wrong.push(`${file}: ways ${name} ${flag}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps the wiki's command reference generated from the registry", async () => {
    const path = join(process.cwd(), "docs/wiki/reference/commands.md");
    const page = await readFile(path, "utf8");
    const start = page.indexOf(WIKI_COMMANDS_START);
    const end = page.indexOf(WIKI_COMMANDS_END);
    expect(start, "docs/wiki/reference/commands.md is missing the commands markers").toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const expected = `${WIKI_COMMANDS_START}\n\n${renderWikiReference()}\n\n${WIKI_COMMANDS_END}`;
    if (process.env.UPDATE_README === "1") await writeFile(path, `${page.slice(0, start)}${expected}${page.slice(end + WIKI_COMMANDS_END.length)}`);
    else expect(page.slice(start, end + WIKI_COMMANDS_END.length), "run `UPDATE_README=1 npx vitest run tests/commands.test.ts`, then `ways wiki update --stamp reference/commands.md`").toBe(expected);
  });
});
