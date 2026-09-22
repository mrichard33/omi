import { describe, it, expect } from 'vitest'
import { loadEnv } from 'vite'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const windowsDir = resolve(import.meta.dirname, '..')

// The whole auto-update train hangs on ONE build-time substitution: the release
// workflow exports MAIN_VITE_UPDATER_READ_TOKEN as a process env var, and
// electron-vite has to freeze it into the main bundle as
// import.meta.env.MAIN_VITE_UPDATER_READ_TOKEN (read by src/main/updateFeed.ts).
//
// If that plumbing silently stops working, the shipped app has no token, the
// updater turns itself off, and the only symptom is a line in a log nobody is
// reading — installs quietly stop updating. So the mechanism is asserted against
// the REAL Vite that builds the app, not assumed from documentation.
describe('updater token injection', () => {
  const TOKEN = 'github_pat_test_value'

  it('Vite exposes a MAIN_VITE_ process env var to the main bundle', () => {
    const before = process.env.MAIN_VITE_UPDATER_READ_TOKEN
    process.env.MAIN_VITE_UPDATER_READ_TOKEN = TOKEN
    try {
      // Same call electron-vite makes for the main process: MAIN_VITE_ prefix.
      const env = loadEnv('production', windowsDir, 'MAIN_VITE_')
      expect(env.MAIN_VITE_UPDATER_READ_TOKEN).toBe(TOKEN)
    } finally {
      if (before === undefined) delete process.env.MAIN_VITE_UPDATER_READ_TOKEN
      else process.env.MAIN_VITE_UPDATER_READ_TOKEN = before
    }
  })

  it('an unset token yields nothing, so the build stays runnable without it', () => {
    const before = process.env.MAIN_VITE_UPDATER_READ_TOKEN
    delete process.env.MAIN_VITE_UPDATER_READ_TOKEN
    try {
      const env = loadEnv('production', windowsDir, 'MAIN_VITE_')
      expect(env.MAIN_VITE_UPDATER_READ_TOKEN).toBeUndefined()
    } finally {
      if (before !== undefined) process.env.MAIN_VITE_UPDATER_READ_TOKEN = before
    }
  })

  // A static tripwire, not behavioral coverage: it reads the committed file
  // rather than running it. It exists because the embedded-config audit has
  // exactly one allowed credential, and the cheapest way that promise breaks is
  // someone adding a second secret to .env.example, where the build picks it up
  // with no review of the bundle.
  it('.env.example carries no credential (static check)', () => {
    const lines = readFileSync(resolve(windowsDir, '.env.example'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))

    const SECRET_NAMES = /(SECRET|PRIVATE_KEY|PASSWORD|_TOKEN)/i
    for (const line of lines) {
      const [name, ...rest] = line.split('=')
      const value = rest.join('=').trim()
      if (!SECRET_NAMES.test(name)) continue
      // A secret-shaped name is allowed only while it is EMPTY — the developer
      // fills it in a local .env that is gitignored and never built in CI.
      expect(value, `${name} must stay empty in .env.example`).toBe('')
    }
  })
})
