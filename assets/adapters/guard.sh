#!/usr/bin/env sh
# Managed by ways. Blocks agent-issued git commits when no harness work is active,
# blocks production writes in the main worktree during delegated SDD delivery phases
# and during outcome execution whose committed spec requires isolation,
# and blocks any tool write to human approvals or review verdicts (SDD and outcome).
# Redirections that write no file (2>&1, >/dev/null) are not treated as writes.
input="$(cat)"
command -v node >/dev/null 2>&1 || { echo "ways: node not found; refusing guarded tool use" >&2; exit 2; }
printf '%s' "$input" | exec node -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; }).on("end", () => {
  let event;
  try { event = JSON.parse(data); } catch { process.exit(0); }
  const tool = String(event.tool_name ?? "");
  const command = String(event.tool_input?.command ?? event.command ?? "");
  // Descriptor duplication (`2>&1`, `>&2`) and discards (`>/dev/null`, `2>/dev/null`, `&>/dev/null`) write no file.
  const shell = command.replace(/\d*>&[0-9-]+/g, " ").replace(/&?>>?\s*\/dev\/(?:null|stderr|stdout)\b/g, " ");
  const edits = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/.test(tool);
  const option = "(?:-[^\\s]+\\s+(?:[^-\\s][^\\s]*\\s+)?)*";
  const prefix = "(?:(?:command|exec|builtin)\\s+|[^\\s;&|(`]*/)?";
  const commits = new RegExp("(?:^|[;&|(`\\x22\\x27]\\s*|\\$\\(\\s*)" + prefix + "git\\s+" + option + "commit(?:\\s|$)", "m");
  const evidence = /(?:^|[\s/])\.ways\/(?:sdd\/[^\/\s]+\/(?:attempts\/[0-9]+\/)?(?:approvals|reviews)|outcomes\/[^\/\s]+\/(?:approvals|attempts\/[0-9]+\/reviews))(?:\/|$)/;
  const edited = event.tool_input?.file_path ?? event.tool_input?.notebook_path ?? event.tool_input?.path;
  const patch = String(event.tool_input?.patch ?? event.tool_input?.input ?? "");
  const patchPaths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((match) => match[1] ?? match[2]);
  const targetPaths = [typeof edited === "string" ? edited : undefined, ...patchPaths].filter((path) => typeof path === "string");
  const writes = /(?:>|\b(tee|cp|mv|rm|ln|dd|touch|install|rsync|truncate|vi|vim|nano|ed)\b|\bsed\b[^|;&]*\s-[a-zA-Z]*i|\b(?:python3?|node|perl|ruby|php|lua|awk)\b|\bgit\s+(?:apply|checkout|restore|reset)\b)/;
  const shellControl = /(?:[;&|`]|\$\()/;
  const waysCommand = /^\s*(?:(?:command|exec|env)\s+)*(?:npx(?:\s+--no-install)?\s+ways|node\s+(?:(?:\.?\/?|[^\s]+\/)dist\/)?cli\.js)\b/.test(command) && !shellControl.test(command);
  const { execFileSync } = require("node:child_process");
  const { existsSync, readFileSync, realpathSync } = require("node:fs");
  const { basename, dirname, join, resolve } = require("node:path");
  const cwd = String(event.cwd ?? process.cwd());
  let target = edits && typeof targetPaths[0] === "string" ? dirname(resolve(cwd, targetPaths[0])) : cwd;
  while (!existsSync(target) && dirname(target) !== target) target = dirname(target);
  let root;
  try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: target, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { process.exit(0); }
  const file = `${root}/.ways/status.json`;
  if (!existsSync(file)) process.exit(0);
  let status;
  try { status = JSON.parse(readFileSync(file, "utf8")); } catch { process.exit(0); }
  const resolvePath = (path) => {
    let candidate = resolve(cwd, String(path));
    const missing = [];
    while (!existsSync(candidate) && dirname(candidate) !== candidate) { missing.unshift(basename(candidate)); candidate = dirname(candidate); }
    try { return join(realpathSync(candidate), ...missing); } catch { return resolve(cwd, String(path)); }
  };
  const phaseArtifact = (path) => new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\.ways/sdd/[a-z0-9][a-z0-9-]{0,62}/(?:attempts/[1-9][0-9]*/)?(?:intake|explore|assess|specify|plan|decompose|implement|review|validate|reconcile-memory|close)\.md$`).test(resolvePath(path));
  const artifactRedirections = (allowed) => {
    const paths = [...shell.matchAll(/(?:>>|<>|>)\s*([^\s;&|]+)/g)].map((match) => match[1]?.replace(/^["\x27]|["\x27]$/g, ""));
    return paths.length > 0 && paths.every((path) => path && allowed(path));
  };
  const artifactTee = (allowed) => {
    const match = command.match(/\btee(?:\s+-[a-zA-Z]+)*\s+([^\s;&|]+)/);
    return Boolean(match?.[1] && allowed(match[1].replace(/^["\x27]|["\x27]$/g, "")) && !shellControl.test(command));
  };
  const artifactShellWrite = artifactRedirections(phaseArtifact) || artifactTee(phaseArtifact);
  if ((edits && targetPaths.some((path) => evidence.test(resolvePath(path)))) || (!edits && evidence.test(command) && writes.test(shell) && !waysCommand)) {
    process.stderr.write("ways: approvals and review verdicts under .ways/ are written only by `npx ways approve` (the human, in a terminal) and `npx ways review submit <review.json>`; write the review JSON elsewhere (e.g. .ways/runtime/review.json) and submit it\n");
    process.exit(2);
  }
  const protectedPhase = status.mode === "sdd" && status.execution === "delegated" && ["implement", "review", "validate"].includes(status.phase);
  if (protectedPhase && !existsSync(`${root}/.ways/runtime/task.json`)) {
    const productionEdit = edits && (targetPaths.length === 0 || targetPaths.some((path) => !phaseArtifact(path)));
    const productionShellWrite = !edits && writes.test(shell) && !waysCommand && !artifactShellWrite;
    if (productionEdit || productionShellWrite) {
      process.stderr.write("ways: delegated execution; the orchestrator must not write production files during implement, review, or validate. Use a task worktree or ways orchestration.\n");
      process.exit(2);
    }
  }
  const outcomeId = status.mode === "outcome" && status.stage === "execute" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(String(status.id)) ? status.id : undefined;
  const isolationRequired = () => {
    try {
      const spec = JSON.parse(execFileSync("git", ["show", `HEAD:.ways/outcomes/${outcomeId}/outcome.json`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      return spec?.policy?.isolation !== "optional";
    } catch { return true; }
  };
  if (outcomeId && !existsSync(`${root}/.ways/runtime/task.json`) && isolationRequired()) {
    const outcomeArtifact = (path) => [`${root}/.ways/outcomes/${outcomeId}/`, `${root}/.ways/runtime/`].some((prefix) => resolvePath(path).startsWith(prefix));
    const productionEdit = edits && (targetPaths.length === 0 || targetPaths.some((path) => !outcomeArtifact(path)));
    const productionShellWrite = !edits && writes.test(shell) && !waysCommand && !artifactRedirections(outcomeArtifact) && !artifactTee(outcomeArtifact);
    if (productionEdit || productionShellWrite) {
      process.stderr.write(`ways: outcome ${outcomeId} requires isolation; run \`npx ways task add <id> --title=<text>\` and \`npx ways task prepare <id>\`, implement in that worktree, then \`npx ways task integrate <id> --commits=<sha>\` (opened with --isolation=optional, direct commits would be allowed)\n`);
      process.exit(2);
    }
  }
  if (!edits && commits.test(command) && status.active === false) {
    process.stderr.write("ways: no active work; open one before committing: {{command:outcome}} for a delivery (`npx ways outcome open <id> --goal=<text> --criterion=<ID>:<text>`) or {{command:quick}} for a small change (`npx ways quick start <id>`)\n");
    process.exit(2);
  }
  process.exit(0);
});
'
