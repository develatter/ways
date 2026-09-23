# Reproducible evals

`ways evals run` runs a fixed functional corpus in a fresh disposable Git repository per task. The developer checkout is never passed to an adapter. Results are JSON and identify corpus revision, actual fixture Git revision, A/B harness label, model, seed, budgets, adapter argv, every session, functional checks, timings and usage availability.

```sh
npx ways evals run --adapter=fake --harness=checks-only --model=fake-model --revision=corpus-v2 --seed=7 --output=eval-result.json
```

Harness labels are `no-ways` (A), `checks-only` (B) and `full-sdd` (D). The label and `--model`, revision, seed and adapter argv are passed to every session and recorded unchanged. Results use `schemaVersion: 2` and record `waysRevision` (package and harness version, source Git revision when the runner is a clean checkout or `null` with a reason, and a content digest over `dist/` and `assets/`) plus `evidence.kind`: `fixture` for synthetic adapters such as `fake`, `real` otherwise.

## Full SDD (D)

With `--harness=full-sdd` the runner bootstraps the running Ways package into each disposable repository before any session: the task's regression checks become the configured test command, `node_modules/@develatter/ways` and `node_modules/.bin/ways` link to the running package (ignored by Git, so `npx ways` and the managed hook work offline), and the bootstrap is committed as the starting revision. Each prompt is prefixed with the recorded `harnessPrompt`, which asks the agent to deliver through `npx ways sdd start <task-id>` and every phase through close without downgrading or bypassing gates, reviews or checks. Adapters also receive `WAYS_EVAL_WAYS_BIN`. The runner never drives SDD itself; baseline repositories are unchanged.

After the last session every task is graded twice, independently:

- `success` is the functional grade from the corpus checks, exactly as for A/B.
- `compliance` is graded from the repository: history audit and integrity issues, uncommitted changes, a still-active work, SDD works started/closed, downgrades, remediation attempts and validation failures. `compliant` means no issues; `fullSddCompleted` additionally requires a certified close. For A/B it is `{ "applicable": false }`.

A task can therefore succeed while bypassing SDD, or comply while failing functionally; reports never merge the two.

## Observable metrics

Each task carries `metrics`, where every entry is `{ value, source, reason? }` and an unobservable value is `null` with a reason, never zero:

| Metric | Source |
| --- | --- |
| `toolCalls`, `contextCompactions`, `retries`, `humanInterventions`, `stalls` | adapter, summed across sessions only when every session reported it |
| `timeouts` | runner, sessions that hit the time budget |
| `resumeSuccess` | runner, only for fresh-session resume tasks |
| `remediationAttempts` | repository history, only for `full-sdd` |

Token and cost usage keep the `usage` semantics below.

## Comparing harnesses

```sh
npx ways evals compare --input=a.json --input=b.json --input=d.json --output=report.json --markdown=report.md
```

Every input is digested and listed with its path, sha256 and run id. Unparseable or pre-v2 results are `invalid`. A run is `non-comparable` when its corpus id or revision, model, seed, budgets, adapter or runner content digest differ from the reference run (the first valid real run, else the first valid run), when it mixes fixture and real evidence, or when it duplicates a run id. Only comparable runs are scored per harness: task success, regressions and incorrect done claims; compliance for `full-sdd`; and metric totals with available/unavailable counts and reasons. Each score lists its source artifacts and each task row points into its artifact (`/tasks/<index>`). The report always states `architecturalClaim: false`; fixture comparisons only exercise the runner and grader. The command exits 1 when no run is comparable.

## Manual real adapter

```sh
npx ways evals run --adapter=command --command=/path/to/real-harness \
  --arg=--non-interactive --harness=no-ways --model=my-model \
  --revision=corpus-v2 --seed=7 --timeout-ms=120000 --output=manual.json
```

The command runs with the disposable repository as its cwd. Environment variables provide `WAYS_EVAL_TASK_ID`, `WAYS_EVAL_REPOSITORY`, `WAYS_EVAL_SESSION`, `WAYS_EVAL_HARNESS`, `WAYS_EVAL_MODEL`, `WAYS_EVAL_STARTING_REVISION`, `WAYS_EVAL_PROMPT` and `WAYS_EVAL_SEED`. Print a final JSON line such as `{"doneClaim":true,"metrics":{"toolCalls":12,"contextCompactions":0}}`; `metrics` is optional and accepts only the adapter metric names above with non-negative integers or `null`. Optional `usage` fields are accumulated across sessions; if any session omits metrics, the task explicitly reports unavailable values as `null`, never zero.

Adapters are terminated as process trees on timeout or output-budget overflow (SIGTERM, then SIGKILL escalation) and the runner waits for process closure before cleanup. Each functional criterion is an argv command with exact expected exit/stdout/stderr, graded independently of done claims. Synthetic fake-adapter results are task-outcome evidence only and are not architectural benchmarks.
