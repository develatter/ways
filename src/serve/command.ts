import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gitDirs } from "../runtime/runtime.js";
import { configDir, LANGS, readRegistry, register, registryPath, userLang, type Lang } from "./config.js";
import { DemoSource } from "./demo.js";
import { LiveSource, type BoardSource } from "./live.js";
import { startServer, type RunningServer } from "./server.js";

export const DEFAULT_PORT = 7420;

interface OptionHelpers {
  option(args: readonly string[], name: string): string | undefined;
  options(args: readonly string[], name: string, spaced?: boolean): string[];
}

/** The main worktree of the repository at `path`: the registry names repositories, not worktrees. */
function mainWorktree(path: string): string {
  const dirs = gitDirs(path);
  return basename(dirs.common) === ".git" ? dirname(dirs.common) : dirs.top;
}

function openBrowser(url: string): void {
  // The URL is ours (loopback, port, random token): passed as an argument, never through a shell string.
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    spawn(command as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    // The URL is printed anyway.
  }
}

/** Starts the board, prints where it is, and runs until interrupted. */
export async function runServe(args: readonly string[], cwd: string, { option, options }: OptionHelpers): Promise<number> {
  const portOption = option(args, "--port");
  const port = portOption === undefined ? DEFAULT_PORT : Number(portOption);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a port number (0 picks a free one), got "${portOption}"`);
  const langOption = option(args, "--lang");
  if (langOption !== undefined && !(LANGS as readonly string[]).includes(langOption)) throw new Error(`--lang must be ${LANGS.join(" or ")}, got "${langOption}"`);
  const lang = (langOption as Lang | undefined) ?? userLang() ?? "en";
  const demo = args.includes("--demo");

  let source: BoardSource;
  let tokenFile: string | undefined;
  let summary: string;
  if (demo) {
    source = new DemoSource();
    summary = "Demo board: made-up repositories and agents; answers change nothing on disk.";
  } else {
    let here: string | undefined;
    try {
      here = mainWorktree(cwd);
    } catch {
      // Outside a repository: the registry alone.
    }
    const extra = options(args, "--repo").map((path) => {
      try {
        return mainWorktree(resolve(cwd, path));
      } catch {
        throw new Error(`--repo=${path} is not a Git repository`);
      }
    });
    const repos = register([...(here ? [here] : []), ...extra]).filter((path) => existsSync(path));
    if (repos.length === 0) throw new Error(`No repository to show: run \`ways serve\` inside a Git repository, or list repositories in ${registryPath()}`);
    const live = new LiveSource(repos);
    source = live;
    tokenFile = here ? join(gitDirs(cwd).common, "ways", "serve.json") : join(configDir(), "serve.json");
    summary = `Showing ${live.count} repositor${live.count === 1 ? "y" : "ies"}: ${repos.map((path) => basename(path)).join(", ")} (from ${registryPath()}; \`ways serve --repo=<path>\` adds one).`;
    if (readRegistry().length > repos.length) summary += " Registered paths that no longer exist are skipped.";
  }

  let server: RunningServer;
  try {
    server = await startServer({ source, port, lang, demo, ...(tokenFile ? { tokenFile } : {}) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (portOption !== undefined) throw new Error(`Port ${port} is in use; pick another with --port=<n>, or --port=0 for any free one`);
    server = await startServer({ source, port: 0, lang, demo, ...(tokenFile ? { tokenFile } : {}) });
  }
  console.log(`ways board: ${server.url}`);
  console.log(summary);
  if (tokenFile) console.log(`The token is in the URL and in ${tokenFile} (mode 0600). Only this machine can connect (127.0.0.1). Ctrl-C stops it.`);
  else console.log("Only this machine can connect (127.0.0.1). Ctrl-C stops it.");
  if (args.includes("--open")) openBrowser(server.url);

  await new Promise<void>((done) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (source instanceof DemoSource) source.stop();
      server.close().finally(done);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
