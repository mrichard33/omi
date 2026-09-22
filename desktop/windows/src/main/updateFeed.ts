// THE update feed. There is exactly one, and it is Mark's private releases repo.
//
// WHAT THIS REPLACED (and must never come back): the app used to resolve its
// feed from Omi's backend — `GET {api}/v2/desktop/update-feed/windows`, which
// answers with a `github.com/BasedHardware/omi/releases/download/...` directory.
// That is Omi's OFFICIAL release train. This fork ships customized builds (the
// listen backoff + circuit breaker, the conversation-finalize work); pointing at
// the official feed would have auto-replaced them with Omi's stock app on the
// next 4-hour check. The backend resolver and its BasedHardware URL allowlist
// are deleted, not disabled — there is no second code path to drift back on.
//
// PRIVATE REPO + TOKEN. `omi-desktop-releases` is private, so electron-updater's
// GitHub provider needs a token to list releases and download assets. It is
// baked in at build time from the `UPDATER_READ_TOKEN` Actions secret (see
// .github/workflows/windows-release.yml). Scope is deliberately the smallest
// GitHub offers: a fine-grained token on that ONE repo with Contents: Read. It
// can download Mark's own installers and nothing else — no source, no other
// repo, no write. That is the whole reason binaries live in a separate repo from
// the code.
//
// A build with no token still runs: the updater reports its checks as errors and
// the app keeps working. An update failure is never allowed to be fatal.

/** Owner of the releases repo. Never `BasedHardware`. */
export const UPDATE_FEED_OWNER = 'mrichard33'
/** Binaries + update metadata only — never source. */
export const UPDATE_FEED_REPO = 'omi-desktop-releases'

export type UpdateFeedConfig = {
  provider: 'github'
  owner: string
  repo: string
  private: true
  token: string
}

/**
 * The feed to hand `autoUpdater.setFeedURL`, or null when no token was baked in
 * (a local `pnpm build:win`, or CI without the secret). Null means "do not
 * check" — never "fall back to something else".
 */
export function resolveUpdateFeed(token: string | undefined): UpdateFeedConfig | null {
  const trimmed = typeof token === 'string' ? token.trim() : ''
  if (!trimmed) return null
  return {
    provider: 'github',
    owner: UPDATE_FEED_OWNER,
    repo: UPDATE_FEED_REPO,
    private: true,
    token: trimmed
  }
}

/**
 * Redact a feed for logging. The token is a credential: it must never reach
 * main.log, a Sentry breadcrumb, or a support paste.
 */
export function describeUpdateFeed(feed: UpdateFeedConfig | null): string {
  if (!feed) return 'no feed (no updater token in this build)'
  return `github:${feed.owner}/${feed.repo} (private)`
}
