# The Reece fork of Omi

How this fork is laid out, why, and the two things that waste an afternoon if
nobody tells you.

## Which repo is which (2026-10-03)

| Repo | What it is |
|---|---|
| `mrichard33/omi` | **This repo.** A standalone copy of [BasedHardware/omi](https://github.com/BasedHardware/omi) (not a GitHub fork), created 2026-09-20. Everything builds from here. |
| `mrichard33/omi-desktop-releases` | Where the Windows installers and update feed are published. No source. |
| `mrichard33/omi-old` | The original GitHub fork, last pushed 2026-09-15. Nothing builds from it or points at it; kept as history. |

**Your data does not go to either repo.** Every app (Windows, Mac, phone) signs in
with Omi's Firebase project and talks to Omi's hosted backend (`api.omi.me`). So
`backend/` changes made here are not live for us unless Omi ships them too. Daily
summaries are made by that hosted backend; the Windows build fills any day it
skipped (`desktop/windows/src/renderer/src/lib/dailySummaryCatchup.ts`).

## The layout

`main` carries Reece's own commits (the Windows desktop work, merged through PRs)
on top of upstream. Upstream changes arrive only through the weekly sync PR below.

These three files are on `main` on purpose:

| File | Why it must be on main |
|---|---|
| `.github/workflows/upstream-sync.yml` | A `schedule` trigger only runs from the default branch. On a branch it would never fire. |
| `scripts/push-all.ps1` | It has to be there in a fresh clone, before you have checked anything out. |
| `docs/reece-fork.md` | This file. It is no use on a branch you have not found yet. |

Other Reece work lands on `main` through PRs; a merge that touches
`desktop/windows/**` publishes a new Windows build (see below).

### The three worktrees

| Worktree | What lives there |
|---|---|
| `omi` | the main checkout |
| `omi-win-fixes` | Windows desktop fixes |
| `omi-ptt-budget` | push-to-talk and budget work |

`pwsh -File scripts/push-all.ps1` pushes all three. Use it at the end of the
day. The failure it prevents is the quiet one — pushing the worktree you are
standing in, assuming you are done, and losing the other two.

## Keeping up with upstream

`.github/workflows/upstream-sync.yml` runs on Mondays at 06:00 ET and on demand
(Actions → Upstream sync → Run workflow). It fetches upstream, puts the merge on
`sync/upstream-YYYY-MM-DD`, and opens a PR.

**It never merges anything.** This fork has its own commits on `main`, so an
upstream merge can conflict with work somebody is relying on, and an unattended
merge that resolves a conflict badly is worse than a fork that is behind. When
the merge conflicts, the workflow commits the conflicted state *with the markers
left in* so they show up in the PR diff, and says so in the title — resolve them
on the branch and push.

If it says "already current", it did nothing, which is the correct outcome.

> **Actions are on.** They were turned on by 2026-09-22 for the Windows release
> train, so upstream's inherited workflows run here too (for example the weekly
> guardrail pulse that opened issue #9).

## Cutting a Windows build

You do not cut one by hand. `.github/workflows/windows-release.yml` builds and
publishes on every merge to `main` that touches `desktop/windows/**`, into
`mrichard33/omi-desktop-releases`, and installed copies update from there within
about four hours. Full detail: `desktop/windows/docs/reece-release.md`.

Upstream's manual `desktop_windows_release.yml` is still in the repo but is not
our release path; do not use it.

## Two things that will waste your afternoon

### 1. `scripts/pre-push-singleflight` fails on Windows

If your Python is native Windows (rather than the one inside Git Bash), the
pre-push hook does this:

```bash
GIT_BASH_NATIVE="$(cygpath -w "$(command -v bash)")"
PREFLIGHT_COMMAND=("$GIT_BASH_NATIVE" scripts/pre-push "$@")
```

`command -v bash` gives a POSIX path like `/usr/bin/bash`, and `cygpath -w`
turns it into something like `C:\Program Files\Git\usr\bin\bash` — which is a
path **Windows cannot launch**, because that bash is not a native Windows
executable. The push dies in the hook, before git has done anything.

**`--no-verify` is acceptable on this fork.** Upstream's gate is not our gate:
our changes are Windows-desktop work that upstream CI does not cover anyway, and
the sync PR is where correctness actually gets checked.

```powershell
git push --no-verify origin <branch>
```

If you would rather fix it than skip it, point the hook at a Git Bash Python so
`dev_harness_python_uses_windows_paths` returns false and the whole `cygpath`
branch is never taken.

### 2. `git push --all` means every local branch

That is what `push-all.ps1` uses, and it is intentional — these worktrees carry
work on several branches at once, and remembering which is which is exactly what
goes wrong at the end of a long day. If you keep scratch branches you do not
want on the remote, delete them before running it, or run it with `-DryRun`
first to see what would go.
