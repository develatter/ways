import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { failedCheckDetails, runChecks } from "../src/check/check.js";
import type { NamedChecksConfig, ValidationFailureRecord } from "../src/domain/types.js";
import { validateConfig } from "../src/domain/validation.js";
import { GitRepository } from "../src/git/git.js";
import { finishQuick, startQuick } from "../src/work/quick.js";
import { validationFailureDigest, validationFailureRecordFailure } from "../src/work/validation-failure.js";

const node = process.execPath;
const pass = [node, "-e", "process.exit(0)"];
const unrelated: ChildProcess[] = [];

afterEach(() => {
  for (const child of unrelated.splice(0)) child.kill("SIGKILL");
});

async function repository(commands: NamedChecksConfig): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-services-"));
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  await bootstrap({ cwd, testCommand: pass, adapters: false, commands });
  return cwd;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A fake service that records its pid, then runs `body`. */
function service(pidFile: string, body: string): string[] {
  return [node, "-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${body}`];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function pidOf(file: string): Promise<number> {
  return Number(await readFile(file, "utf8"));
}

describe("setup and service readiness", () => {
  it("runs setup, waits for a ready service, captures logs and stops only owned processes", async () => {
    const port = await freePort();
    const bystander = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    unrelated.push(bystander);
    const cwd = await mkdtemp(join(tmpdir(), "ways-services-files-"));
    const pidFile = join(cwd, "api.pid");
    const setupMarker = join(cwd, "setup-ran");
    const repo = await repository({
      required: ["test"],
      setup: [node, "-e", `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "ok")`],
      services: [{
        name: "api",
        command: service(pidFile, `console.log("api listening"); require("node:http").createServer((_, res) => res.end("ok")).listen(${port}, "127.0.0.1");`),
        ready: { http: `http://127.0.0.1:${port}/` },
        timeoutMs: 3_000,
      }],
      // Smoke check against the running service.
      test: [node, "-e", `fetch("http://127.0.0.1:${port}/").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(2))`],
    });

    const plain = await runChecks(repo);
    expect(plain.environment).toBeUndefined();
    expect(plain.checks?.find((check) => check.name === "test")?.status).toBe("failed");
    await expect(readFile(setupMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const result = await runChecks(repo, false, undefined, { services: true });
    expect(result.environment?.map(({ kind, name, status }) => [kind, name, status])).toEqual([
      ["setup", "setup", "passed"],
      ["service", "api", "passed"],
    ]);
    expect(result.checks?.find((check) => check.name === "test")?.status).toBe("passed");
    expect(result.testExitCode).toBe(0);
    expect(await readFile(join(repo, ".ways", "runtime", "services", "api.log"), "utf8")).toContain("api listening");
    const pid = await pidOf(pidFile);
    await eventually(() => !alive(pid));
    expect(alive(bystander.pid!)).toBe(true);
    expect(await new GitRepository(repo).run(["status", "--porcelain", "--", ".ways/runtime"])).toBe("");
  });

  it("fails an evaluation whose service never becomes ready and kills it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ways-services-files-"));
    const pidFile = join(cwd, "idle.pid");
    const marker = join(cwd, "test-ran");
    const repo = await repository({
      required: ["test"],
      test: [node, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
      services: [{ name: "idle", command: service(pidFile, "setInterval(() => {}, 1000)"), ready: { tcp: { port: await freePort() } }, timeoutMs: 300 }],
    });
    const result = await runChecks(repo, false, undefined, { services: true });
    expect(result.environment?.[0]).toMatchObject({ name: "idle", status: "timed-out", detail: "Service did not become ready within 300ms" });
    expect(result.checks?.find((check) => check.name === "test")?.status).toBe("skipped");
    expect(result.testExitCode).toBe(1);
    expect(failedCheckDetails(result)[0]).toContain("service idle: timed-out");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const pid = await pidOf(pidFile);
    await eventually(() => !alive(pid));
  });

  it("reports services that crash before readiness or while checks run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ways-services-files-"));
    const early = await repository({
      required: ["test"],
      test: pass,
      services: [{ name: "crash", command: [node, "-e", "console.error('boom'); process.exit(3)"], ready: { command: [node, "-e", "process.exit(1)"] }, timeoutMs: 3_000 }],
    });
    const crashed = await runChecks(early, false, undefined, { services: true });
    expect(crashed.environment?.[0]).toMatchObject({ status: "failed", exitCode: 3, detail: "Service exited with code 3 before becoming ready", log: ".ways/runtime/services/crash.log" });
    expect(crashed.testExitCode).toBe(1);
    expect(await readFile(join(early, ".ways", "runtime", "services", "crash.log"), "utf8")).toContain("boom");

    const readyFile = join(cwd, "ready");
    const late = await repository({
      required: ["test"],
      test: [node, "-e", "setTimeout(() => {}, 1200)"],
      services: [{
        name: "flaky",
        command: [node, "-e", `require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "1"); setTimeout(() => process.exit(4), 800)`],
        ready: { command: [node, "-e", `process.exit(require("node:fs").existsSync(${JSON.stringify(readyFile)}) ? 0 : 1)`] },
        timeoutMs: 3_000,
      }],
    });
    const died = await runChecks(late, false, undefined, { services: true });
    expect(died.checks?.find((check) => check.name === "test")?.status).toBe("passed");
    expect(died.environment?.[0]).toMatchObject({ status: "failed", detail: "Service exited with code 4 while checks ran" });
    expect(died.testExitCode).toBe(1);
  });

  it("does not start services when setup fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ways-services-files-"));
    const pidFile = join(cwd, "never.pid");
    const repo = await repository({
      required: ["test"],
      test: pass,
      setup: [node, "-e", "process.exit(5)"],
      services: [{ name: "never", command: service(pidFile, ""), ready: { tcp: { port: 1 } } }],
    });
    const result = await runChecks(repo, false, undefined, { services: true });
    expect(result.environment).toEqual([{ kind: "setup", name: "setup", status: "failed", command: [node, "-e", "process.exit(5)"], exitCode: 5 }]);
    expect(result.checks?.find((check) => check.name === "test")?.status).toBe("skipped");
    await expect(readFile(pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills owned services when the harness is interrupted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ways-services-files-"));
    const pidFile = join(cwd, "svc.pid");
    const repo = await repository({
      required: ["test"],
      test: [node, "-e", "setTimeout(() => {}, 10000)"],
      services: [{ name: "svc", command: service(pidFile, "setInterval(() => {}, 1000)"), ready: { command: pass } }],
    });
    const cli = new URL("../dist/cli.js", import.meta.url).pathname;
    const child = spawn(node, [cli, "check", "--with-services"], { cwd: repo, stdio: "ignore" });
    await eventually(async () => (await readFile(pidFile, "utf8").catch(() => "")) !== "");
    const pid = await pidOf(pidFile);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const exited = new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    child.kill("SIGTERM");
    expect(await exited).toBe("SIGTERM");
    await eventually(() => !alive(pid));
  });

  it("refuses to finish quick work in an unhealthy environment", async () => {
    const repo = await repository({
      required: ["test"],
      test: pass,
      services: [{ name: "down", command: [node, "-e", "process.exit(7)"], ready: { command: [node, "-e", "process.exit(1)"] } }],
    });
    const git = new GitRepository(repo);
    await git.run(["add", "."]);
    await git.run(["commit", "-q", "-m", "bootstrap"]);
    await startQuick(repo, "health");
    await writeFile(join(repo, "change.txt"), "x\n");
    await expect(finishQuick(repo, "chore: change")).rejects.toThrow("service down: failed (Service exited with code 7 before becoming ready)");
  });

  it("records environment failures in validation failure evidence", () => {
    const withoutDigest = {
      schemaVersion: 1 as const,
      workId: "service-record",
      attempt: 0,
      phase: "validate" as const,
      inputCommit: "a".repeat(40),
      inputTree: "b".repeat(40),
      testCommand: pass,
      commands: { required: ["test"] as const, test: pass, services: [{ name: "api", command: pass, ready: { tcp: { port: 3000 } } }] },
      checks: {
        testExitCode: 1,
        integrity: [],
        named: [{ name: "test" as const, status: "skipped" as const, command: pass, detail: "Skipped because the environment is not healthy" }],
        environment: [{ kind: "service" as const, name: "api", status: "timed-out" as const, command: pass, detail: "Service did not become ready within 30000ms", log: ".ways/runtime/services/api.log" }],
      },
    };
    const record: ValidationFailureRecord = { ...withoutDigest, commands: { ...withoutDigest.commands, required: ["test"] }, digest: "" };
    record.digest = validationFailureDigest({ ...record, digest: undefined } as Omit<ValidationFailureRecord, "digest">);
    expect(validationFailureRecordFailure(record)).toBeUndefined();
  });

  it("validates the service contract", () => {
    const base = { schemaVersion: 1, harnessVersion: "0.1.0", testCommand: pass };
    expect(validateConfig({ ...base, commands: { required: ["test"], test: pass, setup: pass, services: [{ name: "db", command: pass, ready: { tcp: { port: 5432 } } }] } })).toBe(true);
    expect(validateConfig({ ...base, commands: { required: ["test"], services: [{ name: "db", command: pass, ready: { tcp: { port: 5432 }, http: "http://x" } }] } })).toBe(false);
    expect(validateConfig({ ...base, commands: { required: ["test"], services: [{ name: "Bad Name", command: pass, ready: { command: pass } }] } })).toBe(false);
  });
});
