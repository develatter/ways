# decompose

Goal: Decide task structure for implementation.
Evidence: Inline profile; the six plan steps share `src/evals/types.ts` and must land together to keep the build green.
Decision: No task worktrees; implement inline as one coherent change following the plan order, with tests alongside.
Gate: Decomposition complete.
