#!/usr/bin/env bash
# Daily upstream sync, step 1: put upstream on a sync branch (Reece fork).
#
# Fetches BasedHardware/omi and, when main is behind, merges it into a
# sync/upstream-* branch with a MERGE COMMIT (never a rebase: the fork's own
# commits must stay in history, decision 2026-10-12).
#
# One sync PR at a time. When a sync PR is already open (usually one left
# needs-attention by an earlier day), its branch is reused instead of opening a
# second PR:
#   - every non-upstream commit on it was made by this automation
#     (trailer "Upstream-Autosync: true") -> REBUILD it from main, so yesterday's
#     failed attempt is not carried forward;
#   - a person has pushed to it -> EXTEND it (merge main, then upstream) so their
#     fix is kept.
#
# A conflicted upstream merge is left IN PROGRESS (not committed) so the next
# step can hand it to Claude. Writes GITHUB_OUTPUT: behind, ahead, branch, pr,
# mode, remote_sha, conflicted (true|false|main).
#
# Env: UPSTREAM_REF (default main), GH_TOKEN (for `gh pr list`),
#      UPSTREAM_URL (default the BasedHardware repo; tests override it).
set -euo pipefail

UPSTREAM_REF="${UPSTREAM_REF:-main}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/BasedHardware/omi.git}"
TRAILER="Upstream-Autosync: true"

out() {
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

# Scratch files for this run (conflict list, Claude's notes) never get committed.
mkdir -p .autosync
EXCLUDE="$(git rev-parse --git-path info/exclude)"
mkdir -p "$(dirname "$EXCLUDE")"
grep -qxF '.autosync/' "$EXCLUDE" 2>/dev/null || echo '.autosync/' >> "$EXCLUDE"

git remote add upstream "$UPSTREAM_URL" 2>/dev/null || git remote set-url upstream "$UPSTREAM_URL"
git fetch --no-tags --quiet upstream "$UPSTREAM_REF"
git fetch --no-tags --quiet origin main
UP="upstream/${UPSTREAM_REF}"

BEHIND=$(git rev-list --count "origin/main..${UP}")
AHEAD=$(git rev-list --count "${UP}..origin/main")
out behind "$BEHIND"
out ahead "$AHEAD"
if [ "$BEHIND" = "0" ]; then
  echo "Already current: main has everything upstream has."
  exit 0
fi

# Newest open sync PR, if any.
EXISTING=$(gh pr list --base main --state open --limit 100 --json number,headRefName \
  --jq '[.[] | select(.headRefName | startswith("sync/upstream-"))] | sort_by(.number) | last
        | if . == null then "" else "\(.number) \(.headRefName)" end')

PR=""
REMOTE_SHA=""
if [ -n "$EXISTING" ]; then
  PR="${EXISTING%% *}"
  BRANCH="${EXISTING#* }"
else
  BRANCH="sync/upstream-$(date -u +%Y-%m-%d)"
fi

if git fetch --no-tags --quiet origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" 2>/dev/null; then
  REMOTE_SHA=$(git rev-parse "origin/${BRANCH}")
fi

MODE="rebuild"
if [ -n "$PR" ] && [ -n "$REMOTE_SHA" ]; then
  # Commits on the branch that are neither main's nor upstream's: ours or a person's.
  for c in $(git rev-list "origin/${BRANCH}" --not origin/main "$UP"); do
    if ! git log -1 --format=%B "$c" | grep -qxF "$TRAILER"; then
      MODE="extend"
      break
    fi
  done
fi

out branch "$BRANCH"
out pr "$PR"
out mode "$MODE"
out remote_sha "$REMOTE_SHA"

if [ "$MODE" = "extend" ]; then
  echo "A person has pushed to ${BRANCH}; keeping their commits."
  git checkout -q -B "$BRANCH" "origin/${BRANCH}"
  if ! git merge --no-ff --no-edit -m "chore(sync): bring origin/main into ${BRANCH}

${TRAILER}" origin/main; then
    git merge --abort
    out conflicted main
    echo "::warning::origin/main no longer merges into ${BRANCH}; a person must update it."
    exit 0
  fi
else
  git checkout -q -B "$BRANCH" origin/main
fi

MSG="chore(sync): merge upstream/${UPSTREAM_REF} into main (${BEHIND} commits behind, ${AHEAD} ahead)

${TRAILER}"
if git merge --no-ff -m "$MSG" "$UP"; then
  out conflicted false
else
  out conflicted true
  git diff --name-only --diff-filter=U | tee .autosync/conflicts.txt
fi
