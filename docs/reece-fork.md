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
on top of upstream. Upstream changes arrive only through the daily sync PR below.

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

**Daily and automatic (Mark, 2026-10-12: "Everything updated daily and fully
automated").** The weekly sync PRs were never merged after 2026-09-11, and by
2026-10-12 `main` was 3,977 commits behind. So the sync now merges itself when
everything passes, and only asks a person when it cannot produce a passing build.

`.github/workflows/upstream-sync.yml` runs every day at 06:00 ET (10:00 UTC, so
05:00 EST in winter) and on demand (Actions → Upstream sync → Run workflow). Each run:

1. Fetches `BasedHardware/omi` `main`. Nothing new → it stops quietly.
2. Merges it into `sync/upstream-YYYY-MM-DD` with a merge commit (never a rebase:
   our own commits stay in history).
3. Regenerates the pi-mono unpack list (`pnpm gen:pimono-unpack`) and commits it if
   it changed. That drift is what broke `pnpm install` before 2026-10-12.
4. Runs the `desktop/windows` checks: the full `pnpm install` (with
   `verify-pimono-unpack`), typecheck, lint, tests, and the real Windows build
   (`build:win:unpack`) on a Windows runner.
5. **Conflict or failing check →** Claude (`anthropics/claude-code-action`, pinned)
   resolves it once with the rules below, and the checks run again.
6. **All green →** it opens the PR and merges it (merge commit) with
   `UPSTREAM_SYNC_TOKEN`. That merge triggers `windows-release.yml`, so a new
   Windows build is published. The run confirms the release started, and starts it
   itself if it did not.
7. **Still red →** the PR stays open with the `needs-attention` label and the
   failing output in its body, and ONE Slack alert goes out: "Omi upstream sync
   needs attention: <PR link>. Reason: <conflict | failing check>." No repeat alert
   for the same PR unless the reason changes. **A failing build is never merged.**

Only one sync PR is open at a time. A `needs-attention` PR is reused the next day:
rebuilt from scratch if only the automation has touched it, or updated in place
(your commits kept) if a person has pushed a fix to its branch. To take it over,
push your fix to that branch and merge the PR yourself.

It never pushes to `main` and never pushes to upstream. Every change reaches `main`
through the PR. The PR's own CI also runs, but the merge does not wait for it: the
sync has already run the same `desktop/windows` checks itself.

**Conflict rules (the same ones Claude is given):** keep ours for this file,
`scripts/push-all.ps1`, the sync and release workflows, and every updater setting
that points at `mrichard33/omi-desktop-releases`. In `desktop/windows`, keep a
Reece fix unless upstream now covers the same behavior. Take upstream for
`backend/` and everything else.

### Secrets it needs

Add them in GitHub → `mrichard33/omi` → Settings → Secrets and variables → Actions.
A run with a required secret missing fails at once and names the missing secret.

| Secret | Required | What it is |
|---|---|---|
| `UPSTREAM_SYNC_TOKEN` | yes | Fine-grained token, access to `mrichard33/omi` only, with Contents, Pull requests and Workflows set to read and write. It pushes the branch, opens and merges the PR. A merge made with the default `GITHUB_TOKEN` would not start the Windows release. |
| `ANTHROPIC_API_KEY` | yes | Claude Console API key, with a monthly spend limit. Used only when a merge conflicts or a check fails. |
| `SLACK_WEBHOOK_URL` | no | Slack incoming webhook for the alert. Unset → no alert, the PR is still labeled. |

### Pause it, test it

- **Pause:** Actions → Upstream sync → "…" → Disable workflow. Enable it again the
  same way.
- **Test the failure path:** Run workflow with `simulate_failure` ticked. It forces a
  failing check, skips Claude, never merges, labels the PR and sends the alert. The
  next normal run reuses that PR and merges it if everything passes.
- The sync scripts live in `.github/scripts/reece-upstream-sync/`, and their tests
  run on every PR that changes them (`reece-upstream-sync-tests.yml`).

If a run says "already current", it did nothing, which is the correct outcome.

> **Actions are on.** They were turned on by 2026-09-22 for the Windows release
> train, so upstream's inherited workflows run here too (for example the weekly
> guardrail pulse that opened issue #9, since removed upstream).

### Upstream's deploy and monitoring workflows are kept off (2026-10-25)

Upstream's workflows that run Omi's own infrastructure (Codemagic mobile builds,
Google Cloud and GKE deploys, Grafana, PostHog, Vercel, Mintlify) cannot work
here: they need Omi's accounts and secrets. They failed on every push and every
schedule and emailed each failure (214 in the week to 2026-10-25; "Mobile
internal builds" failed every three hours with `CODEMAGIC_API_TOKEN is
required`).

`.github/workflows/reece-disable-upstream-ops.yml` disables every workflow named
in `.github/scripts/reece-upstream-sync/upstream-only-workflows.txt`. It runs after
each upstream sync, daily, and on demand. A workflow's on/off state lives in
GitHub, not in its file, so it stays off through every sync and no upstream file
is edited. To bring one back: delete its line from the list, then Actions →
the workflow → Enable workflow.

Upstream's test workflows (Backend Unit Tests, Repo Checks, Main Nightly Full and
the rest) are not on the list: they need no secrets and stay on.

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
