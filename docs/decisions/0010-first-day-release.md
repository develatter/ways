# 0010 — Ready for the first day: one smoke test, a clean tarball, any directory

- Status: accepted
- Date: 2026-10-29
- Decided by: the implementing agent, within the maintainer's brief (usable on day one; minimal ceremony; results verifiable; no harness on this repository yet)

## Context

Phases A–F were each tested on their own, through the source and the built CLI. Nothing checked that the product a consumer installs works as a whole: the brief at session start, a change, a delivery, a block, a question answered on the board, the wiki and the CI's judgement, in one repository, from the tarball. Looking at that tarball showed it shipped compiled SDD, plan and remediation modules that no source produced any more, left in `dist/` by earlier builds (466 files, 455 kB). And every command took the shell's directory for the repository root, so from a subdirectory `ways remember` wrote a stray `.ways/` and `ways done` said ways was not installed; outside any repository, `remember` wrote files in place.

## Decision

- **One smoke test is the product's acceptance test** (`tests/smoke-e2e.test.ts`, part of `npm test`, about 20 s): `npm pack`, install in a fresh repository, `ways bootstrap` with its defaults, then one session through Claude Code's hook payloads and pi's real extension, the board's API with its token, `ways wiki` and `ways verify --base`. It replaces the narrower packed-tarball test. It also fails when the tarball holds a source map or a module whose source is gone.
- **The build starts from an empty `dist/`**, and the package ships no source maps (they pointed at `src/`, which is not shipped). The tarball is now 192 files, 239 kB.
- **The CLI resolves the top of the working tree once**, so every command works from any directory of the repository; paths the user types (`--json=report.json`, `review submit <file>`) stay relative to where they typed them. Outside a repository every command but `evals`, `serve` and `adapter list` refuses and says what to do.
- **Dogfooding stays a proposal** ([docs/DOGFOODING.md](../DOGFOODING.md)): this repository still does not run ways on itself.
- Pre-releases publish under the `next` tag, never `latest`.

## Consequences

- A broken hook contract, adapter, board route or CI path fails one fast test that reads like the README.
- The smoke test needs `npm` and the npm cache (ajv, yaml) like the test it replaces; it does not need the network when the cache is warm.
- `ways` in a nested Git repository (a submodule) works on the innermost one, as Git does.
