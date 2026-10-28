# Branch protection and CI for a repository using ways

Local validation proves content and topology; it cannot stop an authorized or unauthorized direct push, and an agent with a shell can skip a Git hook with `--no-verify`. CI is the final judge: configure equivalent controls in your hosting provider for the repository's release branch (the one set as `memory.releaseBranch` in `.ways/config.json`, `main` by default) and, if you use one, its integration branch (`memory.integrationBranch`). Product names differ, but the policy is provider-neutral.

## Minimum

1. Run `scripts/check.sh` in CI on the exact proposed merge commit, with complete Git history (`fetch-depth: 0` on GitHub Actions). It runs integrity, your configured checks and the history audit, so a skipped hook still fails there.
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
      - run: scripts/check.sh
        env:
          # the audit must stop at the pull-request head, not at GitHub's synthetic merge commit
          WAYS_HISTORY_TO: ${{ github.event.pull_request.head.sha }}
```

`WAYS_HISTORY_TO` is only set on `pull_request` events; on `push`, leave it empty.

## Recommended

- Require an independent human reviewer on the pull request and dismiss approvals when content changes.
- Restrict branch deletion and administration bypasses, and audit emergency overrides.

## Only if you use release reconciliation

Release reconciliation (`ways memory reconcile ...`, with `reconcile/*` branches) adds merge-topology rules:

- require the reconciliation candidate, evidence, publication and back-sync validations below;
- serialize publication with a merge queue or an equivalent single-writer lock;
- require real merge commits and disable squash/rebase for reconciliation publication and release-to-integration back-sync.

CI supplies immutable SHAs rather than assuming local branch names:

```sh
ways memory reconcile validate "$EVIDENCE" \
  --state="$MEMORY_STATE" --reconcile="$RECONCILE_SHA" \
  --target="$RELEASE_SHA" --unresolved-claims='[]'
ways memory reconcile publication "$EVIDENCE" \
  --publication="$PUBLICATION_SHA" --reconcile="$RECONCILE_SHA"
ways memory reconcile back-sync --publication="$PUBLICATION_SHA" \
  --integration-before="$INTEGRATION_BEFORE_SHA" --back-sync="$BACK_SYNC_SHA"
```

Run candidate validation before merge, publication validation on the landed release merge and back-sync validation on the landed integration merge. The publication must have the release target as first parent and the reconciliation tip as second parent; back-sync must have the prior integration tip first and the publication second.

Required-check rules, reviewer identity, merge strategy and serialization are host configuration and cannot be guaranteed by workflow YAML alone.
