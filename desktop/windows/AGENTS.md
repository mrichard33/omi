# Desktop (Windows/Linux) — Developer Guide

## Project Overview

Omi's Electron + React + TypeScript desktop app. One codebase ships both the
Windows and Linux builds (`electron-builder.config.mjs`'s `linux`/`win` targets);
there is no separate Linux-only source tree. See `README.md` for the quickstart
and feature overview.

## Package manager: pnpm, not npm

This directory is pnpm-managed (`pnpm-lock.yaml`, `pnpm-workspace.yaml`) and CI
installs exclusively with `pnpm install --frozen-lockfile`
(`.github/workflows/desktop-windows-ci.yml`, `desktop_windows_release.yml`).
Running `npm install` here corrupts `package.json`/`pnpm-lock.yaml`/
`pnpm-workspace.yaml` (npm doesn't understand pnpm-workspace semantics) and
produces a stray, untracked `package-lock.json` — if you see unexplained diffs
in those three files with no matching commit, this is almost certainly why;
`git restore` them and reinstall with pnpm.

**pnpm major-version pin:** CI pins `pnpm/action-setup@v6` to **version 10**.
If your local `pnpm --version` is a different major (e.g. a system package
manager installed 11+), `.npmrc`'s `node-linker=hoisted` may be silently
ignored, breaking the pi-mono dependency-closure postinstall check
(`scripts/verify-pimono-unpack.mjs`) with "closure package(s) do
not resolve on disk" error. Use `npx pnpm@10 <command>` if your system pnpm
is a different major version — don't downgrade a system-managed pnpm install
for this alone. **Node pin:** `>=22.19.0 <23` (`.nvmrc`; 24+ fails pretest).

## Development Workflow

- **Install**: `pnpm install --frozen-lockfile` (postinstall rebuilds
  `better-sqlite3`, builds Windows-only OCR/audio/automation `.NET` helpers —
  those steps no-op on Linux/macOS dev machines).
- **Run**: `pnpm dev` (electron-vite dev server + Electron). Multiple parallel
  worktrees auto-isolate ports/profiles — see `docs/multi-worktree-dev.md`.
- **Typecheck**: `pnpm typecheck` (`typecheck:node` + `typecheck:web`).
- **Lint**: `pnpm lint` (ESLint; Prettier formatting is non-blocking in CI).
- **Unit tests**: `pnpm test` (vitest, ~550 tests, runs against an Electron
  stub — no real Electron binary needed).
- **Build**: `pnpm build:win` / `pnpm build:mac` / `pnpm build:linux`. Every
  build must pass `--config electron-builder.config.mjs` explicitly (not
  auto-detected — see `docs/release-pipeline.md`) and `--publish never`
  outside the release workflow.
- **Manual E2E / smoke / soak scripts** (`test:e2e:*`, `smoke:*`, `soak*`,
  `orb:*`, `verify:*` in `package.json`): a large surface CI does **not** run —
  these are the maintainer's day-to-day verification toolkit for things CI
  can't reach (live ASR, agent spawning, OAuth flows, Rewind semantics). Specs
  live under `e2e/`. Run the relevant one manually before shipping a change
  in that area; don't assume `pnpm test` alone covers it.
- **Linux Wayland compositors (niri/Sway/Hyprland)**: `pnpm dev` auto-detects
  these and defaults to native Wayland instead of XWayland; see
  `docs/multi-worktree-dev.md`'s environment-overrides and troubleshooting
  sections for the detection mechanism, `OMI_OZONE` override, and known
  limitations.

## CI

`.github/workflows/desktop-windows-ci.yml` — three jobs, triggered on
`desktop/windows/**` changes:
- **checks** (ubuntu): `pnpm typecheck`, `pnpm lint` (blocking), `pnpm test`.
- **build-windows** (real `windows-latest` runner): builds the native `.NET`
  OCR/UI-automation helpers, rebuilds `better-sqlite3`, runs
  `pnpm build:unpack`. Verifies packaging succeeds; does **not** launch or
  smoke-test the packaged binary at runtime.
- **build-linux** (ubuntu): builds the Linux variant, then actually launches
  it under `xvfb-run` and runs targeted integration tests (OCR helper, Wayland
  degradation) against the real running app — more runtime coverage than the
  Windows job gets today.

**A test that reaches the live API passes vacuously in `checks`:** with no `.env`,
`VITE_OMI_API_BASE` is empty, so the request is refused instantly by localhost.
`windows-release.yml` provisions `.env` before the same suite, so that is where it
shows up — as a timeout, at release time. Mock the network at its module seam
(`vi.mock('../lib/chatQuotaGate', ...)`, as every `useChat*.test.tsx` does).

## Release Pipeline

**This fork's own train — `docs/reece-release.md`.** `windows-release.yml`
publishes every merge to `main` into the private `mrichard33/omi-desktop-releases`,
and the installed app updates from there. The feed must never name
`BasedHardware/omi`: that would replace this build with Omi's stock app. Two
fine-grained tokens, releases-repo only. Upstream's manual workflow below stays
for upstream syncs.

Full detail: `docs/release-pipeline.md` — tagging, signing, auto-update feed,
public download link. Unlike macOS's, upstream's is **manual only**
(`workflow_dispatch`, no `push` trigger), and since Windows has no external CI
the same workflow also builds the NSIS installer on a `windows-latest` runner.

The version-bump "sync back to main" step is documented as best-effort and can
leave a stale, unmerged PR behind after a release — see issue #10727. If you
hit this, check for an open `chore(windows): sync release v<version> to main`
PR before assuming something else broke.

**Auto-update** (`src/main/updater.ts`, `updateFeed.ts`): Windows-only today
(`platform !== 'win32'` gate) — Linux gets no auto-update and no release
pipeline. Closing that gap needs a Linux publishing workflow plus a Linux feed;
check for an open tracking issue/PR first.

## Docs index

- `docs/reece-release.md` — **this fork's release train**: tokens, versioning,
  rollback.
- `docs/release-pipeline.md` — upstream's Windows release/tagging/signing.
- `docs/bar-gotchas.md` — **read before touching bar window/animation code**:
  the top-edge companion bar has real, non-obvious pathologies (OS show-fade,
  clip-reveal, orb remount blink, eaten hardware clicks).
- `docs/listen-reconnect.md` — **read before touching the mic lane's reconnect,
  backoff or circuit breaker**: why reaching OPEN is not health, why a clean 1000
  close must not strike, and why the meeting lane keeps a different ladder.
- `docs/conversation-sync.md` — offline-retry outbox design.
- `docs/multi-worktree-dev.md` — parallel-worktree port/profile isolation, dev
  env var reference.
- `docs/linux-screen-recording.md` — Rewind needs a Wayland desktop portal;
  wlroots compositors (niri, Sway, Hyprland) often ship none configured.
- `docs/perf-invisible-wins.md`, `docs/perf-startup-burst-2026-07-19.md` — perf notes.

## Changelog Entries

Add one fragment under `changelog/unreleased/` for user-visible changes —
follow the existing fragment shape in that directory (`{"changes": [...]}`).
Non-user-visible internal changes don't need one.
