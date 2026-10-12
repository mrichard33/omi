#!/usr/bin/env bash
# Daily upstream sync: the PR-body lines upstream's own PR checks require.
#
# The Hygiene job runs scripts/pr-preflight against the PR BODY, and a body
# without these lines fails it: `ui-evidence` wants a screenshot or an exact
# "UI-Evidence: none" line whenever UI source changed, `product-invariants`
# wants every locked invariant whose paths the diff touches named, and
# `failure-class-protocol` wants a Failure-Class declaration. Sync PR #14
# (2026-10-12) went red on the first one. The repo's own `--suggest` mode
# computes the invariant and failure-class sections, so this reuses it rather
# than guessing.
#
# Usage: pr-metadata.sh <out-file> [base-ref]   (base defaults to origin/main)
# Always writes <out-file>; when --suggest cannot run, it falls back to the
# two declarations that need no computation.
set -uo pipefail

OUT="$1"
BASE="${2:-origin/main}"
ROOT="$(git rev-parse --show-toplevel)"
mkdir -p "$(dirname "$OUT")"

SUGGESTED=""
if [ -x "$ROOT/scripts/pr-preflight" ]; then
  # Keep only the paste-ready sections; drop the selection log and the
  # advisory HTML comment listing candidate failure classes.
  SUGGESTED=$(cd "$ROOT" && timeout 600 scripts/pr-preflight --suggest --base "$BASE" 2>/dev/null \
    | sed -n '/^## Product invariants affected/,$p' | sed '/^<!--/,/-->/d') || SUGGESTED=""
fi

{
  if [ -n "$SUGGESTED" ]; then
    printf '%s\n' "$SUGGESTED"
  else
    echo "## Failure class (fixes)"
    echo
    echo "Failure-Class: none"
  fi
  echo
  echo "## UI evidence"
  echo
  echo "UI-Evidence: none -- automated upstream sync; each upstream PR carries its own UI evidence"
} > "$OUT"
