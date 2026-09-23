# assess

Goal: Decide the ceremony this change needs.
Evidence: The change adds a new harness label, repository preparation, a compliance grader, a metrics protocol, a result schema bump and a new `evals compare` CLI command, touching `src/evals/*`, `src/cli.ts`, docs and tests (roughly 500+ lines). It does not touch workflow gates, state, hooks or managed templates.
Decision: Keep full SDD, inline. No downgrade: the result schema and report are a public contract consumed by later tickets (#16, #17) and warrant explicit specification and review.
Gate: Assessed as SDD-sized; proceed to specify.
