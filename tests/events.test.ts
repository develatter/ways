import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { appendEvent, eventFile, eventLine, MAX_FILE_BYTES, MAX_LINE_BYTES, parseEvents, pruneEvents, readAllEvents, readRecentSessionEvents, readSessionEvents, sessionKey, type WaysEvent } from "../src/events/bus.js";

function event(overrides: Partial<WaysEvent> = {}): WaysEvent {
  return { v: 1, ts: "2026-10-29T10:00:00.000Z", session: "s1", agent: "claude", type: "tool.started", hook: "PreToolUse", worktree: "/repo", branch: "main", work: null, result: "ok", ms: 3, ...overrides };
}

async function common(): Promise<{ common: string }> {
  return { common: await mkdtemp(join(tmpdir(), "ways-events-")) };
}

describe("event bus", () => {
  it("appends versioned events to one file per session and reads them back", async () => {
    const dirs = await common();
    appendEvent(dirs, event({ tool: "Edit", paths: ["src/a.ts"] }));
    appendEvent(dirs, event({ type: "tool.finished", ts: "2026-10-29T10:00:01.000Z" }));
    appendEvent(dirs, event({ session: "s2", type: "session.started", hook: "SessionStart" }));
    expect(eventFile(dirs, "s1")).toBe(join(dirs.common, "ways", "events", "s1.jsonl"));
    expect(readSessionEvents(dirs, "s1").map((entry) => entry.type)).toEqual(["tool.started", "tool.finished"]);
    expect(readSessionEvents(dirs, "s1")[0]).toMatchObject({ v: 1, tool: "Edit", paths: ["src/a.ts"] });
    expect(readAllEvents(dirs)).toHaveLength(3);
  });

  it("keys sessions by a file-name-safe name and never escapes the events directory", () => {
    expect(sessionKey("abc-123_X")).toBe("abc-123_X");
    for (const hostile of ["../../etc/passwd", ".hidden", "a/b", "", "x".repeat(200)]) {
      expect(sessionKey(hostile)).toMatch(/^s-[0-9a-f]{32}$/);
    }
  });

  it("caps a line at 4 KiB by dropping paths, and skips torn or foreign lines when reading", () => {
    const many = Array.from({ length: 500 }, (_, index) => `src/very/long/path/number-${index}.ts`);
    const line = eventLine(event({ paths: many, detail: "d".repeat(1000) }));
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const parsed = JSON.parse(line) as WaysEvent;
    expect(parsed.paths!.length).toBeLessThan(many.length);
    expect(parsed.detail!.length).toBeLessThanOrEqual(300);
    expect(many).toHaveLength(500);
    const text = `${JSON.stringify(event())}\n{"v":1,"type":"tool.st\n${JSON.stringify({ v: 2, type: "x", session: "s1", ts: "t" })}\n${JSON.stringify(event({ type: "session.ended" }))}\n`;
    expect(parseEvents(text).map((entry) => entry.type)).toEqual(["tool.started", "session.ended"]);
  });

  it("rotates a full session file and keeps reading both halves", async () => {
    const dirs = await common();
    appendEvent(dirs, event());
    await writeFile(eventFile(dirs, "s1"), `${JSON.stringify(event({ type: "session.started" }))}\n${" ".repeat(MAX_FILE_BYTES)}\n`);
    appendEvent(dirs, event({ type: "session.ended" }));
    const names = (await readdir(join(dirs.common, "ways", "events"))).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^s1\.\d{15}-\d+\.jsonl$/);
    expect(names[1]).toBe("s1.jsonl");
    expect((await stat(eventFile(dirs, "s1"))).size).toBeLessThan(MAX_LINE_BYTES);
    expect(readSessionEvents(dirs, "s1").map((entry) => entry.type)).toEqual(["session.started", "session.ended"]);
    // Hooks read only the tail of the current file.
    expect(readRecentSessionEvents(dirs, "s1").map((entry) => entry.type)).toEqual(["session.ended"]);
  });

  it("reads a bounded tail, dropping the partial first line", async () => {
    const dirs = await common();
    for (let index = 0; index < 50; index += 1) appendEvent(dirs, event({ ms: index }));
    const tail = readRecentSessionEvents(dirs, "s1", 1000);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(50);
    expect(tail.at(-1)!.ms).toBe(49);
  });

  it("prunes the oldest session files beyond the limits", async () => {
    const dirs = await common();
    for (let index = 0; index < 5; index += 1) {
      appendEvent(dirs, event({ session: `s${index}` }));
      const at = new Date(Date.UTC(2026, 9, 1 + index));
      await utimes(eventFile(dirs, `s${index}`), at, at);
    }
    expect(pruneEvents(dirs, { files: 3 })).toBe(2);
    expect((await readdir(join(dirs.common, "ways", "events"))).sort()).toEqual(["s2.jsonl", "s3.jsonl", "s4.jsonl"]);
  });

  it("never interleaves lines when many processes append at once", async () => {
    const dirs = await common();
    const bus = pathToFileURL(join(process.cwd(), "dist", "events", "bus.js")).href;
    const script = `const { appendEvent } = await import(${JSON.stringify(bus)});
for (let i = 0; i < 100; i += 1) appendEvent({ common: process.argv[1] }, { v: 1, ts: new Date().toISOString(), session: "shared", agent: "claude", type: "tool.finished", hook: "PostToolUse", worktree: "/w" + process.argv[2], branch: null, work: null, paths: ["p".repeat(1500)], result: "ok", ms: i });`;
    await Promise.all(Array.from({ length: 8 }, (_, worker) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dirs.common, String(worker)], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
    })));
    // 800 lines of ~1.6 KB cross the rotation size while the writers race: nothing may be lost or torn.
    let lines = 0;
    for (const name of await readdir(join(dirs.common, "ways", "events"))) {
      const text = await readFile(join(dirs.common, "ways", "events", name), "utf8");
      const raw = text.split("\n").filter(Boolean);
      expect(parseEvents(text)).toHaveLength(raw.length);
      lines += raw.length;
    }
    expect(lines).toBe(800);
    expect(readSessionEvents(dirs, "shared")).toHaveLength(800);
  });
});
