#!/usr/bin/env bash
# Hermetic test for finish.sh: stub `gh` (a PR held in a file) and stub `curl`
# (Slack). Checks the needs-attention path: label, no merge, ONE alert per
# reason; and the green path: merge, then the Windows release run is confirmed.
# No network. Run: .github/scripts/reece-upstream-sync/test-finish.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/finish.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0
ok() { echo "ok - $1"; pass=$((pass + 1)); }
die() { echo "FAIL - $1"; exit 1; }

mkdir -p "$WORK/bin" "$WORK/report"
# gh stub. State: $WORK/body (PR body), $WORK/calls (one line per call).
cat > "$WORK/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "$*" >> "$STATE/calls"
case "$1 $2" in
  "pr create")
    if [ "${CREATE_FAILS:-0}" = 1 ]; then echo "a pull request for branch already exists" >&2; exit 1; fi
    cat "$(echo "$@" | sed -n 's/.*--body-file \([^ ]*\).*/\1/p')" > "$STATE/body"; echo "https://github.com/o/r/pull/42" ;;
  "pr list") echo 42 ;;
  "pr view")
    if [[ "$*" == *mergeCommit* ]]; then echo "mergesha"; else cat "$STATE/body" 2>/dev/null || true; fi ;;
  "pr edit")
    f=$(echo "$@" | sed -n 's/.*--body-file \([^ ]*\).*/\1/p')
    if [ -n "$f" ]; then cat "$f" > "$STATE/body"; fi ;;
  "pr merge") [ "${MERGE_FAILS:-0}" = 1 ] && exit 1; echo merged >> "$STATE/merged" ;;
  "run list") [ -f "$STATE/merged" ] && echo "https://github.com/o/r/actions/runs/9" ;;
  *) : ;;
esac
GH
cat > "$WORK/bin/curl" <<'CURL'
#!/usr/bin/env bash
echo "$*" >> "$STATE/slack"
CURL
cat > "$WORK/bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
exit 0
SLEEP
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH" STATE="$WORK"
export BRANCH=sync/upstream-2026-10-13 HEAD_SHA=abc REPO=o/r BEHIND=5 AHEAD=52 \
  REPORT_DIR="$WORK/report" RUN_URL=https://run GH_TOKEN=pat ACTIONS_TOKEN=gt \
  SLACK_WEBHOOK_URL=https://hooks.slack.test/x TOUCHES_WINDOWS=true
echo "error TS2345: boom" > "$WORK/report/failure.log"
reset() { rm -f "$WORK/body" "$WORK/calls" "$WORK/slack" "$WORK/merged"; }
slack_count() { if [ -f "$WORK/slack" ]; then wc -l < "$WORK/slack"; else echo 0; fi; }

# 1. A failing check, new PR: labeled, not merged, one alert, reason recorded.
reset
STATUS=needs_attention REASON="failing check: typecheck" PR="" "$SCRIPT" > /dev/null
grep -q -- "--add-label needs-attention" "$WORK/calls" || die "label not added"
grep -q "^pr merge" "$WORK/calls" && die "a failing build was merged"
[ "$(slack_count)" = 1 ] || die "expected one Slack alert"
grep -q "needs attention: https://github.com/o/r/pull/42. Reason: failing check: typecheck." "$WORK/slack" || die "alert text: $(cat "$WORK/slack")"
grep -q "error TS2345: boom" "$WORK/body" || die "failing output not in the PR body"
# No pr-metadata.md yet: the fallback still carries the lines upstream's Hygiene job needs.
grep -qx "UI-Evidence: none -- automated upstream sync; each upstream PR carries its own UI evidence" "$WORK/body" || die "fallback body lacks UI-Evidence"
grep -qx "Failure-Class: none" "$WORK/body" || die "fallback body lacks Failure-Class"
ok "needs-attention -> label, no merge, one alert with the PR link and reason"

# 2. Same PR, same reason next day: no second alert.
STATUS=needs_attention REASON="failing check: typecheck" PR=42 "$SCRIPT" > /dev/null
[ "$(slack_count)" = 1 ] || die "repeat alert for the same reason"
ok "same reason again -> no repeat alert"

# 3. Same PR, the reason changed: alert again.
STATUS=needs_attention REASON="conflict" PR=42 "$SCRIPT" > /dev/null
[ "$(slack_count)" = 2 ] || die "a new reason must alert"
ok "reason changed -> alerted again"

# 4. No webhook: no alert, still flagged.
reset
SLACK_WEBHOOK_URL="" STATUS=needs_attention REASON="conflict" PR="" "$SCRIPT" > /dev/null
[ "$(slack_count)" = 0 ] || die "alerted without a webhook"
grep -q -- "--add-label needs-attention" "$WORK/calls" || die "label not added"
ok "no webhook -> no alert, still labeled"

# 5. Green: merged with a merge commit on the checked head, release run confirmed,
#    and the body carries pr-metadata.md (the invariant citations it computed).
reset
printf '## Product invariants affected\n\nINV-TEST-1\n' > "$WORK/report/pr-metadata.md"
STATUS=ok REASON="" PR="" "$SCRIPT" > /dev/null
rm -f "$WORK/report/pr-metadata.md"
grep -qx "INV-TEST-1" "$WORK/body" || die "pr-metadata.md not carried into the PR body"
grep -q "^pr merge 42 --repo o/r --merge --match-head-commit abc" "$WORK/calls" || die "not merged as a merge commit on the head sha"
grep -q "^run list" "$WORK/calls" || die "release run not looked up"
grep -q "workflow run" "$WORK/calls" && die "dispatched although the run existed"
[ "$(slack_count)" = 0 ] || die "alerted on success"
ok "green -> merge commit, release run confirmed, no alert"

# 6. Green, but GitHub refuses both merges: flagged instead.
reset
MERGE_FAILS=1 STATUS=ok REASON="" PR="" "$SCRIPT" > /dev/null
grep -q -- "--add-label needs-attention" "$WORK/calls" || die "refused merge not flagged"
grep -q "Reason: merge refused by GitHub" "$WORK/slack" || die "refused merge not alerted"
ok "merge refused -> needs-attention"

# 7. The sync job missed an open PR (run 38313452502): create fails, the
#    existing PR is found, updated and merged instead of failing the run.
reset
CREATE_FAILS=1 STATUS=ok REASON="" PR="" "$SCRIPT" > /dev/null
grep -q "^pr edit 42 --repo o/r --title" "$WORK/calls" || die "existing PR not updated"
grep -q "^pr merge 42 --repo o/r --merge --match-head-commit abc" "$WORK/calls" || die "existing PR not merged"
ok "PR already exists -> found, updated and merged"

echo "all $pass passed"
