#!/usr/bin/env bash
# Daily upstream sync, step 2: the desktop/windows checks (Reece fork).
#
# The same commands as Desktop Windows CI's "Typecheck · Lint · Test" job, except
# the install is the FULL one: its postinstall runs verify-pimono-unpack, the
# drift check that broke `pnpm install` for a month before 2026-10-12. The real
# Windows package build runs in its own windows-latest job.
#
# Never exits non-zero for a failing check: the result is the report, so the
# workflow can decide what happens next (Claude fix, needs-attention).
#   <report>/failed_check  empty when every check passed, else the check's name
#   <report>/failure.log   the last 80 lines of the failing check's output
#
# Usage: checks.sh <report-dir>      Env: SIMULATE_FAILURE=true forces a failure.
set -uo pipefail

mkdir -p "$1"
REPORT="$(cd "$1" && pwd)"
: > "$REPORT/failed_check"
: > "$REPORT/failure.log"
cd "$(git rev-parse --show-toplevel)/desktop/windows" || exit 1

fail() {
  echo "$1" > "$REPORT/failed_check"
  tail -n 80 "$2" > "$REPORT/failure.log"
  echo "::error::Upstream sync check failed: $1"
  exit 0
}

step() {
  local name="$1"
  shift
  local log="$REPORT/step-${name}.log"
  echo "::group::${name}"
  "$@" > "$log" 2>&1
  local rc=$?
  cat "$log"
  echo "::endgroup::"
  if [ "$rc" -ne 0 ]; then fail "$name" "$log"; fi
}

# Electron's postinstall downloads a release archive; retry only the install,
# as the CI's Linux job does, so a CDN reset is not reported as a broken merge.
install_full() {
  local attempt
  for attempt in 1 2 3; do
    if pnpm install --frozen-lockfile; then return 0; fi
    if [ "$attempt" -eq 3 ]; then return 1; fi
    sleep $((attempt * 5))
  done
}

if [ "${SIMULATE_FAILURE:-false}" = "true" ]; then
  echo "Simulated failure requested (workflow_dispatch input simulate_failure)." > "$REPORT/step-simulated.log"
  fail "simulated failure" "$REPORT/step-simulated.log"
fi

step "pnpm install" install_full
step "typecheck" pnpm run typecheck
step "lint" pnpm run lint
step "test" pnpm test
echo "All desktop/windows checks passed."
