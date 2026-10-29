import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent } from "../src/events/bus.js";
import { createItem, getItem, type InboxItem } from "../src/inbox/inbox.js";
import { gitDirs } from "../src/runtime/runtime.js";
import { readRegistry, register } from "../src/serve/config.js";
import { LiveSource } from "../src/serve/live.js";
import { hostAllowed, MAX_BODY_BYTES, originAllowed, startServer, tokenMatches, uiPath, type RunningServer } from "../src/serve/server.js";
import { committedRecord } from "../src/work/record.js";
import { installed, signedProject, waitingForHuman } from "./helpers.js";

/*
 * `ways serve` on port 0: who may talk to it, what it serves, how fast a
 * hook event reaches an open page, and the inbox and approvals through it.
 */
const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function serve(cwd: string, extra: { tokenFile?: string; pollMs?: number } = {}): Promise<RunningServer> {
  const server = await startServer({ source: new LiveSource([cwd]), port: 0, lang: "en", ...extra });
  running.push(server);
  return server;
}

function auth(server: RunningServer, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${server.token}`, ...extra };
}

function post(server: RunningServer, path: string, body: unknown): Promise<Reply> {
  return call(server.port, path, { method: "POST", headers: auth(server, { "content-type": "application/json" }), body: JSON.stringify(body) });
}

describe("ways serve: who may talk to it", () => {
  it("binds to loopback, writes its token 0600, and requires the token, a loopback Host and its own Origin", async () => {
    const { cwd } = await installed();
    const tokenFile = join(gitDirs(cwd).common, "ways", "serve.json");
    const server = await serve(cwd, { tokenFile });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{43}$/);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(tokenFile, "utf8"))).toMatchObject({ port: server.port, token: server.token, url: server.url, pid: process.pid });
    // Nothing answers on other interfaces.
    await expect(new Promise((resolve, reject) => {
      const req = request({ host: "::1", port: server.port, path: "/", family: 6 }, resolve);
      req.on("error", reject);
      req.end();
    })).rejects.toThrow();

    const page = await call(server.port, `/?token=${server.token}`);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["set-cookie"]?.[0]).toBe(`ways_token_${server.port}=${server.token}; HttpOnly; SameSite=Strict; Path=/`);
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'; script-src 'sha256-[^']+'; style-src 'sha256-[^']+'; connect-src 'self'/);
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await call(server.port, "/api/state", { headers: { cookie: `ways_token_${server.port}=${server.token}` } })).status).toBe(200);
    expect((await call(server.port, "/api/state", { headers: { "x-ways-token": server.token } })).status).toBe(200);

    expect((await call(server.port, "/")).status).toBe(401);
    expect((await call(server.port, "/?token=wrong")).status).toBe(401);
    expect((await call(server.port, "/api/state", { headers: { authorization: `Bearer ${server.token}x` } })).status).toBe(401);
    expect((await call(server.port, `/?token=${server.token}`, { headers: { host: `evil.example:${server.port}` } })).status).toBe(403);
    expect((await call(server.port, `/?token=${server.token}`, { headers: { host: `127.0.0.1:${server.port + 1}` } })).status).toBe(403);
    expect((await call(server.port, "/api/state", { headers: auth(server, { origin: "http://evil.example" }) })).status).toBe(403);
    expect((await call(server.port, "/api/state", { headers: auth(server, { origin: `http://localhost:${server.port}` }) })).status).toBe(200);
    expect((await call(server.port, "/api/state", { headers: auth(server, { "sec-fetch-site": "cross-site" }) })).status).toBe(403);

    // Mutations: never with the token in the URL, only JSON, bounded, no preflight answered.
    expect((await call(server.port, `/api/refresh?token=${server.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await call(server.port, "/api/refresh", { method: "POST", headers: auth(server, { "content-type": "text/plain" }), body: "{}" })).status).toBe(415);
    expect((await call(server.port, "/api/refresh", { method: "POST", headers: auth(server, { "content-type": "application/x-www-form-urlencoded" }), body: "a=b" })).status).toBe(415);
    expect((await call(server.port, "/api/tell", { method: "POST", headers: auth(server, { "content-type": "application/json" }), body: JSON.stringify({ text: "x".repeat(MAX_BODY_BYTES) }) })).status).toBe(413);
    const preflight = await call(server.port, "/api/refresh", { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(403);
    expect(Object.keys(preflight.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
    expect((await call(server.port, "/api/refresh", { method: "OPTIONS", headers: { origin: `http://127.0.0.1:${server.port}` } })).status).toBe(405);
    expect((await call(server.port, "/api/refresh", { method: "PUT", headers: auth(server) })).status).toBe(405);
    expect((await call(server.port, "/../../etc/passwd", { headers: auth(server) })).status).toBe(404);
    expect((await post(server, "/api/refresh", {})).status).toBe(200);

    await server.close();
    running.splice(0);
    expect(() => statSync(tokenFile)).toThrow();
  });

  it("checks hosts, origins and tokens exactly", () => {
    expect(hostAllowed("127.0.0.1:8080", 8080)).toBe(true);
    expect(hostAllowed("LOCALHOST:8080", 8080)).toBe(true);
    expect(hostAllowed("[::1]:8080", 8080)).toBe(true);
    for (const host of [undefined, "127.0.0.1", "127.0.0.1:8081", "127.0.0.1.evil.example:8080", "localhost.evil:8080", "0.0.0.0:8080"]) expect(hostAllowed(host, 8080), String(host)).toBe(false);
    expect(originAllowed("http://127.0.0.1:8080", 8080)).toBe(true);
    for (const origin of ["null", "https://127.0.0.1:8080", "http://127.0.0.1:8081", "http://evil.example"]) expect(originAllowed(origin, 8080), origin).toBe(false);
    expect(tokenMatches("abc", "abc")).toBe(true);
    for (const given of [undefined, null, "", "ab", "abcd"]) expect(tokenMatches(given, "abc")).toBe(false);
  });

  it("serves one self-contained page under 60 KB, with no external resources", () => {
    const html = readFileSync(uiPath(), "utf8");
    const size = Buffer.byteLength(html);
    console.log(`UI size: ${size} bytes`);
    expect(size).toBeLessThan(60 * 1024);
    expect(html).not.toMatch(/(src|href)=["']?(https?:)?\/\//);
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
    expect(html).not.toMatch(/ style=/);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).toContain("prefers-color-scheme:dark");
    // Both languages carry the same keys.
    const dictionaries = /const I18N = (\{[\s\S]*?\n\});/.exec(html)![1]!;
    const keys = (lang: string) => [...new RegExp(`${lang}: \\{([\\s\\S]*?)\\n  \\}`).exec(dictionaries)![1]!.matchAll(/"?([\w.-]+)"?: "/g)].map((match) => match[1]).sort();
    expect(keys("es")).toEqual(keys("en"));
    expect(createHash("sha256").update(html).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lays the board out in equal flexible columns that share the width next to the inbox", () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(uiPath(), "utf8"))![1]!;
    const rule = (selector: string): string => new RegExp(`(?:^|\\n|\\})${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    // A grid with min-width:max-content sized every column to the longest unwrapped card text (933 px at 1700 px).
    expect(css).not.toMatch(/max-content/);
    expect(rule(".columns")).toMatch(/display:flex/);
    const col = rule(".col");
    const [, grow, shrink, basis] = /flex:(\d+) (\d+) (\d+)px/.exec(col)!;
    const minWidth = Number(/min-width:(\d+)px/.exec(col)![1]);
    expect([Number(grow), Number(shrink)]).toEqual([1, 1]);
    expect(Number(basis)).toBeLessThanOrEqual(260);
    const [, low, share, high] = /grid-template-columns:minmax\(0,1fr\) clamp\((\d+)px,(\d+)vw,(\d+)px\)/.exec(rule("main.layout"))!.map(Number) as number[];
    const gap = Number(/gap:(\d+)px/.exec(rule(".columns"))![1]);
    // Six columns side by side next to the inbox (above 1000 px), below it under 1000 px.
    const column = (viewport: number): { width: number; scrolls: boolean } => {
      const inbox = viewport > 1000 ? Math.min(high!, Math.max(low!, viewport * share! / 100)) : 0;
      const room = viewport - inbox - 32 - 5 * gap;
      return { width: Math.max(minWidth, room / 6), scrolls: room / 6 < minWidth };
    };
    expect(column(1700)).toMatchObject({ scrolls: false });
    expect(column(1700).width).toBeGreaterThan(200);
    expect(column(1700).width).toBeLessThan(260);
    expect(column(1280)).toEqual({ width: minWidth, scrolls: true });
    expect(column(2560).width).toBeLessThan(400);
    // On a phone the columns stack and take the whole width.
    expect(css).toMatch(/@media \(max-width:640px\)\{\.columns\{flex-direction:column/);
  });

  it("keeps a registry of repositories in the user's config directory", async () => {
    const env = { WAYS_CONFIG_DIR: await mkdtemp(join(tmpdir(), "ways-config-")) };
    expect(readRegistry(env)).toEqual([]);
    expect(register(["/a", "/b"], env)).toEqual(["/a", "/b"]);
    expect(register(["/a"], env)).toEqual(["/a", "/b"]);
    expect(readRegistry(env)).toEqual(["/a", "/b"]);
  });
});

describe("ways serve: live", () => {
  it("pushes a card to an open page within 2 s of a hook event", async () => {
    const { cwd } = await installed();
    // The default poll: the events directory does not exist yet, so no watcher helps the first event.
    const server = await serve(cwd);
    const states: Array<{ at: number; cards: Array<{ session: string | null; last: { type: string } | null }> }> = [];
    const stream = request({ host: "127.0.0.1", port: server.port, path: "/events", headers: { host: `127.0.0.1:${server.port}`, ...auth(server) } });
    const response = new Promise<void>((resolve) => stream.on("response", (res) => {
      expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = message.split("\n").find((line) => line.startsWith("data: "));
          if (data) states.push({ at: Date.now(), ...JSON.parse(data.slice(6)) });
        }
      });
      resolve();
    }));
    stream.end();
    await response;
    for (let attempt = 0; attempt < 50 && states.length === 0; attempt += 1) await new Promise((done) => setTimeout(done, 20));
    expect(states[0]!.cards).toEqual([]);

    const sent = Date.now();
    appendEvent(gitDirs(cwd), { v: 1, ts: new Date().toISOString(), session: "sess-live", agent: "claude", type: "prompt.submitted", hook: "UserPromptSubmit", worktree: cwd, branch: "main", work: null, result: "silent", ms: 2 });
    let arrived: (typeof states)[number] | undefined;
    for (let attempt = 0; attempt < 100 && !arrived; attempt += 1) {
      arrived = states.find((state) => state.cards.some((card) => card.session === "sess-live"));
      if (!arrived) await new Promise((done) => setTimeout(done, 20));
    }
    expect(arrived, "no state with the new session").toBeDefined();
    console.log(`card on the page ${arrived!.at - sent} ms after the first hook event`);
    expect(arrived!.at - sent).toBeLessThan(2000);

    // Once the directory exists, a watcher sees the next event without waiting for the poll.
    await new Promise((done) => setTimeout(done, 1100));
    const again = Date.now();
    appendEvent(gitDirs(cwd), { v: 1, ts: new Date().toISOString(), session: "sess-live", agent: "claude", type: "agent.stopped", hook: "Stop", worktree: cwd, branch: "main", work: null, result: "ok", ms: 2 });
    let stopped: (typeof states)[number] | undefined;
    for (let attempt = 0; attempt < 100 && !stopped; attempt += 1) {
      stopped = states.find((state) => state.at >= again && state.cards.some((card) => card.session === "sess-live" && card.last?.type === "agent.stopped"));
      if (!stopped) await new Promise((done) => setTimeout(done, 10));
    }
    stream.destroy();
    expect(stopped).toBeDefined();
    console.log(`card updated ${stopped!.at - again} ms after the next hook event`);
    expect(stopped!.at - again).toBeLessThan(2000);
  });

  it("round trip from the page: Claude Code and pi ask, the human answers in the board, the hooks deliver once", async () => {
    const { cwd } = await installed({ agents: ["claude", "pi"] });
    const dirs = gitDirs(cwd);
    const server = await serve(cwd);
    const items: InboxItem[] = [];
    for (const agent of ["claude", "pi"]) {
      items.push(createItem(dirs, { type: "ask", title: `Question from ${agent}`, options: ["yes", "no"], from: { agent, session: `sess-${agent}`, worktree: cwd }, to: { session: `sess-${agent}`, worktree: cwd } }));
    }
    const state = JSON.parse((await call(server.port, "/api/state", { headers: auth(server) })).body) as { inbox: InboxItem[]; lang: string; demo: boolean };
    expect(state).toMatchObject({ lang: "en", demo: false });
    expect(state.inbox.map((entry) => entry.id).sort()).toEqual(items.map((entry) => entry.id).sort());
    expect((await post(server, `/api/inbox/${items[0]!.id}/answer`, { choice: "yes", text: "go ahead" })).status).toBe(200);
    expect((await post(server, `/api/inbox/${items[1]!.id}/answer`, { choice: "maybe" })).status).toBe(409);
    expect((await post(server, `/api/inbox/${items[1]!.id}/answer`, { choice: "no" })).status).toBe(200);
    expect((await post(server, "/api/inbox/i-zzzzzz-00000000/answer", { choice: "no" })).status).toBe(404);

    const hook = (agent: string, event: string, session: string) => spawnSync("sh", [join(cwd, ".ways/hooks/agent-hook"), agent, event], { cwd, input: JSON.stringify({ session_id: session, cwd, prompt: "go" }), encoding: "utf8" }).stdout;
    expect(JSON.parse(hook("claude", "Stop", "sess-claude")).reason).toContain("\"yes\" — go ahead");
    expect(JSON.parse(hook("pi", "UserPromptSubmit", "sess-pi")).context).toContain("\"no\"");
    expect(hook("claude", "Stop", "sess-claude")).toBe("");
    expect(hook("pi", "UserPromptSubmit", "sess-pi")).not.toContain("Question from pi");
    expect(items.map((entry) => getItem(dirs, entry.id).status)).toEqual(["delivered", "delivered"]);
    expect(getItem(dirs, items[0]!.id).answer).toMatchObject({ by: "human", via: "ui" });

    // An instruction from the page, confined to the repository's own worktrees.
    expect((await post(server, "/api/tell", { repo: "nope", text: "x" })).status).toBe(404);
    const repo = (JSON.parse((await call(server.port, "/api/state", { headers: auth(server) })).body) as { repos: Array<{ id: string }> }).repos[0]!.id;
    expect((await post(server, "/api/tell", { repo, text: "x", worktree: "/etc" })).status).toBe(409);
    expect((await post(server, "/api/tell", { repo, text: "Rebase on main before the next commit", worktree: cwd })).status).toBe(200);
    expect(JSON.parse(hook("claude", "UserPromptSubmit", "sess-claude")).hookSpecificOutput.additionalContext).toContain("Instruction from the human");
    // Closing from the page.
    const extra = createItem(dirs, { type: "ask", title: "Obsolete?", from: { worktree: cwd }, to: { worktree: cwd } });
    expect((await post(server, `/api/inbox/${extra.id}/close`, { reason: "not needed" })).status).toBe(200);
    expect(getItem(dirs, extra.id)).toMatchObject({ status: "closed", closed: { by: "human", reason: "not needed" } });
  });
});

describe("ways serve: approvals", () => {
  it("records a work's approval from the board when the base does not require signatures", async () => {
    const repo = await signedProject("optional");
    await waitingForHuman(repo);
    const server = await serve(repo.cwd);
    const state = JSON.parse((await call(server.port, "/api/state", { headers: auth(server) })).body) as { inbox: Array<InboxItem & { binding?: { signature: boolean } }>; cards: Array<{ column: string; work: { id: string } | null }> };
    const entry = state.inbox.find((item) => item.binding)!;
    expect(entry).toMatchObject({ type: "approval", work: "edit-test", binding: { signature: false } });
    expect(state.cards.find((card) => card.work?.id === "edit-test")?.column).toBe("waiting");
    expect((await post(server, `/api/inbox/${entry.id}/close`, {})).status).toBe(409);
    expect((await post(server, `/api/inbox/${entry.id}/answer`, { choice: "reject" })).status).toBe(409);
    expect((await post(server, `/api/inbox/${entry.id}/answer`, { choice: "approve" })).status).toBe(200);
    const record = await committedRecord(repo.git, "edit-test");
    expect(record?.approval).toMatchObject({ via: "board", by: "Ways Test <ways@example.test>" });
    expect(record?.closed).toBeDefined();
  });

  it("refuses it where the base requires SSH signatures, and says the exact command", async () => {
    const repo = await signedProject("required");
    await waitingForHuman(repo);
    const server = await serve(repo.cwd);
    const state = JSON.parse((await call(server.port, "/api/state", { headers: auth(server) })).body) as { inbox: Array<InboxItem & { binding?: { signature: boolean; command: string } }> };
    const entry = state.inbox.find((item) => item.binding)!;
    expect(entry.binding).toMatchObject({ signature: true, command: expect.stringMatching(/ways approve --key=<your SSH key>$/) });
    const refused = await post(server, `/api/inbox/${entry.id}/answer`, { choice: "approve" });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body).error).toMatch(/requires SSH-signed approvals[\s\S]*ways approve/);
    expect((await committedRecord(repo.git, "edit-test"))?.approval).toBeUndefined();
  });
});
