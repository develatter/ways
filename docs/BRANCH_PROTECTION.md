# Branch protection and CI for a repository using ways

Local checks prove content and topology; they cannot stop a direct push, and an agent with a shell can skip a Git hook (`WAYS_DISABLE=1`, or by changing `core.hooksPath`) or tamper with its own checkout. CI is the final judge: configure equivalent controls in your hosting provider for the branch you release from. Product names differ, but the policy is provider-neutral.

## Minimum

1. Run `ways verify --base=<base sha>` in CI on every pull request, with complete Git history (`fetch-depth: 0` on GitHub Actions). It re-runs, from scratch, the base's checks on the head and every criterion verifier of the works the range touched (green on the head, red on each work's base); it fails when the range modifies or deletes an existing test or check file that no closed work had approved or accepted; and it audits the work records (criteria unchanged since open, evidence bound to the commit it was recorded on and to the base's checks, every closed tree equal to its evaluated tree, reviews attested, approvals bound and their signatures valid). With `"enforcement": "enforce"` it also flags commits without a `Harness-Work` trailer.
2. Make that CI job a required check on the release branch.
3. Deny direct pushes and force pushes to it; require pull/merge requests.

`ways bootstrap` writes `.github/workflows/ways.yml` for GitHub Actions; its core is:

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx --no-install ways verify --base="$BASE" --in-place --json=ways-report.json
        env:
          BASE: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}
```

`--in-place` evaluates the CI's own fresh checkout instead of creating another one (it is clean already); the Markdown report goes to the job summary and `--json` keeps a machine-readable copy. Adapt the install step to your package manager.

## Signed approvals

To make approvals require the human's key:

1. Commit `.ways/allowed_signers` (`<email> namespaces="ways-approval" <public key>`), in its own reviewed commit. Prefer a FIDO key (`sk-ssh-ed25519@openssh.com`): it needs a touch per signature, which an agent running as you cannot give.
2. Set `"approvals": {"signature": "required"}` in `.ways/config.json`.

The signature is verified against the file as committed in each work's base, so a change cannot add its own key; `ways verify` re-verifies every signature in the range, which needs `ssh-keygen` (OpenSSH 8.2+) on the runner.

## Recommended

- Require an independent human reviewer on the pull request and dismiss approvals when content changes.
- Restrict branch deletion and administration bypasses, and audit emergency overrides.
- Verify the pull request's own range, as above. Any merge strategy works on the host, but a squash folds the record commits into one ordinary commit, so verifying the release branch's history after squash merges reports them as hand-made; a local `git merge --squash` of such a branch needs `WAYS_DISABLE=1` for its commit.
- `scripts/check.sh` (integrity and the configured checks, with `--history` for the record audit) remains for local use and for CI without Node's `npx`.

Required-check rules, reviewer identity, merge strategy and serialization are host configuration and cannot be guaranteed by workflow YAML alone.
