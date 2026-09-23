# plan

Goal: Order the implementation so each step is testable.
Evidence: The specification above; existing tests in `tests/evals.test.ts` and `tests/sdd-flow.test.ts`.
Decision:
1. Types: extend `HarnessLabel`, add `WaysRevision`, `ObservedMetric`, `TaskMetrics`, `HarnessCompliance`, adapter `metrics`, `synthetic` adapter flag and result schema 2 in `src/evals/types.ts`.
2. `src/evals/ways.ts`: package root resolution, revision capture, D repository preparation, compliance grading from history and integrity.
3. Runner and adapters: prepare D repos, harness prompt, env var, metric aggregation, evidence kind; command adapter parses `metrics`.
4. `src/evals/compare.ts` plus `ways evals compare` in `src/cli.ts` with JSON and Markdown output.
5. Tests: D with a programmatic SDD adapter (compliant), D with an adapter committing without SDD (non-compliant but functionally successful), metric parsing, comparison validity (invalid file, non-comparable run, fixture/real mix, artifact links), CLI.
6. Docs: `docs/EVALS.md` and README pointers.
Gate: Plan complete; implement inline.
