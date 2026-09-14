# The Reece fork of Omi

How this fork is laid out, why, and the two things that waste an afternoon if
nobody tells you.

## The layout

`main` mirrors [BasedHardware/omi](https://github.com/BasedHardware/omi). All
custom work lives on branches. That is what keeps upstream merges tractable: a
sync PR that only has to merge upstream into upstream is usually a no-op, and a
conflict on a branch is a conflict in one place rather than everywhere.

**The one exception** is these three files, which are on `main` on purpose:

| File | Why it must be on main |
|---|---|
| `.github/workflows/upstream-sync.yml` | A `schedule` trigger only runs from the default branch. On a branch it would never fire. |
| `scripts/push-all.ps1` | It has to be there in a fresh clone, before you have checked anything out. |
| `docs/reece-fork.md` | This file. It is no use on a branch you have not found yet. |

Everything else Reece-specific belongs on a branch.

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

> **Actions are off on this fork.** Nothing above runs until someone enables
> them in Settings → Actions. That is deliberate: this fork carries 78 upstream
> workflows, and turning Actions on starts those too. Turn them on when you are
> ready to see what upstream's CI does to a fork.

## Cutting a Windows build

Use the workflow that already exists: **Actions → "Auto Release Desktop
(Windows) on Main" → Run workflow** (`.github/workflows/desktop_windows_release.yml`).

It bumps the patch version, tags `v<version>-windows`, builds the NSIS installer
on a `windows-latest` runner, and publishes it to a prerelease GitHub Release.
It signs the installer when the Azure Trusted Signing secrets are present and
builds unsigned when they are not — an unsigned build works, it just makes
Windows SmartScreen warn about an unknown publisher.

There is deliberately **no second build workflow**. An earlier plan called for
one triggered by an `omi-windows-v*` tag; it was dropped because two release
paths with two tag schemes is how you end up with a release nobody can find.

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
