import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fastHash } from "../runtime/lazy.js";
import type { Lang } from "./config.js";
import { NotFound, type BoardSource } from "./live.js";

/**
 * `ways serve`: the board and the inbox on 127.0.0.1, with `node:http` only.
 *
 * Who may talk to it: a request must name a loopback host (`Host`, against
 * DNS rebinding), carry no foreign `Origin` or cross-site `Sec-Fetch-Site`,
 * and present the token (a 256-bit random value, compared in constant time)
 * as `Authorization: Bearer`, `X-Ways-Token` or the `SameSite=Strict`,
 * `HttpOnly` cookie the first visit sets. Only a GET may bring it in the
 * query string (the printed URL); a mutation needs the header or the cookie,
 * a JSON body (which a form cannot send cross-origin without a preflight,
 * and the server answers no preflight: no CORS at all) and at most 16 KiB.
 *
 * The limit: the token keeps browsers and other sites out, not the user's
 * own agents, which can read `serve.json`. That is why a work's approval
 * from the board is refused where the base requires SSH signatures.
 */
export interface ServeOptions {
  source: BoardSource;
  /** 0 picks a free port. */
  port: number;
  lang: Lang;
  demo?: boolean;
  /** Where to write `{url, port, token, pid}` with mode 0600. */
  tokenFile?: string;
  /** How often the board is re-derived when no watched directory signalled a change. */
  pollMs?: number;
  token?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  /** Re-derives the board now and pushes it to the open pages if it changed. */
  refresh(): Promise<void>;
  close(): Promise<void>;
}

export const MAX_BODY_BYTES = 16 * 1024;
const MAX_CLIENTS = 32;
const HEARTBEAT_MS = 15_000;

export function uiPath(): string {
  return fileURLToPath(new URL("../../assets/ui/index.html", import.meta.url));
}

/** The token, compared in constant time over digests of equal length. */
export function tokenMatches(given: string | undefined | null, token: string): boolean {
  if (!given) return false;
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(token).digest());
}

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Only loopback names with this server's port: a rebinding DNS name never matches. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return LOOPBACK.some((name) => host.toLowerCase() === `${name}:${port}`);
}

export function originAllowed(origin: string, port: number): boolean {
  return LOOPBACK.some((name) => origin.toLowerCase() === `http://${name}:${port}`);
}

function cookieToken(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** CSP hashes of the page's inline script and style: nothing else runs or styles it. */
function cspFor(html: string): string {
  const hashes = (tag: string): string[] => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => `'sha256-${createHash("sha256").update(match[1]!).digest("base64")}'`);
  return [
    "default-src 'none'",
    `script-src ${hashes("script").join(" ")}`,
    `style-src ${hashes("style").join(" ")}`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, `Body over ${MAX_BODY_BYTES} bytes`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop keeping it; the rest is read and dropped, and the connection closes after the answer.
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, `Body over ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        resolve(value);
      } catch {
        reject(new HttpError(400, "The body must be a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

function text(value: unknown, max = 4000): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const token = options.token ?? randomBytes(32).toString("base64url");
  const html = readFileSync(uiPath(), "utf8");
  const csp = cspFor(html);
  const clients = new Set<ServerResponse>();
  let port = 0;
  let cookieName = "ways_token";
  let version = 0;
  let current = { body: "", hash: "" };
  let refreshing: Promise<void> | undefined;
  let again = false;

  const derive = async (): Promise<void> => {
    const state = await options.source.state();
    const payload = { ...state, lang: options.lang, demo: options.demo === true };
    const hash = fastHash(JSON.stringify({ ...payload, generatedAt: "" }));
    if (hash === current.hash) return;
    version += 1;
    current = { body: JSON.stringify(payload), hash };
    for (const client of clients) client.write(`id: ${version}\nevent: state\ndata: ${current.body}\n\n`);
  };

  /** One derivation at a time; a request made during one runs once more after it. */
  const refresh = async (): Promise<void> => {
    if (refreshing) {
      again = true;
      return refreshing;
    }
    refreshing = (async () => {
      try {
        do {
          again = false;
          await derive();
        } while (again);
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": typeof body === "string" && status === 200 ? "text/html; charset=utf-8" : "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
    res.end(data);
  };

  const fail = (res: ServerResponse, status: number, message: string): void => send(res, status, { error: message });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    res.setHeader("cross-origin-resource-policy", "same-origin");
    if (!hostAllowed(req.headers.host, port)) return fail(res, 403, `Forbidden host: open http://127.0.0.1:${port}/ (the URL \`ways serve\` printed)`);
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin, port)) return fail(res, 403, "Forbidden origin: the board only answers its own page");
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return fail(res, 403, "Cross-site request refused");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "POST") return fail(res, 405, "Only GET and POST");
    const authorization = req.headers.authorization;
    const presented = (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined) ?? (req.headers["x-ways-token"] as string | undefined) ?? cookieToken(req.headers.cookie, cookieName);
    const queryToken = method === "GET" ? url.searchParams.get("token") : null;
    const viaQuery = !tokenMatches(presented, token) && tokenMatches(queryToken, token);
    if (!tokenMatches(presented, token) && !viaQuery) {
      return fail(res, 401, "Missing or wrong token: open the URL `ways serve` printed (its token is also in serve.json, next to the inbox)");
    }
    if (viaQuery) res.setHeader("set-cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);

    if (method === "GET") {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.setHeader("content-security-policy", csp);
        return send(res, 200, html);
      }
      if (url.pathname === "/api/state") {
        // A direct read is always current, whatever the poll has seen.
        await refresh();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(current.body);
        return;
      }
      if (url.pathname === "/events") {
        if (clients.size >= MAX_CLIENTS) return fail(res, 503, "Too many open pages");
        if (!current.body) await refresh();
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(`retry: 2000\nid: ${version}\nevent: state\ndata: ${current.body}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      return fail(res, 404, "Not found");
    }

    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return fail(res, 415, "Mutations take a JSON body (Content-Type: application/json)");
    const body = await readBody(req) as Record<string, unknown>;
    const inbox = /^\/api\/inbox\/([A-Za-z0-9_-]{1,80})\/(answer|close)$/.exec(url.pathname);
    if (inbox) {
      const [, id, action] = inbox;
      if (action === "answer") await options.source.answer(id!, { ...(text(body.text) ? { text: text(body.text)! } : {}), ...(text(body.choice, 80) ? { choice: text(body.choice, 80)! } : {}) });
      else await options.source.close(id!, text(body.reason, 300));
    } else if (url.pathname === "/api/tell") {
      const instruction = text(body.text);
      const repo = text(body.repo, 64);
      if (!instruction || !repo) throw new HttpError(400, "An instruction needs {repo, text} and, optionally, worktree, session or work");
      await options.source.tell({ repo, text: instruction, ...(text(body.worktree, 4096) ? { worktree: text(body.worktree, 4096)! } : {}), ...(text(body.session, 200) ? { session: text(body.session, 200)! } : {}), ...(text(body.work, 64) ? { work: text(body.work, 64)! } : {}) });
    } else if (url.pathname !== "/api/refresh") {
      return fail(res, 404, "Not found");
    }
    await refresh();
    return send(res, 200, { ok: true });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      const status = error instanceof HttpError ? error.status : error instanceof NotFound ? 404 : 409;
      if (status === 413) res.setHeader("connection", "close");
      fail(res, status, error instanceof Error ? error.message : String(error));
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  // Cookies ignore ports: one name per board, so two boards never overwrite each other's.
  cookieName = `ways_token_${port}`;
  const url = `http://127.0.0.1:${port}/?token=${token}`;

  if (options.tokenFile) {
    mkdirSync(dirname(options.tokenFile), { recursive: true });
    const temporary = `${options.tokenFile}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ v: 1, url, port, token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, options.tokenFile);
  }

  await refresh();
  const watchers: FSWatcher[] = [];
  let debounce: NodeJS.Timeout | undefined;
  const soon = (): void => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      refresh().catch(() => undefined);
    }, 60);
  };
  const watching = new Set<string>();
  const watchNew = (): void => {
    for (const dir of options.source.watched()) {
      if (watching.has(dir)) continue;
      try {
        watchers.push(watch(dir, { persistent: false }, soon));
        watching.add(dir);
      } catch {
        // Not there yet (no event or inbox item so far): the next poll tries again.
      }
    }
  };
  watchNew();
  const poll = setInterval(() => {
    watchNew();
    refresh().catch(() => undefined);
  }, options.pollMs ?? 1000);
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": ping\n\n");
  }, HEARTBEAT_MS);

  return {
    url,
    port,
    token,
    refresh,
    close: async () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      if (debounce) clearTimeout(debounce);
      for (const watcher of watchers) watcher.close();
      for (const client of clients) client.end();
      clients.clear();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      if (options.tokenFile) {
        try {
          if ((JSON.parse(readFileSync(options.tokenFile, "utf8")) as { token?: string }).token === token) rmSync(options.tokenFile, { force: true });
        } catch {
          // Already gone.
        }
      }
    },
  };
}
