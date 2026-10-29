#!/usr/bin/env bash
# Regenerates this fixture: a genuine ways 0.2.x repository, bootstrapped and
# used with the pre-lean CLI (`git checkout 572dcf2^ && npm run build`), saved
# as a git bundle plus the uncommitted state of an active quick work.
# Usage: generate.sh <path/to/pre-lean/dist/cli.js> <output-dir>
set -euo pipefail
CLI="$1"
OUT="$2"
WORK="$(mktemp -d)"
cd "$WORK"
git init -q -b main repo
cd repo
git config user.name "Fixture Dev"
git config user.email "dev@example.com"
git config commit.gpgSign false
mkdir -p src tests
printf 'export const refresh = (t) => t - 60;\n' > src/auth.js
printf 'import "../src/auth.js";\n' > tests/auth.test.js
printf '{"name":"fixture","version":"1.0.0","type":"module"}\n' > package.json
git add -A && git -c core.hooksPath=/dev/null commit -q -m "chore: initial project"

export WAYS_CLI="$CLI"
node "$CLI" bootstrap --test-command='["node","-e","process.exit(0)"]' > /dev/null
# The fixture represents a 0.2.x install.
sed -i 's/"harnessVersion": "[^"]*"/"harnessVersion": "0.2.2"/' .ways/config.json .ways/manifest.json
git add -A && git commit -q -m "chore: install ways 0.2.2"

# Durable memory with a coverage shard, written under a quick work.
node "$CLI" quick start add-memory > /dev/null
mkdir -p .ways/knowledge/conventions .ways/knowledge/coverage
cat > .ways/knowledge/conventions/token-refresh.md <<'EOF'
---
type: convention
title: Tokens refresh sixty seconds early
status: draft
---

Access tokens are refreshed 60 seconds before they expire; see `src/auth.js`.
EOF
cat > .ways/knowledge/coverage/auth.json <<'EOF'
{
  "classification": "concept-backed",
  "concepts": ["conventions/token-refresh"],
  "globs": ["src/**"],
  "id": "auth",
  "schemaVersion": 1
}
EOF
node "$CLI" quick finish --message="docs(memory): record the token refresh convention" > /dev/null

# A closed outcome with self evaluation and optional isolation.
node "$CLI" outcome open greeting --goal="Greet users" --criterion="AC1:greeting.txt says hi" --evaluation=self --isolation=optional > /dev/null
printf 'hi\n' > greeting.txt
git add greeting.txt
git commit -q -m "feat: greet users" -m "Harness-Work: greeting"
cat > .ways/outcomes/greeting/attempts/0/evidence.json <<'EOF'
{
  "attempt": 0,
  "criteria": {
    "AC1": {
      "summary": "greeting.txt contains hi"
    }
  },
  "schemaVersion": 1,
  "workId": "greeting"
}
EOF
node "$CLI" outcome evaluate > /dev/null
node "$CLI" outcome close > /dev/null

# An active quick work with an uncommitted edit, left for the upgrade.
node "$CLI" quick start padding > /dev/null
printf 'export const refresh = (t) => t - 30;\n' > src/auth.js

mkdir -p "$OUT"
git bundle create -q "$OUT/repo.bundle" --all
cp .ways/state/current.json "$OUT/active-state.json"
cp .ways/status.json "$OUT/active-status.json"
cp src/auth.js "$OUT/dirty-auth.js"
git log --format='%h %s | %(trailers:only,unfold,separator=%x2C)' > "$OUT/log.txt"
echo "fixture written to $OUT"
