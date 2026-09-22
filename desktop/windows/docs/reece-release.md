# Reece release train (Windows)

How a merge to `main` becomes an update on Mark's PC, with no manual steps.

```
merge to main (desktop/windows/**)
   -> .github/workflows/windows-release.yml   (windows-latest, Node 22, pnpm 10)
   -> typecheck + lint + pnpm test            (red suite = no release)
   -> version stamped x.y.z-reece.<run>       (scripts/reece-version.mjs)
   -> NSIS installer built, UPDATER_READ_TOKEN baked in
   -> release published to mrichard33/omi-desktop-releases
   -> installed app checks 45s after launch, then every 4h
   -> downloads in the background, installs on the next quit
```

## The two tokens

Both are **fine-grained** tokens limited to **`omi-desktop-releases` only**.
Neither can reach the source repo — that is the entire reason binaries live in a
repo of their own.

| Actions secret | Permission | Where it goes | Why that scope |
|---|---|---|---|
| `UPDATER_READ_TOKEN` | Contents: **Read** | Baked into the app bundle at build time as `MAIN_VITE_UPDATER_READ_TOKEN` (`src/main/updateFeed.ts`) | A private feed needs a credential on every installed copy. Read-only on one binaries repo is the smallest thing that works — it downloads Mark's own installers and nothing else. |
| `RELEASES_PUBLISH_TOKEN` | Contents: **Read and write** | Used only by the `gh release` step in the workflow | Write access must never be in the bundle. Keeping it a separate token is what makes that guarantee checkable. |

Create them at GitHub → Settings → Developer settings → Fine-grained tokens, then
add both under `mrichard33/omi` → Settings → Secrets and variables → Actions.

### Embedded-config audit

What ships inside the installer, and what each thing is:

| Value | Source | Classification |
|---|---|---|
| `VITE_FIREBASE_API_KEY` / `AUTH_DOMAIN` / `PROJECT_ID` | `.env.example` | **Public** — Firebase web config, designed to be client-visible; access is governed by Firebase rules, not by hiding the key |
| `VITE_OMI_API_BASE`, `VITE_OMI_DESKTOP_API_BASE`, `VITE_OMI_SHARE_BASE_URL` | `.env.example` | **Public** — backend URLs |
| `VITE_POSTHOG_KEY` | `.env.example` | **Public** — PostHog publishable client key |
| `VITE_ENABLE_*`, `VITE_GEMINI_MODEL`, `VITE_SANDBOX_*` | `.env.example` | **Public** — feature flags / labels |
| `MAIN_VITE_GOOGLE_CLIENT_ID` / `_SECRET` | `.env.example`, **blank** | Would be a secret — ships EMPTY, so the Google integration is off in released builds. Leave them blank. |
| `MAIN_VITE_SENTRY_DSN` | unset in CI | Not embedded |
| `MAIN_VITE_UPDATER_READ_TOKEN` | `UPDATER_READ_TOKEN` secret | **The one credential in the bundle**, deliberately: read-only, one repo |

`scripts/updater-token-injection.test.mjs` pins the injection path against the
real Vite, and statically fails if a secret-shaped name in `.env.example` ever
gains a non-empty value.

## Versioning

`<package.json version>-reece.<github run number>` — e.g. `1.0.35-reece.42`
(`scripts/reece-version.mjs`, stamped in CI only; `package.json` stays on the
plain upstream version in git).

The run number is monotonic, so every merge is strictly newer than the last with
no manual bumping. An upstream sync that bumps `package.json` to `1.0.36` makes
`1.0.36-reece.1` outrank every `1.0.35-reece.N` automatically.

**Consequence worth knowing:** every version here is a semver *prerelease*, so
`src/main/updater.ts` sets `allowPrerelease = true` unconditionally. Turn that
off and electron-updater filters out every build Mark ships and reports
"up to date" forever — with nothing in the log to notice. `scripts/reece-version.test.mjs`
pins the ordering.

## The feed

Exactly one, and it is not Omi's. `src/main/updateFeed.ts` returns
`github:mrichard33/omi-desktop-releases (private)`; `src/main/updater.ts` sets it
before any check. The backend resolver this replaced
(`GET {api}/v2/desktop/update-feed/windows` → a `BasedHardware/omi` release
directory) is **deleted**, not disabled — there is no second path to drift back
onto. A build with no token turns the updater off entirely rather than falling
back to whatever `app-update.yml` says.

Update behavior: check 45s after launch then every 4 hours, download in the
background, install on the next quit. "Restart to update" (tray, and Settings →
About) is the only path that restarts on the updater's schedule, and it is
**refused while a recording or meeting capture is live** — the staged installer
still runs on the next quit, so nothing is lost by waiting
(`src/shared/updateInstall.ts`).

Log lines, all in `main.log`:

```
[updater] feed github:mrichard33/omi-desktop-releases (private)
[updater] checking
[updater] available 1.0.35-reece.42
[updater] downloaded 1.0.35-reece.42
[updater] none
[updater] error <message>
```

## Cutting a release by hand

Actions → **windows-release** → Run workflow. From `main` it builds, tests and
publishes exactly as a merge would. From any other branch it builds, tests and
uploads the installer as a workflow artifact but **does not publish** — that is
the dry run to use when changing this pipeline.

## Rolling back

Pick whichever fits; both are done in `omi-desktop-releases`, not here.

1. **Re-publish an older build as the newest.** Download the good installer,
   `latest.yml` and `.blockmap` from the older release, then create a NEW release
   with a higher run number in its tag and upload those files to it. Clients
   compare versions, so the only thing that makes a build "current" is being the
   highest version in the feed. (`latest.yml` still names the old version inside;
   that is what makes clients install it.)
2. **Delete the bad release.** Clients fall back to the highest remaining
   version. Fastest option, but it loses the record of what shipped — prefer (1)
   unless the bad build is actively harmful.
3. **Pin one machine.** Install the wanted `.exe` by hand and it stays put until
   a *higher* version appears in the feed.

Then fix forward in `mrichard33/omi`: the next merge to `main` gets a higher run
number and supersedes the rollback automatically.

## Things that surprise people

- **SmartScreen warns on first install.** The installer is unsigned — "Windows
  protected your PC" → *More info* → *Run anyway*, once. Signing needs a
  certificate that is not wired up; `electron-builder.config.mjs` has the Azure
  Trusted Signing notes for when it is.
- **Upstream sync PRs trigger a release too.** Any merge to `main` that touches
  `desktop/windows/**` publishes a build — including one that only merges
  upstream changes. That is intended (the fork's build should track upstream),
  but it means an upstream sync lands on Mark's PC within 4 hours, so review
  those the way you would any other release.
- **Stop using `pnpm dev` for daily use** once installed, or you are running the
  source tree and the installed app in parallel and only one of them updates.
- **A failed update never breaks the app.** Every updater error is caught and
  logged; listening is unaffected.
