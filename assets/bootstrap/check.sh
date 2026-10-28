#!/usr/bin/env sh
# Managed by ways. The canonical local and CI check: integrity, configured checks, history audit.
set -eu
ways() {
  if [ -n "${WAYS_CLI:-}" ]; then node "$WAYS_CLI" "$@"; else npx --no-install ways "$@"; fi
}
ways check
if [ -n "${WAYS_HISTORY_TO:-}" ]; then
  ways check --history "--to=$WAYS_HISTORY_TO"
else
  ways check --history
fi
