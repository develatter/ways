/**
 * How many tests a run executed, read from the summary line the common test
 * runners print last. It feeds the ratchet: fewer tests than on the base
 * counts as a change of the verifier surface. Undefined when no known
 * summary appears; the ratchet then says nothing rather than guess.
 */
const PATTERNS: Array<[RegExp, (match: RegExpMatchArray) => number]> = [
  // vitest: "Tests  12 passed | 1 failed (13)"; jest: "Tests:       1 failed, 12 passed, 13 total".
  [/^\s*Tests:?\s+(.*)$/m, (match) => countWords(match[1]!)],
  // node --test: "ℹ tests 12" / TAP "# tests 12"; mocha: "12 passing".
  [/^(?:ℹ|#)\s*tests\s+(\d+)\s*$/m, (match) => Number(match[1])],
  [/^\s*(\d+) passing\b.*$/m, (match) => Number(match[1])],
  // pytest: "===== 12 passed, 1 failed in 0.12s =====".
  [/^=+ (.*\b(?:passed|failed)\b.*) in [\d.]+s.*=+\s*$/m, (match) => countWords(match[1]!)],
  // cargo: "test result: ok. 12 passed; 0 failed; 1 ignored".
  [/^test result: \w+\. (\d+) passed; (\d+) failed/m, (match) => Number(match[1]) + Number(match[2])],
];

/** Executed tests in a vitest, jest or pytest summary: passed plus failed, never skipped or todo. */
function countWords(summary: string): number {
  let total = 0;
  for (const [, count, word] of summary.matchAll(/(\d+)\s+(passed|failed|failing|errors?)\b/g)) {
    if (word) total += Number(count);
  }
  return total;
}

export function testsRan(output: string | undefined): number | undefined {
  if (!output) return undefined;
  // The last summary wins: runners print per-file lines before it.
  const lines = output.split("\n");
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    const line = lines[start]!;
    for (const [pattern, count] of PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      const value = count(match);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
  }
  return undefined;
}
