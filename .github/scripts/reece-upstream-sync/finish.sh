#!/usr/bin/env bash
# Daily upstream sync, last step: open or update the PR, then merge it or flag it.
#
#   STATUS=ok              -> merge the PR (merge commit) with UPSTREAM_SYNC_TOKEN,
#                             then make sure the Windows release run started.
#   STATUS=needs_attention -> leave the PR open, label it needs-attention, put the
#                             failing output in the body, and send ONE Slack alert
#                             (none again for the same PR unless the reason changes).
#
# Nothing here pushes to main or to upstream: every change reaches main through
# the PR. Never called with STATUS=ok unless every check passed.
#
# Env (all set by the workflow):
#   STATUS, REASON, BRANCH, PR (may be empty), BEHIND, AHEAD, HEAD_SHA,
#   TOUCHES_WINDOWS (true|false), CLAUDE_USED (true|false), SIMULATED (true|false),
#   REPORT_DIR (failure.log, decisions.md), RUN_URL, REPO (owner/name),
#   GH_TOKEN (UPSTREAM_SYNC_TOKEN: PR create/edit/merge, so the merge's push
#   event triggers windows-release.yml), ACTIONS_TOKEN (GITHUB_TOKEN: labels,
#   comments, run lookups, workflow dispatch), SLACK_WEBHOOK_URL (optional).
set -euo pipefail

: "${STATUS:?}" "${BRANCH:?}" "${HEAD_SHA:?}" "${REPO:?}"
REASON="${REASON:-}"
PR="${PR:-}"
REPORT_DIR="${REPORT_DIR:-.autosync/report}"
LABEL="needs-attention"
summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >> "$GITHUB_STEP_SUMMARY"; fi; echo "$1"; }
as_actions() { GH_TOKEN="$ACTIONS_TOKEN" "$@"; }

# ---- the PR body ------------------------------------------------------------
BODY_FILE="$(mktemp)"
{
  echo "Automated daily sync from [BasedHardware/omi](https://github.com/BasedHardware/omi) (\`.github/workflows/upstream-sync.yml\`, see \`docs/reece-fork.md\`)."
  echo
  echo "- Behind upstream by **${BEHIND:-?}** commits before this merge"
  echo "- Ahead by **${AHEAD:-?}** commits of our own (kept: merge commit, no rebase)"
  echo "- Branch head: \`${HEAD_SHA}\` · [workflow run](${RUN_URL:-})"
  echo
  if [ "$STATUS" = "ok" ]; then
    echo "**All checks passed** (pnpm install with verify-pimono-unpack, typecheck, lint, tests, Windows build). This PR merges itself."
  else
    echo "## ⚠️ Needs attention: ${REASON}"
    echo
    echo "Automation could not produce a passing build, so **nothing was merged**. Fix it on \`${BRANCH}\` and merge this PR by hand, or leave it: tomorrow's run reuses this PR (it keeps any commit a person pushes)."
    if [ -s "${REPORT_DIR}/failure.log" ]; then
      echo
      echo "<details open><summary>Failing output (last 80 lines)</summary>"
      echo
      echo '```'
      # shellcheck disable=SC2016 # literal backticks: keep a log line from closing the fence
      sed 's/```/` ` `/g' "${REPORT_DIR}/failure.log"
      echo '```'
      echo "</details>"
    fi
  fi
  if [ "${CLAUDE_USED:-false}" = "true" ]; then
    echo
    echo "## Claude's resolution"
    if [ -s "${REPORT_DIR}/decisions.md" ]; then cat "${REPORT_DIR}/decisions.md"; else echo "_Claude ran but left no notes._"; fi
  fi
  if [ "${SIMULATED:-false}" = "true" ]; then
    echo
    echo "_This run was a failure-path test (\`simulate_failure\`)._"
  fi
  # Upstream's Hygiene job checks the PR body (UI evidence, invariants,
  # failure class); pr-metadata.sh wrote the lines it needs in the sync job.
  echo
  if [ -s "${REPORT_DIR}/pr-metadata.md" ]; then
    cat "${REPORT_DIR}/pr-metadata.md"
  else
    echo "## Failure class (fixes)"
    echo
    echo "Failure-Class: none"
    echo
    echo "## UI evidence"
    echo
    echo "UI-Evidence: none -- automated upstream sync; each upstream PR carries its own UI evidence"
  fi
  echo
  echo "<!-- autosync-reason: ${REASON:-none} -->"
} > "$BODY_FILE"

if [ "$STATUS" = "ok" ]; then
  TITLE="chore(sync): upstream → main (${BEHIND:-?} commits)"
else
  TITLE="chore(sync): upstream → main (${BEHIND:-?} commits) — needs attention: ${REASON}"
fi

# ---- open or update ---------------------------------------------------------
OLD_BODY=""
if [ -n "$PR" ]; then
  OLD_BODY=$(gh pr view "$PR" --repo "$REPO" --json body --jq .body || true)
  # Keep the alert marker so a repeat of the same reason does not alert again.
  OLD_ALERTED=$(printf '%s' "$OLD_BODY" | sed -n 's/.*<!-- autosync-alerted: \(.*\) -->.*/\1/p' | tail -n 1)
  if [ -n "$OLD_ALERTED" ]; then echo "<!-- autosync-alerted: ${OLD_ALERTED} -->" >> "$BODY_FILE"; fi
  gh pr edit "$PR" --repo "$REPO" --title "$TITLE" --body-file "$BODY_FILE"
else
  URL=$(gh pr create --repo "$REPO" --base main --head "$BRANCH" --title "$TITLE" --body-file "$BODY_FILE")
  PR="${URL##*/}"
fi
PR_URL="https://github.com/${REPO}/pull/${PR}"
summary "### Sync PR: ${PR_URL}"

# ---- needs attention --------------------------------------------------------
if [ "$STATUS" != "ok" ]; then
  as_actions gh label create "$LABEL" --repo "$REPO" --color D93F0B \
    --description "Upstream sync could not produce a passing build" 2>/dev/null || true
  as_actions gh pr edit "$PR" --repo "$REPO" --add-label "$LABEL"

  ALERTED=$(printf '%s' "$OLD_BODY" | sed -n 's/.*<!-- autosync-alerted: \(.*\) -->.*/\1/p' | tail -n 1)
  if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
    summary "SLACK_WEBHOOK_URL is not set; no Slack alert sent."
  elif [ "$ALERTED" = "$REASON" ]; then
    summary "Already alerted for this PR with the same reason ($REASON); no repeat alert."
  else
    TEXT="Omi upstream sync needs attention: ${PR_URL}. Reason: ${REASON}."
    if curl -fsS -X POST -H 'Content-Type: application/json' \
      --data "$(jq -nc --arg t "$TEXT" '{text: $t}')" "$SLACK_WEBHOOK_URL" > /dev/null; then
      # Record what was alerted, so the next run with the same reason stays quiet.
      CUR=$(gh pr view "$PR" --repo "$REPO" --json body --jq .body | sed '/<!-- autosync-alerted: .* -->/d')
      printf '%s\n<!-- autosync-alerted: %s -->\n' "$CUR" "$REASON" > "$BODY_FILE"
      gh pr edit "$PR" --repo "$REPO" --body-file "$BODY_FILE"
      summary "Slack alert sent."
    else
      summary "::warning::The Slack alert failed to send."
    fi
  fi
  summary "Left open, labeled ${LABEL}. Reason: ${REASON}"
  exit 0
fi

# ---- merge ------------------------------------------------------------------
as_actions gh pr edit "$PR" --repo "$REPO" --remove-label "$LABEL" 2>/dev/null || true

# GitHub computes mergeability lazily; a just-opened PR can read "unknown".
MERGED=false
for attempt in 1 2 3 4 5 6; do
  if gh pr merge "$PR" --repo "$REPO" --merge --match-head-commit "$HEAD_SHA"; then
    MERGED=true
    break
  fi
  sleep $((attempt * 10))
done
if [ "$MERGED" != "true" ]; then
  # Branch protection that waits on the PR's own checks: let GitHub merge it
  # when they pass (needs "Allow auto-merge" on the repo).
  if gh pr merge "$PR" --repo "$REPO" --merge --auto --match-head-commit "$HEAD_SHA"; then
    summary "Direct merge refused; auto-merge enabled, so GitHub merges it when the PR's required checks pass. The Windows release starts then."
    exit 0
  fi
  echo "::error::Checks passed but GitHub refused the merge."
  STATUS=needs_attention REASON="merge refused by GitHub" PR="$PR" exec "$0"
fi

MERGE_SHA=$(gh pr view "$PR" --repo "$REPO" --json mergeCommit --jq .mergeCommit.oid)
summary "Merged ${PR_URL} as \`${MERGE_SHA}\`."

# ---- confirm the Windows release runs ---------------------------------------
# The merge was made with UPSTREAM_SYNC_TOKEN, so its push to main triggers
# windows-release.yml (a GITHUB_TOKEN merge would not). Confirm that, and
# dispatch the release ourselves if it never shows up.
if [ "${TOUCHES_WINDOWS:-false}" != "true" ]; then
  summary "No desktop/windows change in this sync; no Windows release expected."
  exit 0
fi
find_run() {
  as_actions gh run list --repo "$REPO" --workflow windows-release.yml --branch main --limit 30 \
    --json headSha,url,event --jq "map(select(.headSha == \"$MERGE_SHA\"))[0].url // empty"
}
RUN=""
for _ in $(seq 1 20); do
  RUN=$(find_run || true)
  if [ -n "$RUN" ]; then break; fi
  sleep 15
done
if [ -z "$RUN" ]; then
  echo "::warning::No windows-release run appeared for ${MERGE_SHA} after 5 minutes; dispatching it."
  as_actions gh workflow run windows-release.yml --repo "$REPO" --ref main
  for _ in $(seq 1 8); do
    sleep 15
    RUN=$(find_run || true)
    if [ -n "$RUN" ]; then break; fi
  done
fi
if [ -n "$RUN" ]; then
  summary "Windows release run: ${RUN}"
  as_actions gh pr comment "$PR" --repo "$REPO" --body "Merged on green. Windows release run: ${RUN}" || true
else
  echo "::error::Merged, but no Windows release run could be confirmed for ${MERGE_SHA}."
  exit 1
fi
