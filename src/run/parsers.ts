/**
 * Reading a check's output so the agent gets the failures, not the log. One
 * parser per common tool, chosen by what the output looks like (the command
 * is often `npm test`, which says nothing about the runner); anything else
 * falls back to a generic reading. A parser that throws or finds nothing
 * never hides a failure: the generic reading takes over.
 */
export interface Counts {
  passed?: number;
  failed?: number;
  skipped?: number;
  /** Type, lint or compile errors (tsc, eslint, ruff, mypy, cargo build). */
  errors?: number;
  warnings?: number;
}

export interface Failure {
  /** What failed, stable between runs: `file > test name`, `nodeid`, `file:line CODE`. */
  id: string;
  /** Where, when the tool says: `path:line`. */
  where?: string;
  /** The first useful lines of the error. */
  lines: string[];
}

export interface Reading {
  tool: string;
  counts: Counts;
  failures: Failure[];
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(/\r\n?/g, "\n");
}

/** Lines of an error worth showing: not blank, not code frames or separators. */
function useful(lines: readonly string[], max: number): string[] {
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (/^\s*[⎯─━-]{6,}/.test(line) || /^\s*\d+\s*\|/.test(line) || /^\s*\|\s*\^/.test(line) || /^\s*>\s*\d+\s*\|/.test(line)) continue;
    kept.push(line.trim());
    if (kept.length >= max) break;
  }
  return kept;
}

const DETAIL_LINES = 6;

/** `12 passed`, `1 failed`, `3 skipped` anywhere in a summary line. */
function wordCounts(line: string): Counts {
  const counts: Counts = {};
  for (const [, count, word] of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo|errors?|warnings?|pending|xfailed|xpassed|deselected)\b/g)) {
    const value = Number(count);
    if (word === "passed" || word === "xpassed") counts.passed = (counts.passed ?? 0) + value;
    else if (word === "failed") counts.failed = (counts.failed ?? 0) + value;
    else if (word === "skipped" || word === "todo" || word === "pending" || word === "xfailed" || word === "deselected") counts.skipped = (counts.skipped ?? 0) + value;
    else if (word!.startsWith("error")) counts.errors = (counts.errors ?? 0) + value;
    else counts.warnings = (counts.warnings ?? 0) + value;
  }
  return counts;
}

function vitest(text: string): Reading | undefined {
  const summary = [...text.matchAll(/^\s*Tests\s{2,}(.+)$/gm)].at(-1);
  if (!summary && !/^\s*Test Files\s/m.test(text)) return undefined;
  const lines = text.split("\n");
  const failures: Failure[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*FAIL\s+(\S.*?)\s*$/.exec(lines[index]!);
    if (!match) continue;
    const block: string[] = [];
    let where: string | undefined;
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const line = lines[end]!;
      if (/^\s*FAIL\s+\S/.test(line) || /⎯{3,}\[\d+\/\d+\]⎯/.test(line) || /^\s*Test Files\s/.test(line)) break;
      const location = /^\s*❯\s+(\S+?):(\d+):\d+/.exec(line);
      if (location && !where && !location[1]!.includes("node_modules")) where = `${location[1]}:${location[2]}`;
      else if (!location) block.push(line);
    }
    // A suite that failed to load prints `FAIL file [ file ]`.
    const id = match[1]!.replace(/\s+\[\s*\S+\s*\]$/, "").replace(/\s+\d+ms$/, "");
    if (!failures.some((failure) => failure.id === id)) failures.push({ id, ...(where ? { where } : {}), lines: useful(block, DETAIL_LINES) });
    index = end - 1;
  }
  return { tool: "vitest", counts: summary ? wordCounts(summary[1]!) : {}, failures };
}

function jest(text: string): Reading | undefined {
  const summary = [...text.matchAll(/^Tests:\s+(.+)$/gm)].at(-1);
  if (!summary && !/^\s*●\s/m.test(text)) return undefined;
  const lines = text.split("\n");
  const failures: Failure[] = [];
  let file: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const suite = /^FAIL\s+(\S+)/.exec(line);
    if (suite) file = suite[1];
    const match = /^\s{2}●\s+(.+?)\s*$/.exec(line);
    if (!match || match[1] === "Console") continue;
    const block: string[] = [];
    let where: string | undefined;
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const next = lines[end]!;
      if (/^\s{2}●\s/.test(next) || /^(?:FAIL|PASS)\s/.test(next) || /^Test Suites:/.test(next)) break;
      const location = /\(([^()\s]+?):(\d+):\d+\)\s*$/.exec(next) ?? /^\s*at\s+([^()\s]+?):(\d+):\d+\s*$/.exec(next);
      if (location) {
        if (!where && !location[1]!.includes("node_modules")) where = `${location[1]}:${location[2]}`;
        continue;
      }
      block.push(next);
    }
    const name = match[1]!.replace(/ › /g, " > ");
    failures.push({ id: file ? `${file} > ${name}` : name, ...(where ? { where } : {}), lines: useful(block, DETAIL_LINES) });
    index = end - 1;
  }
  return { tool: "jest", counts: summary ? wordCounts(summary[1]!) : {}, failures };
}

function pytest(text: string): Reading | undefined {
  const summary = [...text.matchAll(/^=+ (.*\b(?:passed|failed|error|errors|skipped|no tests ran)\b.*) in [\d.]+s.*=+\s*$/gm)].at(-1);
  if (!summary && !/^=+ (?:FAILURES|ERRORS|test session starts) =+/m.test(text)) return undefined;
  const lines = text.split("\n");
  // Error lines (`E   ...`) and the location line of each section of FAILURES / ERRORS, by test name.
  const details = new Map<string, { lines: string[]; where?: string }>();
  let section: string | undefined;
  for (const line of lines) {
    const header = /^_{3,} (.+?) _{3,}\s*$/.exec(line);
    if (header) {
      section = header[1]!.replace(/^(?:ERROR at (?:setup|teardown) of|ERROR collecting) /, "");
      details.set(section, { lines: [] });
      continue;
    }
    if (/^=+ .* =+\s*$/.test(line)) section = /FAILURES|ERRORS/.test(line) ? undefined : "__end__";
    if (!section || section === "__end__") continue;
    const entry = details.get(section)!;
    const error = /^E\s{1,}(.*)$/.exec(line);
    if (error && entry.lines.length < DETAIL_LINES) entry.lines.push(error[1]!.trim());
    const location = /^(\S+\.py):(\d+): \w+/.exec(line);
    if (location) entry.where = `${location[1]}:${location[2]}`;
  }
  const failures: Failure[] = [];
  for (const line of lines) {
    const match = /^(FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.*))?$/.exec(line);
    if (!match) continue;
    const id = match[2]!;
    const name = id.split("::").slice(1).join(".") || id;
    const detail = details.get(name) ?? details.get(id.split("::").at(-1)!) ?? details.get(id);
    const message = match[3]?.trim();
    const shown = detail && detail.lines.length > 0 ? detail.lines : message ? [message] : [];
    if (!failures.some((failure) => failure.id === id)) failures.push({ id, ...(detail?.where ? { where: detail.where } : {}), lines: shown });
  }
  // Without the short summary (`-rN`), the section headers still name what failed.
  if (failures.length === 0) {
    for (const [name, detail] of details) failures.push({ id: name, ...(detail.where ? { where: detail.where } : {}), lines: detail.lines });
  }
  return { tool: "pytest", counts: summary ? wordCounts(summary[1]!) : {}, failures };
}

function cargo(text: string): Reading | undefined {
  const results = [...text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
  const compile = [...text.matchAll(/^error(?:\[(E\d+)\])?: (.+)$/gm)].filter((match) => !/^test failed|^could not compile|^aborting/.test(match[2]!));
  if (results.length === 0 && !(compile.length > 0 && /^\s+-->\s+\S+:\d+:\d+/m.test(text))) return undefined;
  const counts: Counts = {};
  for (const result of results) {
    counts.passed = (counts.passed ?? 0) + Number(result[1]);
    counts.failed = (counts.failed ?? 0) + Number(result[2]);
    counts.skipped = (counts.skipped ?? 0) + Number(result[3]);
  }
  const lines = text.split("\n");
  const failures: Failure[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^---- (\S+) stdout ----$/.exec(lines[index]!);
    if (!match) continue;
    const block: string[] = [];
    let where: string | undefined;
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const line = lines[end]!;
      if (/^---- \S+ stdout ----$/.test(line) || /^failures:\s*$/.test(line) || /^test result:/.test(line)) break;
      const panic = /panicked at (?:'.*?', )?(\S+?):(\d+):\d+/.exec(line);
      if (panic) where = `${panic[1]}:${panic[2]}`;
      if (/^note: run with `RUST_BACKTRACE/.test(line)) continue;
      block.push(line.replace(/^thread '.*?' panicked at \S+?:\d+:\d+:?\s*/, ""));
    }
    failures.push({ id: match[1]!, ...(where ? { where } : {}), lines: useful(block, DETAIL_LINES) });
    index = end - 1;
  }
  if (results.length === 0) {
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^error(?:\[(E\d+)\])?: (.+)$/.exec(lines[index]!);
      if (!match || /^(?:test failed|could not compile|aborting)/.test(match[2]!)) continue;
      const location = /^\s+-->\s+(\S+?):(\d+):\d+/.exec(lines[index + 1] ?? "");
      const where = location ? `${location[1]}:${location[2]}` : undefined;
      failures.push({ id: `${where ?? "build"} ${match[1] ?? "error"}`, ...(where ? { where } : {}), lines: [match[2]!] });
    }
    counts.errors = failures.length;
  }
  return { tool: "cargo", counts, failures };
}

function goTest(text: string): Reading | undefined {
  if (!/^(?:--- (?:FAIL|PASS|SKIP): |(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\)|\[build failed\]|\[setup failed\])|=== RUN\s)/m.test(text)) return undefined;
  const lines = text.split("\n");
  const failures: Failure[] = [];
  const counts: Counts = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const result = /^\s*--- (FAIL|PASS|SKIP): (\S+)/.exec(line);
    if (result) {
      if (result[1] === "PASS") counts.passed = (counts.passed ?? 0) + 1;
      else if (result[1] === "SKIP") counts.skipped = (counts.skipped ?? 0) + 1;
      else {
        counts.failed = (counts.failed ?? 0) + 1;
        const block: string[] = [];
        let where: string | undefined;
        for (let end = index + 1; end < lines.length; end += 1) {
          const next = lines[end]!;
          if (/^\s*--- (?:FAIL|PASS|SKIP):/.test(next) || /^(?:FAIL|ok|PASS)\b/.test(next) || /^=== RUN/.test(next)) break;
          const location = /^\s+(\S+_test\.go):(\d+): ?(.*)$/.exec(next);
          if (location && !where) where = `${location[1]}:${location[2]}`;
          block.push(location ? location[3]! : next);
        }
        failures.push({ id: result[2]!, ...(where ? { where } : {}), lines: useful(block, DETAIL_LINES) });
      }
      continue;
    }
    const build = /^FAIL\s+(\S+)\s+\[(build|setup) failed\]/.exec(line);
    if (build) {
      const errors = lines.slice(0, index).filter((candidate) => /^\S+\.go:\d+:\d+: /.test(candidate)).slice(-DETAIL_LINES);
      const where = /^(\S+\.go):(\d+)/.exec(errors[0] ?? "");
      failures.push({ id: `${build[1]} [${build[2]} failed]`, ...(where ? { where: `${where[1]}:${where[2]}` } : {}), lines: errors.map((error) => error.trim()) });
      counts.errors = (counts.errors ?? 0) + 1;
    }
  }
  return { tool: "go", counts, failures };
}

function tsc(text: string): Reading | undefined {
  const plain = [...text.matchAll(/^(\S.*?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)];
  const pretty = [...text.matchAll(/^(\S.*?):(\d+):(\d+) - error (TS\d+): (.+)$/gm)];
  const errors = plain.length > 0 ? plain : pretty;
  // "Found N errors" alone is ruff's too: tsc is recognised by its TS codes.
  if (!/error TS\d+:/.test(text)) return undefined;
  const found = /^Found (\d+) errors?/m.exec(text);
  const failures = errors.map((match) => ({ id: `${match[1]}:${match[2]} ${match[4]}`, where: `${match[1]}:${match[2]}`, lines: [match[5]!.trim()] }));
  return { tool: "tsc", counts: { errors: found ? Number(found[1]) : failures.length }, failures };
}

function eslint(text: string): Reading | undefined {
  const total = /^✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/m.exec(text);
  if (!total && !/^\s+\d+:\d+\s+(?:error|warning)\s{2,}/m.test(text)) return undefined;
  const failures: Failure[] = [];
  let file: string | undefined;
  for (const line of text.split("\n")) {
    if (/^(?:\/|[A-Za-z]:\\|\.{0,2}\/?\S+\.\w+$)/.test(line) && !/^\s/.test(line) && !line.startsWith("✖")) {
      file = line.trim();
      continue;
    }
    const match = /^\s+(\d+):\d+\s+(error|warning)\s{2,}(.+?)(?:\s{2,}(\S+))?\s*$/.exec(line);
    if (!match || match[2] !== "error" || !file) continue;
    failures.push({ id: `${file}:${match[1]} ${match[4] ?? "error"}`, where: `${file}:${match[1]}`, lines: [match[3]!.trim()] });
  }
  return { tool: "eslint", counts: total ? { errors: Number(total[2]), warnings: Number(total[3]) } : { errors: failures.length }, failures };
}

function ruff(text: string): Reading | undefined {
  const found = /^Found (\d+) errors?\./m.exec(text);
  const concise = [...text.matchAll(/^(\S+?):(\d+):\d+: ([A-Z]+\d+) (?:\[\*\] )?(.+)$/gm)];
  const lines = text.split("\n");
  const full: Failure[] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const head = /^([A-Z]+\d+) (?:\[\*\] )?(.+)$/.exec(lines[index]!);
    const location = /^\s*-->\s+(\S+?):(\d+):\d+/.exec(lines[index + 1]!);
    if (head && location) full.push({ id: `${location[1]}:${location[2]} ${head[1]}`, where: `${location[1]}:${location[2]}`, lines: [head[2]!.trim()] });
  }
  if (!found && concise.length === 0 && full.length === 0) return undefined;
  if (!found && concise.length === 0 && !/^\s*-->\s/m.test(text)) return undefined;
  const failures = concise.length > 0 ? concise.map((match) => ({ id: `${match[1]}:${match[2]} ${match[3]}`, where: `${match[1]}:${match[2]}`, lines: [match[4]!.trim()] })) : full;
  return { tool: "ruff", counts: { errors: found ? Number(found[1]) : failures.length }, failures };
}

function mypy(text: string): Reading | undefined {
  const found = /^Found (\d+) errors? in \d+ files?/m.exec(text);
  const success = /^Success: no issues found/m.test(text);
  const errors = [...text.matchAll(/^(\S+?\.pyi?):(\d+)(?::\d+)?: error: (.+?)(?:\s+\[([\w-]+)\])?$/gm)];
  if (!found && !success && errors.length === 0) return undefined;
  const failures = errors.map((match) => ({ id: `${match[1]}:${match[2]} ${match[4] ?? "error"}`, where: `${match[1]}:${match[2]}`, lines: [match[3]!.trim()] }));
  return { tool: "mypy", counts: { errors: found ? Number(found[1]) : failures.length }, failures };
}

const GENERIC_ERROR = /\b(?:error|errors|fail|failed|failure|panic|panicked|exception|traceback|fatal)\b/i;

/** Exit code, the lines that look like errors and the last lines: for tools ways does not know. */
export function generic(text: string, exitCode: number | undefined): Reading {
  if (exitCode === 0) return { tool: "generic", counts: {}, failures: [] };
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  const errors = [...new Set(lines.filter((line) => GENERIC_ERROR.test(line)))].slice(-8);
  const tail = lines.slice(-6).filter((line) => !errors.includes(line));
  return { tool: "generic", counts: {}, failures: [{ id: `exit ${exitCode ?? "?"}`, lines: [...errors, ...tail].map((line) => line.trim()).slice(-12) }] };
}

/** In order of how specific their markers are. */
const PARSERS: ReadonlyArray<[string, (text: string) => Reading | undefined]> = [
  ["vitest", vitest],
  ["jest", jest],
  ["pytest", pytest],
  ["cargo", cargo],
  ["go", goTest],
  ["tsc", tsc],
  ["mypy", mypy],
  ["eslint", eslint],
  ["ruff", ruff],
];

/** A parser named after the command's program goes first (`tsc`, `eslint`, ...). */
function ordered(command: readonly string[]): typeof PARSERS {
  const words = command.join(" ").toLowerCase();
  const hinted = PARSERS.filter(([name]) => new RegExp(`(^|[\\s/])${name === "go" ? "go test" : name}\\b`).test(words) || (name === "cargo" && /\bcargo\b/.test(words)));
  return [...hinted, ...PARSERS.filter((entry) => !hinted.includes(entry))];
}

/**
 * The reading of a run: the first parser that recognises the output, or the
 * generic one. A failed run whose parser found no failure gets the generic
 * reading's lines too, so a crash before the summary is never silent.
 */
export function readOutput(output: string, exitCode: number | undefined, command: readonly string[] = []): Reading {
  const text = stripAnsi(output);
  for (const [, parse] of ordered(command)) {
    let reading: Reading | undefined;
    try {
      reading = parse(text);
    } catch {
      reading = undefined;
    }
    if (!reading) continue;
    if (exitCode !== 0 && reading.failures.length === 0) {
      return { ...reading, failures: generic(text, exitCode).failures };
    }
    return reading;
  }
  return generic(text, exitCode);
}

export function renderCounts(counts: Counts): string {
  const parts: string[] = [];
  if (counts.passed !== undefined) parts.push(`${counts.passed} passed`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.errors !== undefined) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
  if (counts.warnings) parts.push(`${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`);
  return parts.join(", ");
}
