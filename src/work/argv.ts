/**
 * Splits a verifier command line into argv without ever invoking a shell:
 * single and double quotes group, a backslash escapes the next character
 * outside single quotes, and nothing expands. Shell operators are refused
 * instead of being passed through, so `a && b` cannot silently become one
 * program with odd arguments. A JSON string array is accepted as is.
 */
export function parseCommandLine(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && !/^\[\s/.test(trimmed)) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new Error(`Verifier looks like a JSON array but is not valid JSON: ${trimmed}`);
    }
    if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || part === "")) {
      throw new Error("A JSON verifier must be a non-empty array of non-empty strings");
    }
    return value as string[];
  }
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      // As in POSIX shells, inside double quotes a backslash only escapes $ ` " \; elsewhere it stays.
      else if (character === "\\" && quote === "\"" && /[$`"\\]/.test(trimmed[index + 1] ?? "")) current += trimmed[++index];
      else current += character;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      started = true;
    } else if (character === "\\" && index + 1 < trimmed.length) {
      current += trimmed[++index];
      started = true;
    } else if (/\s/.test(character)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else if (/[|&;<>()`$]/.test(character)) {
      throw new Error(`Verifier "${trimmed}" uses the shell operator "${character}"; ways runs verifiers without a shell. Quote it, or put the pipeline in a script and verify with that script`);
    } else {
      current += character;
      started = true;
    }
  }
  if (quote) throw new Error(`Verifier "${trimmed}" has an unclosed ${quote} quote`);
  if (started) args.push(current);
  if (args.length === 0) throw new Error("Verifier command is empty");
  return args;
}

export function formatCommandLine(argv: readonly string[]): string {
  return argv.map((part) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(" ");
}
