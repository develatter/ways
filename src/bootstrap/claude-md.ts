/**
 * `CLAUDE.md` imports `AGENTS.md` instead of symlinking it: the import works
 * wherever Git does (a symlink degrades to a one-line text file on checkouts
 * without symlink support) and leaves room for Claude-specific notes below it.
 */
export const CLAUDE_MD_PATH = "CLAUDE.md";
export const CLAUDE_MD_IMPORT = "@AGENTS.md";
export const CLAUDE_MD_CONTENT = `${CLAUDE_MD_IMPORT}\n`;

export function claudeMdImportsAgents(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === CLAUDE_MD_IMPORT);
}

/** Existing notes are kept: the import is appended on its own line. */
export function withAgentsImport(content: string): string {
  if (claudeMdImportsAgents(content)) return content;
  return `${content}${content === "" || content.endsWith("\n") ? "" : "\n"}\n${CLAUDE_MD_IMPORT}\n`;
}
