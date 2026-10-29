#!/usr/bin/env sh
# Managed by ways. The local and CI check: integrity and the configured checks, run once.
# Add --history (or WAYS_HISTORY=1) to also audit the work records, as CI does on pull requests.
set -eu
ways() {
  if [ -n "${WAYS_CLI:-}" ]; then node "$WAYS_CLI" "$@"; else npx --no-install ways "$@"; fi
}
ways check
if [ "${1:-}" = "--history" ] || [ "${WAYS_HISTORY:-}" = "1" ]; then
  if [ -n "${WAYS_HISTORY_TO:-}" ]; then ways check --history "--to=$WAYS_HISTORY_TO"; else ways check --history; fi
fi
