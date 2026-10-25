#!/usr/bin/env bash
# Disable the upstream-only workflows (Reece fork, 2026-10-25).
#
# Upstream's deploy and monitoring workflows run here on every push and
# schedule, fail for want of Omi's secrets ("CODEMAGIC_API_TOKEN is required"),
# and email a failure each time. A workflow's enabled state lives in GitHub, not
# in the file, so disabling survives every upstream sync, and editing upstream's
# files (which the daily sync would merge back) is not needed.
#
# Idempotent: a workflow already disabled, or one upstream has since deleted, is
# skipped. Env: GH_TOKEN (actions: write), GITHUB_REPOSITORY, LIST (optional),
# DRY_RUN=true prints what would change.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
LIST="${LIST:-$(dirname "$0")/upstream-only-workflows.txt}"
DRY_RUN="${DRY_RUN:-false}"

states="$(gh api --paginate "repos/${REPO}/actions/workflows?per_page=100" \
  --jq '.workflows[] | "\(.path | split("/") | last) \(.state)"')"

disabled=0 already=0 missing=0
while IFS= read -r line; do
  file="${line%%#*}"
  file="$(echo "$file" | tr -d '[:space:]')"
  [ -n "$file" ] || continue
  state="$(awk -v f="$file" '$1 == f { print $2 }' <<< "$states")"
  if [ -z "$state" ]; then
    echo "skip  $file (not in this repo)"; missing=$((missing + 1)); continue
  fi
  if [ "$state" != "active" ]; then
    echo "ok    $file ($state)"; already=$((already + 1)); continue
  fi
  if [ "$DRY_RUN" = "true" ]; then
    echo "would disable $file"
  else
    gh workflow disable "$file" --repo "$REPO"
    echo "disabled $file"
  fi
  disabled=$((disabled + 1))
done < "$LIST"

summary="Disabled ${disabled}, already off ${already}, not present ${missing}."
echo "$summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Upstream-only workflows"; echo; echo "$summary"; } >> "$GITHUB_STEP_SUMMARY"
fi
