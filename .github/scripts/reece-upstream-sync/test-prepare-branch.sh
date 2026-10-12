#!/usr/bin/env bash
# Hermetic test for prepare-branch.sh: throwaway local repos stand in for
# BasedHardware/omi and mrichard33/omi, and a stub `gh` stands in for GitHub.
# No network. Run: .github/scripts/reece-upstream-sync/test-prepare-branch.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/prepare-branch.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
g() { git -c init.defaultBranch=main -c commit.gpgsign=false "$@"; }
pass=0
ok() { echo "ok - $1"; pass=$((pass + 1)); }
die() { echo "FAIL - $1"; exit 1; }

# A stub gh: `gh pr list` prints whatever $FAKE_PRS holds (already jq-shaped).
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'GH'
#!/usr/bin/env bash
[ "$1 $2" = "pr list" ] && { printf '%s' "${FAKE_PRS:-}"; exit 0; }
echo "unexpected gh call: $*" >&2; exit 1
GH
chmod +x "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH"

# upstream: base + 2 new commits. origin (the fork): base + 1 Reece commit.
g init -q "$WORK/upstream"
( cd "$WORK/upstream" && echo base > a.txt && echo x > shared.txt && g add . && g commit -qm base )
g clone -q --bare "$WORK/upstream" "$WORK/origin.git"
( cd "$WORK/upstream" && echo u1 > b.txt && g add . && g commit -qm u1 && echo u2 >> b.txt && g commit -qam u2 )
g clone -q "$WORK/origin.git" "$WORK/seed"
( cd "$WORK/seed" && echo reece > r.txt && g add . && g commit -qm reece && g push -q origin main )

fresh_clone() {
  rm -rf "$WORK/fork"
  g clone -q "$WORK/origin.git" "$WORK/fork"
}
run() { (cd "$WORK/fork" && GITHUB_OUTPUT="$WORK/out" UPSTREAM_URL="$WORK/upstream" "$SCRIPT" > "$WORK/log" 2>&1) || { cat "$WORK/log"; die "$1: script failed"; }; }
outv() { sed -n "s/^$1=//p" "$WORK/out" | tail -n 1; }

# 1. Clean merge, no open PR: a new dated branch, a merge commit with the trailer.
fresh_clone; : > "$WORK/out"; FAKE_PRS="" run clean
[ "$(outv behind)" = 2 ] || die "behind should be 2"
[ "$(outv ahead)" = 1 ] || die "ahead should be 1"
[ "$(outv conflicted)" = false ] || die "clean merge should not conflict"
[ "$(outv mode)" = rebuild ] || die "new branch is a rebuild"
case "$(outv branch)" in sync/upstream-20*) ;; *) die "branch name: $(outv branch)" ;; esac
( cd "$WORK/fork"
  [ "$(git rev-list --parents -n 1 HEAD | wc -w)" = 3 ] || die "HEAD must be a merge commit"
  git log -1 --format=%B | grep -qxF 'Upstream-Autosync: true' || die "merge commit lacks the trailer"
  git merge-base --is-ancestor origin/main HEAD || die "our commits must stay in history" )
ok "clean merge -> dated branch, merge commit, trailer, our history kept"

# Publish that branch as an open PR left by an earlier run.
BR="$(outv branch)"
( cd "$WORK/fork" && git push -q origin "HEAD:refs/heads/$BR" )

# 2. Open sync PR whose commits are all automation's -> rebuilt from main, PR reused.
fresh_clone; : > "$WORK/out"; FAKE_PRS="7 $BR" run reuse
[ "$(outv pr)" = 7 ] || die "should reuse PR 7"
[ "$(outv branch)" = "$BR" ] || die "should reuse its branch"
[ "$(outv mode)" = rebuild ] || die "automation-only branch should be rebuilt"
[ -n "$(outv remote_sha)" ] || die "remote sha needed for the push lease"
ok "open automation PR -> reused and rebuilt"

# 3. A person pushed a fix to it -> extended, their commit kept.
( cd "$WORK/fork" && git checkout -q -B "$BR" "origin/$BR" && echo fix > human.txt && git add . \
  && git commit -qm "human fix" && git push -q origin "HEAD:refs/heads/$BR" )
fresh_clone; : > "$WORK/out"; FAKE_PRS="7 $BR" run human
[ "$(outv mode)" = extend ] || die "a person's commit must switch to extend"
( cd "$WORK/fork" && git log --format=%s | grep -qx "human fix" ) || die "the person's commit was dropped"
ok "a person's push -> extended, their commit kept"

# 4. Conflict: left IN PROGRESS for Claude, with the conflict list written.
( cd "$WORK/upstream" && echo upstream-side > shared.txt && g commit -qam "upstream edits shared" )
( cd "$WORK/seed" && git pull -q --no-rebase origin main && echo fork-side > shared.txt && g commit -qam "fork edits shared" && g push -q origin main )
fresh_clone; : > "$WORK/out"; FAKE_PRS="" run conflict
[ "$(outv conflicted)" = true ] || die "should report the conflict"
( cd "$WORK/fork"
  [ -f "$(git rev-parse --git-path MERGE_HEAD)" ] || die "merge must be left in progress"
  grep -qx shared.txt .autosync/conflicts.txt || die "conflict list missing shared.txt"
  git status --porcelain | grep -q '\.autosync' && die ".autosync must be git-excluded"
  true )
ok "conflict -> merge left in progress, conflict list written, scratch dir excluded"

# 5. Already current: behind 0, nothing else happens.
( cd "$WORK/seed" && git pull -q --no-rebase "$WORK/upstream" main 2>/dev/null || true
  git checkout -q --theirs shared.txt 2>/dev/null || true; git add -A; g commit -qm "take upstream" 2>/dev/null || true; g push -q origin main )
fresh_clone; : > "$WORK/out"; FAKE_PRS="" run current
[ "$(outv behind)" = 0 ] || die "should be current"
[ -z "$(outv branch)" ] || die "no branch when current"
ok "already current -> quiet exit"

echo "all $pass passed"
