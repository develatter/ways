import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { GitRepository } from "../src/git/git.js";

/*
 * The product as a consumer gets it, end to end and without a model: the
 * packed tarball installed in a fresh repository, `ways bootstrap` with its
 * defaults (Claude Code and pi), and one session driven through the hook
 * payloads each agent sends. Every piece a first day touches is here: the
 * brief at session start, the guard, a small change, a delivery with a
 * verifier, a block, a question answered on the board's API and delivered by
 * the hooks, the wiki, and the CI's `ways verify`.
 */
const root = process.cwd();
let server: ChildProcess | undefined;
afterAll(() => {
  server?.kill("SIGTERM");
});

/** The consumer runs its own installed CLI, never the one under development. */
function consumerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WAYS_") && key !== "CLAUDECODE" && key !== "CLAUDE_ENV_FILE"));
  return { ...base, ...extra };
}

interface Reply {
  status: number;
  body: string;
}

function http(port: number, path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

/** Starts `ways serve --port=0` and resolves with the URL it prints. */
function startServe(cli: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ port: number; token: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "serve", "--port=0"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    server = child;
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`ways serve printed no URL in 15 s:\n${out}\n${err}`)), 15_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /ways board: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), token: match[2]! });
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`ways serve exited with ${code}:\n${out}\n${err}`));
    });
  });
}

interface PiHarness {
  fire(event: string, payload: unknown): Promise<unknown>;
  sent: Array<{ message: { content: string } }>;
}

/** Loads the pi extension bootstrap wrote, with a fake ExtensionAPI and context. */
async function loadPi(cwd: string): Promise<PiHarness> {
  const module = (await import(pathToFileURL(join(cwd, ".pi/extensions/ways/index.ts")).href)) as { default(pi: unknown): void };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sent: PiHarness["sent"] = [];
  module.default({
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
    sendMessage: (message: { content: string }) => sent.push({ message }),
  });
  const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => "pi-smoke" } };
  return { fire: async (event, payload) => await handlers.get(event)!(payload, ctx), sent };
}

describe("smoke: the packed product, end to end", () => {
  it("installs, bootstraps Claude Code and pi, and runs a first day through hooks, the board and CI", async () => {
    // Pack, and check the tarball carries what a consumer runs and nothing else.
    const packDir = await mkdtemp(join(tmpdir(), "ways-smoke-pack-"));
    execFileSync("npm", ["pack", "--pack-destination", packDir], { cwd: root, stdio: "ignore" });
    const [file] = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
    const tarball = join(packDir, file!);
    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n").map((entry) => entry.replace(/^package\//, ""));
    for (const needed of ["package.json", "README.md", "LICENSE", "dist/cli.js", "assets/ui/index.html", "assets/bootstrap/agent-hook"]) expect(entries, needed).toContain(needed);
    expect(entries.filter((entry) => !/^(dist|assets)\//.test(entry)).sort()).toEqual(["LICENSE", "README.md", "package.json"]);
    expect(entries.filter((entry) => entry.endsWith(".map"))).toEqual([]);
    // Every compiled module comes from a source that still exists: no SDD or plan left over from an old build.
    const orphans = entries.filter((entry) => entry.startsWith("dist/") && entry.endsWith(".js")).filter((entry) => !existsSync(join(root, "src", entry.slice(5).replace(/\.js$/, ".ts"))));
    expect(orphans).toEqual([]);

    const cwd = await mkdtemp(join(tmpdir(), "ways-smoke-"));
    const git = new GitRepository(cwd);
    const env = consumerEnv({ WAYS_CONFIG_DIR: await mkdtemp(join(tmpdir(), "ways-smoke-config-")) });
    const run = (command: string, args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(command, args, { cwd, encoding: "utf8", env: { ...env, ...extra } });
    const sh = (command: string, args: string[]): string => {
      const result = run(command, args);
      expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
      return result.stdout;
    };
    sh("git", ["init", "-q", "-b", "main"]);
    sh("git", ["config", "user.name", "Ways Smoke"]);
    sh("git", ["config", "user.email", "smoke@example.test"]);
    sh("git", ["config", "commit.gpgSign", "false"]);
    sh("npm", ["init", "-y"]);
    sh("npm", ["install", "--save-dev", "--no-audit", "--no-fund", tarball]);
    const cli = join(cwd, "node_modules/@develatter/ways/dist/cli.js");
    const ways = (...args: string[]) => run(process.execPath, [cli, ...args]);
    const ok = (...args: string[]): string => {
      const result = ways(...args);
      expect(result.status, `ways ${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
      return result.stdout;
    };
    expect(ok("--version").trim()).toBe(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
    expect(ok("--help")).toMatch(/^ways [\s\S]*Commands:/);
    // The `ways` bin npm linked is the same CLI.
    expect(sh("npx", ["--no-install", "ways", "--version"]).trim()).toBe(ok("--version").trim());

    // Bootstrap with the defaults: Claude Code and pi, nothing for Codex or Cursor.
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    ok("bootstrap", `--test-command=${JSON.stringify([process.execPath, "-e", "process.exit(0)"])}`);
    for (const path of [".ways/config.json", ".ways/hooks/agent-hook", ".claude/settings.json", ".pi/extensions/ways/index.ts", "AGENTS.md", "CLAUDE.md", ".github/workflows/ways.yml"]) expect(existsSync(join(cwd, path)), path).toBe(true);
    expect(existsSync(join(cwd, ".codex")) || existsSync(join(cwd, ".cursor"))).toBe(false);
    const settings = readFileSync(join(cwd, ".claude/settings.json"), "utf8");
    expect(settings).toContain(".ways/hooks/agent-hook claude SessionStart");
    sh("sh", ["scripts/check.sh"]);
    sh("git", ["add", "-A"]);
    sh("git", ["commit", "-q", "-m", "chore: install ways"]);
    const base = await git.head();
    const hook = (agent: string, event: string, payload: Record<string, unknown>): string => {
      const piped = spawnSync("sh", [join(cwd, ".ways/hooks/agent-hook"), agent, event], { cwd, env, encoding: "utf8", input: JSON.stringify({ cwd, hook_event_name: event, ...payload }) });
      expect(piped.status, piped.stderr).toBe(0);
      return piped.stdout;
    };

    // A small change: start, commit as usual (the hook adds the trailer), done.
    ok("start", "fix-readme");
    await writeFile(join(cwd, "README.md"), "# Demo\n");
    sh("git", ["add", "README.md"]);
    sh("git", ["commit", "-q", "-m", "docs: readme"]);
    expect((await git.commitInfo()).trailers.work).toBe("fix-readme");
    expect(ok("done")).toMatch(/closed/);

    // A delivery: criteria with a verifier, which must fail on the base and pass on the commit.
    expect(ok("outcome", "open", "greeting", "--goal=Greet users", "--criterion=AC1:greeting.txt says hi", "--verify=AC1:grep -q hi greeting.txt", "--review=none"))
      .toContain("AC1  greeting.txt says hi  [test: grep -q hi greeting.txt]");

    // Claude Code: the session starts with the brief; the guard refuses a hand-written record.
    const claudeSession = { session_id: "claude-smoke", transcript_path: "/dev/null", permission_mode: "default" };
    const started = JSON.parse(hook("claude", "SessionStart", { ...claudeSession, source: "startup" })) as { hookSpecificOutput: { additionalContext: string } };
    expect(started.hookSpecificOutput.additionalContext).toContain("Work: outcome greeting — Greet users");
    expect(started.hookSpecificOutput.additionalContext).toContain("AC1");
    const denied = JSON.parse(hook("claude", "PreToolUse", { ...claudeSession, tool_name: "Write", tool_input: { file_path: join(cwd, ".ways/work/greeting.json"), content: "{}" }, tool_use_id: "t1" })) as { hookSpecificOutput: { permissionDecision: string } };
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");

    // pi: the extension bootstrap wrote gets the same brief before its first prompt.
    const pi = await loadPi(cwd);
    const saved = { cli: process.env.WAYS_CLI, session: process.env.WAYS_SESSION, agent: process.env.WAYS_AGENT };
    delete process.env.WAYS_CLI;
    try {
      await pi.fire("session_start", { type: "session_start", reason: "startup" });
      const first = await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "Greet the users" }) as { message: { content: string } };
      expect(first.message.content).toContain("Work: outcome greeting — Greet users");
      expect(process.env.WAYS_SESSION).toBe("pi-smoke");

      // The agent implements, commits and finishes; ways records the evidence.
      await writeFile(join(cwd, "greeting.txt"), "hello\n");
      sh("git", ["add", "greeting.txt"]);
      sh("git", ["commit", "-q", "-m", "feat: greeting"]);
      const failing = ways("done");
      expect(failing.status).toBe(1);
      expect(failing.stdout + failing.stderr).toMatch(/AC1 \(test\): failed/);
      await writeFile(join(cwd, "greeting.txt"), "hi\n");
      sh("git", ["commit", "-qam", "fix: say hi"]);
      expect(ok("done")).toContain("Done: outcome greeting closed");

      // A legitimate stop: the work cannot be done as asked, so the agent blocks it.
      ok("start", "payments");
      expect(ok("block", "AC2 needs the payments sandbox key; set PAYMENTS_KEY in .env.test")).toMatch(/Work payments is blocked; the human sees why \(inbox /);
      const inbox = JSON.parse(ok("inbox", "--json")) as Array<{ type: string; title: string }>;
      expect(inbox.some((item) => item.type === "block" && item.title.includes("PAYMENTS_KEY"))).toBe(true);
      ok("cancel");

      // Questions from both agents, answered on the board through its API with the token.
      const ask = (agent: string, session: string, question: string): string => {
        const asked = run(process.execPath, [cli, "ask", question, "--options=mock,key", "--json"], { WAYS_SESSION: session, WAYS_AGENT: agent });
        expect(asked.status, asked.stderr).toBe(0);
        return (JSON.parse(asked.stdout) as { id: string }).id;
      };
      const claudeQuestion = ask("claude", "claude-smoke", "Mock Stripe in CI?");
      const piQuestion = ask("pi", "pi-smoke", "Mock the mailer in CI?");
      const board = await startServe(cli, cwd, env);
      expect((await http(board.port, "/api/state")).status).toBe(401);
      const state = await http(board.port, "/api/state", { token: board.token });
      expect(state.status).toBe(200);
      expect(state.body).toContain(claudeQuestion);
      expect((await http(board.port, `/api/inbox/${claudeQuestion}/answer`, { method: "POST", token: board.token, body: { choice: "mock", text: "and note it" } })).status).toBe(200);
      expect((await http(board.port, `/api/inbox/${piQuestion}/answer`, { method: "POST", token: board.token, body: { choice: "key" } })).status).toBe(200);

      // The hooks deliver each answer once, to the session that asked.
      const stop = JSON.parse(hook("claude", "Stop", { ...claudeSession, stop_hook_active: false })) as { decision: string; reason: string };
      expect(stop.decision).toBe("block");
      expect(stop.reason).toContain(`The human answered your question "Mock Stripe in CI?" (${claudeQuestion}): "mock" — and note it`);
      expect(hook("claude", "Stop", { ...claudeSession, stop_hook_active: true })).toBe("");
      await pi.fire("agent_end", { type: "agent_end", messages: [] });
      expect(pi.sent).toHaveLength(1);
      expect(pi.sent[0]!.message.content).toContain(`(${piQuestion}): "key"`);
      await pi.fire("agent_end", { type: "agent_end", messages: [] });
      expect(pi.sent).toHaveLength(1);
      await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    } finally {
      for (const [key, value] of [["WAYS_CLI", saved.cli], ["WAYS_SESSION", saved.session], ["WAYS_AGENT", saved.agent]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // The wiki for humans: created, checked, committed.
    ok("wiki", "init");
    expect(ok("wiki", "check")).toMatch(/^Wiki is fine/);
    sh("git", ["add", "-A"]);
    sh("git", ["commit", "-q", "-m", "docs: start the wiki"]);

    // The CI's judgement of the whole range, in a clean checkout.
    const reportFile = join(packDir, "ways-report.json");
    const verified = ways("verify", `--base=${base}`, `--json=${reportFile}`);
    expect(verified.status, verified.stdout + verified.stderr).toBe(0);
    expect(verified.stdout).toMatch(/^ways verify passed for [0-9a-f]{12}\.\.[0-9a-f]{12}/);
    const report = JSON.parse(await readFile(reportFile, "utf8")) as { passed: boolean; works: Array<{ id: string; reproduced: boolean }> };
    expect(report.passed).toBe(true);
    expect(report.works.find((work) => work.id === "greeting")).toMatchObject({ reproduced: true });
    expect(ok("check", "--history")).toContain("History checks passed.");
    sh("sh", ["scripts/check.sh", "--history"]);

    // In observe mode the wiki commit started a change on its own, named after the commit; done closes it.
    expect(ok("status")).toContain("Active: change docs-start-the-wiki");
    expect(ok("done")).toMatch(/closed/);
    expect(ok("status")).toContain("No active work.");
  }, 180_000);
});
