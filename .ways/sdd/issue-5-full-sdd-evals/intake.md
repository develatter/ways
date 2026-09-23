# intake

Goal: Let an engineer compare current full SDD (harness D) with the no-ways (A) and checks-only (B) baselines on the same corpus with independent functional grading.
Evidence: Issue #5 has four acceptance criteria: run current SDD without bypassing gates/reviews/checks and capture the installed Ways revision; record tokens, tool calls, compactions, retries, remediation attempts, human interventions, stalls/timeouts and resume success where observable; expose unavailable provider metrics and invalid/non-comparable runs explicitly; produce a comparison report linking scores to raw artifacts and separating harness compliance from task success. Its only blocker, #4, is closed and provides `ways evals run` for A/B.
Decision: Proceed as autonomous inline SDD. Scope is the eval runner and a comparison report; synthetic fixture runs must stay labelled non-architectural and no claim of improvement is made from CI.
Gate: Accepted. The ticket is unblocked, implementation-sized and has concrete, testable criteria.
