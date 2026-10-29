# Branch protection and CI for a repository using ways

Local checks prove content and topology; they cannot stop a direct push, and an agent with a shell can skip a Git hook (`WAYS_DISABLE=1`, or by changing `core.hooksPath`). CI is the final judge: configure equivalent controls in your hosting provider for the branch you release from. Product names differ, but the policy is provider-neutral.

## Minimum

1. Run `scripts/check.sh --history` in CI on the exact proposed merge commit, with complete Git history (`fetch-depth: 0` on GitHub Actions). It runs integrity and your configured checks once, then audits the work records: criteria unchanged since open, evidence bound to the commit it was recorded on, every closed tree equal to its evaluated tree, reviews and approvals bound. With `"enforcement": "enforce"` it also flags commits without a `Harness-Work` trailer.
2. Make that CI job a required check on the release branch.
3. Deny direct pushes and force pushes to it; require pull/merge requests.

For GitHub Actions, in a repository that has `@develatter/ways` as a dev dependency:

```yaml
jobs:
  ways:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      # the record audit runs on pull requests, over the branch's own commits
      - run: scripts/check.sh ${{ github.event_name == 'pull_request' && '--history' || '' }}
        env:
          # stop at the pull-request head, not at GitHub's synthetic merge commit
          WAYS_HISTORY_TO: ${{ github.event.pull_request.head.sha }}
```

`WAYS_HISTORY_TO` is only set on `pull_request` events.

## Recommended

- Require an independent human reviewer on the pull request and dismiss approvals when content changes.
- Restrict branch deletion and administration bypasses, and audit emergency overrides.
- Audit the pull request's own commits, as above. Any merge strategy works on the host, but a squash folds the record commits into one ordinary commit, so auditing the release branch's history after squash merges reports them as hand-made; a local `git merge --squash` of such a branch needs `WAYS_DISABLE=1` for its commit.

Required-check rules, reviewer identity, merge strategy and serialization are host configuration and cannot be guaranteed by workflow YAML alone.
