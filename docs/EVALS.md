# Reproducible evals

`ways evals run` runs a fixed functional corpus in a fresh disposable Git repository per task. The developer checkout is never passed to an adapter. Results are JSON and identify corpus revision, actual fixture Git revision, harness label, model, seed, budgets, adapter argv, the outcome policy for E, every session, functional checks, timings and usage availability.

```sh
npx ways evals run --adapter=fake --harness=checks-only --model=fake-model --revision=corpus-v3 --seed=7 --output=eval-result.json
```

The label and `--model`, revision, seed and adapter argv are passed to every session and recorded unchanged. Results use `schemaVersion: 3` and record `waysRevision` (package and harness version, source Git revision when the runner is a clean checkout or `null` with a reason, and a content digest over `dist/` and `assets/`) plus `evidence.kind`: `fixture` for synthetic adapters such as `fake`, `real` otherwise. `corpus.digest` identifies the exact task content. When the runner is a checkout, `sourceRevisionReason` notes uncommitted source and that `dist/` is an untracked build.

## Configurations

| Letter | `--harness` | Repository | Prompt prefix (`harnessPrompt`) | Compliance graded from history |
| --- | --- | --- | --- | --- |
| A | `no-ways` | fixture only | none | not applicable |
| B | `checks-only` | fixture only | none | not applicable |
| C | `lightweight-state` | Ways installed | `ways quick start`, write `evidence/<task-id>.json`, `ways quick finish` | `quick-evidence` |
| D | `full-sdd` | Ways installed | `ways sdd start` and every phase through close | `sdd` |
| E | `outcome` | Ways installed | `ways outcome open` with the configured policies, evaluate, remediate, review, close | `outcome` |

A and B differ only in the label passed to the adapter, which decides what it runs. For C, D and E the runner bootstraps the running Ways package into each disposable repository before any session: the task's regression checks plus its environment checks become the configured test command, `node_modules/@develatter/ways` and `node_modules/.bin/ways` link to the running package (ignored by Git, so `npx ways` and the managed hook work offline), and the bootstrap is committed as the starting revision. Each prompt is prefixed with the recorded `harnessPrompt`. Adapters also receive `WAYS_EVAL_WAYS_BIN`. The runner never drives a workflow itself: every Ways command in a run comes from the agent.

Every configuration uses the shipped public CLI; none is a mock of a workflow:

- **C, lightweight state/evidence.** Ways state and mechanics without a process: a quick work traced by the commit hook, the configured checks run by `ways quick finish`, and an evidence file `evidence/<task-id>.json` of the form `{"schemaVersion":1,"task":"<task-id>","claims":[{"criterion":"…","evidence":"…"}]}` committed in the task's work. The evidence file is an eval convention, not a Ways artifact: it is the agent's own claim and is graded for presence and shape only. C has no immutable goal or criteria, no evaluation record, no review and no remediation record, which is exactly what separates it from E.
- **D, full SDD.** The certified phase chain, reviews and validation of SDD.
- **E, simplified execute/evaluate.** The outcome workflow (`open → execute → evaluate → close`): an immutable spec with criteria and policies, an evaluation record bound to the executed input, replayable failure and remediation records, and the review the evaluation policy requires.

### Outcome policies (E)

`--isolation=required|optional`, `--parallel=allowed|disabled`, `--evaluation=independent|self`, `--memory=none|normal|high` and `--approvals=none|close|close,remediate` (defaults are Ways' own: `required`, `allowed`, `independent`, `normal`, `none`) apply only to `--harness=outcome`; approvals other than `none` need a human running `ways approve` at a terminal during the run. The runner rejects them elsewhere. The effective policy is recorded as `configuration.outcomePolicy`, substituted into the prompt's `ways outcome open` flags, and exported to command adapters as `WAYS_EVAL_OUTCOME_POLICY` (JSON). The grader reads the policy the opening commit bound to Git and reports `eval-policy-mismatch` when the agent opened with anything else.

## Compliance

After the last session every task is graded twice, independently:

- `success` is the functional grade from the corpus checks, the same for every configuration.
- `compliance` is graded from the repository history after the recorded bootstrap revision, never from what the agent claims. For A/B it is `{ "applicable": false }`.

Every Ways configuration fails compliance on: history-audit issues (the audit of `ways check --history`, which replays SDD chains and outcome transitions, evaluations, failure records, remediations and closes), integrity issues, commits of another work (`eval-foreign-work`), changes to `.ways/config.json`, the manifest, managed hooks, `scripts/check.sh` or `AGENTS.md` (`eval-harness-tampered`), downgrades, uncommitted changes (`git status`) or a still-active work. Each workflow adds its own terminal state, reported as `completed`:

- `quick-evidence` (C): a quick work named after the task was finished, and `evidence/<task-id>.json` at HEAD is valid and was committed by the task's work (`eval-quick-not-finished`, `eval-evidence-invalid`, `eval-evidence-untraced`). SDD or outcome transitions for the task are `eval-workflow-mismatch`.
- `sdd` (D): an SDD work named after the task was certified through close (`eval-sdd-not-closed`). Ways' own memory and discovery commits are ordinary SDD evidence.
- `outcome` (E): the task's outcome was closed (`eval-outcome-not-closed`) with the configured policies. SDD transitions or a quick finish for the task are `eval-workflow-mismatch`.

`compliant` requires `completed` and no issue. The record also counts works started and closed, `remediationAttempts` (SDD remediation checkpoints or outcome remediations), `validationFailures` (SDD validation failures or failed outcome evaluations), `humanApprovals` (approval records of SDD gates and outcome checkpoints added in history) and `effectivePolicy`: the SDD profile and execution mode, the outcome's committed policy, or `null` for C, which has no policy record. If grading fails, or the task fails before grading, the functional grade is kept and compliance reports `eval-compliance-error`. The threat model is an honest agent that may skip or misuse the process; an agent that deliberately subverts Git (forged trailers with hooks disabled, rewritten history, replace refs) is beyond what local history proves, the same limit `ways check --history` documents.

A task can therefore succeed while bypassing its workflow, or comply while failing functionally; reports never merge the two.

## Task corpus

`assets/evals/corpus.json` (`corpus-v3`) holds six tasks. Each task has a `kind`:

| Kind | Task | What it probes |
| --- | --- | --- |
| `feature` | `add-export`, `preserve-api` | ordinary small changes |
| `resume` | `resume-session` | the first session stops early; a fresh session must resume and finish (`resumeSuccess`) |
| `failed-evaluation-remediation` | `remediate-slug` | the environment check rejects the obvious first attempt (no accent folding or trimming), so workflows that evaluate record a failure and remediate |
| `false-done-claim` | `false-done-total` | two stated requirements the visible environment check does not cover, so a passing check is not evidence of done |
| `concurrent-conflict` | `conflict-format` | two independent changes to the same statement; delivered as parallel units of work, the second integration conflicts and must be resolved |

`environmentChecks` are checks whose files are part of the task setup, visible to every configuration; C, D and E also run them through the configured test command. Success checks are held out and never shown to the agent. Each task result records `kind` and `environment` (`waysInstalled`, the configured `testCommand` or `null`, and the environment checks), so the commands every configuration could run are part of the evidence.

## Observable metrics

Each task carries `metrics`, where every entry is `{ value, source, reason? }` and an unobservable value is `null` with a reason, never zero:

| Metric | Source |
| --- | --- |
| `toolCalls`, `contextCompactions`, `retries`, `humanInterventions`, `stalls` | adapter, summed across sessions only when every session reported it |
| `timeouts` | runner, sessions that hit the time budget |
| `resumeSuccess` | runner, only for fresh-session resume tasks |
| `remediationAttempts`, `humanApprovals` | repository history, only for C, D and E |

Human intervention is quantified twice: `humanInterventions` as the adapter observed it (prompts answered, permissions granted, manual fixes) and `humanApprovals` as the approval records `ways approve` left in Git. Resource usage is `usage` (tokens and cost, below), `toolCalls`, per-task `elapsedMs` and the budgets in the configuration.

## Comparing configurations

```sh
npx ways evals compare --input=a.json --input=b.json --input=c.json --input=d.json --input=e.json --output=report.json --markdown=report.md
```

Every input is digested and listed with its path, sha256 and run id. Unreadable, unparseable, pre-v3 or structurally malformed results (including missing or non-numeric metrics) are `invalid`. A run is `non-comparable` when its corpus id, revision or content digest, model, seed, budgets, adapter or runner content digest differ from the reference run (the first valid real run, else the first valid run), when it mixes fixture and real evidence, when it duplicates a run id, or when its outcome policy differs from the first comparable run of the same harness. Several comparable runs of one harness are repetitions and are pooled.

The report (`schemaVersion: 2`) never collapses dimensions into one score. For each configuration present it gives:

- `taskSuccess`, and per task kind in `byKind`;
- `assurance`: regressions, incorrect done claims, `completedWithoutSuccess` (the workflow reported the task finished while functional grading failed) and a count per compliance issue code;
- `harnessCompliance`: workflow, compliant and completed rates, and the distinct effective policies observed;
- `time` (total, median and max task milliseconds) and `metrics` with available/unavailable counts and reasons. A metric `total` is present only when every task observed it; otherwise it is `null` and `observedTotal` holds the partial sum, which the Markdown labels as partial.

Every rate is `{ count, trials, rate, interval95 }`, where `interval95` is the 95% Wilson score interval over task runs; it treats each task run as an independent trial, which understates uncertainty when tasks differ in difficulty, so read it as a floor on uncertainty. `matrix` is the matched view: each task with, per configuration, successes over trials and compliant runs. `tasks` is the raw per-task evidence: kind, success, regressions, done-claim correctness, completion, compliance issue codes, time, tokens, cost, human interventions and remediation attempts, each with its artifact path and JSON pointer (`/tasks/<index>`). The report always states `architecturalClaim: false`; fixture comparisons only exercise the runner and grader. The command exits 1 when no run is comparable.

## Real runs

CI validates the runner, grader and report with deterministic fixture adapters only; it never makes paid model calls, and fixture results say nothing about harness quality. To compare configurations for real:

1. Build the exact Ways revision under test (`npm ci && npm run build`) from a clean checkout and keep it fixed for every run; `waysRevision.contentDigest` must match across inputs.
2. Write one adapter command for the agent under test. It runs with the disposable repository as cwd, reads `WAYS_EVAL_PROMPT` (already prefixed for C, D and E), `WAYS_EVAL_TASK_ID`, `WAYS_EVAL_REPOSITORY`, `WAYS_EVAL_SESSION`, `WAYS_EVAL_HARNESS`, `WAYS_EVAL_MODEL`, `WAYS_EVAL_STARTING_REVISION`, `WAYS_EVAL_SEED`, and for Ways configurations `WAYS_EVAL_WAYS_BIN` and, for E, `WAYS_EVAL_OUTCOME_POLICY`. It must run non-interactively, use the same model, tools and permissions for every configuration, and print a final JSON line such as `{"doneClaim":true,"usage":{"available":true,"totalTokens":1234,"costUsd":0.12},"metrics":{"toolCalls":12,"humanInterventions":0}}`. `doneClaim` is required; `usage` and `metrics` are optional and accept only the names above with non-negative integers or `null`.
3. Run every configuration with identical corpus revision, model, seed, budgets and adapter argv, at least five repetitions each, one output file per run:

   ```sh
   for harness in no-ways checks-only lightweight-state full-sdd outcome; do
     for rep in 1 2 3 4 5; do
       npx ways evals run --adapter=command --command=/path/to/agent --arg=--non-interactive \
         --harness=$harness --model=my-model --revision=corpus-v3 --seed=7 \
         --timeout-ms=900000 --max-output-bytes=4194304 --output=runs/$harness-$rep.json
     done
   done
   npx ways evals compare $(for file in runs/*.json; do printf -- '--input=%s ' "$file"; done) --output=report.json --markdown=report.md
   ```

   Add E variants (for example `--evaluation=self` or `--isolation=optional`) as separate batches; the report marks a second outcome policy as non-comparable, so compare each E variant with A–D in its own report.
4. Keep `runs/` and both reports together; every number in the report points back to a raw task entry. Check `runs[].status` before reading any score: a `non-comparable` run silently changes nothing, it is simply left out.

## Decision thresholds

One benchmark never switches a default. A lighter configuration (C or E) is a candidate to replace D only when, over at least five repetitions of the whole corpus with the same model and budgets, all of these hold:

- **No success regression.** Its success rate is not lower than D's by more than 5 percentage points, and the lower bound of its 95% interval is not below D's lower bound by more than 10 points. Each task kind with a D success of 3/5 or better keeps at least 3/5.
- **No new assurance violations.** Incorrect done claims and `completedWithoutSuccess` do not exceed D's counts, regressions stay at zero, and no compliance issue code appears that D does not show (for E, `eval-policy-mismatch` must be zero).
- **Assurance-specific tasks hold.** `remediate-slug` records its failed evaluation and remediation in history whenever the first attempt fails, `false-done-total` is never closed or finished while failing, `conflict-format` ends with both changes, and `resume-session` resumes in every repetition where D resumes.
- **A real saving.** Median task time or total cost (when every task reports cost) falls by at least 20%, and human interventions and approvals do not rise.

If any threshold is missed, or a metric it depends on is unavailable, the result is "no decision"; rerun with more repetitions or a better-instrumented adapter rather than relaxing a threshold after seeing the data.

## Usage and termination

Optional `usage` fields are accumulated across sessions; if any session omits them, the task explicitly reports unavailable values as `null`, never zero. Adapters are terminated as process trees on timeout or output-budget overflow (SIGTERM, then SIGKILL escalation) and the runner waits for process closure before cleanup. Each functional criterion is an argv command with exact expected exit/stdout/stderr, graded independently of done claims. Synthetic fake-adapter results are task-outcome evidence only and are not architectural benchmarks.
