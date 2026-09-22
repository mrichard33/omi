// Version stamping for Mark's private Windows release train.
//
// Every build published to mrichard33/omi-desktop-releases is versioned
// `<package.json version>-reece.<github run number>`, e.g. `1.0.35-reece.42`.
//
// WHY THIS SHAPE:
//  - The run number is monotonic per workflow, so every merge to main is
//    strictly newer than the last one — no manual bumping, no tag arithmetic.
//  - The `-reece.` prerelease tag keeps these versions in their own namespace.
//    Omi's official `1.0.35` would sort ABOVE `1.0.35-reece.42` under semver,
//    but that never matters: this app only ever reads Mark's own feed. What it
//    buys is that an upstream sync which bumps package.json to 1.0.36 makes
//    `1.0.36-reece.1` sort above every `1.0.35-reece.N` automatically.
//  - Because EVERY version here carries a prerelease component, the updater
//    must run with `allowPrerelease = true` (see src/main/updater.ts) or
//    electron-updater would filter out every build Mark ships.
//
// Used by .github/workflows/windows-release.yml, which runs:
//   node scripts/reece-version.mjs <run-number>   → rewrites package.json
// and prints the stamped version so later steps can read it.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** A base version must be plain `x.y.z` — never already stamped. */
const BASE_VERSION = /^\d+\.\d+\.\d+$/

/**
 * Build the published version string. Pure, so the ordering guarantee is
 * unit-tested rather than discovered in a release.
 *
 * @param {string} baseVersion `x.y.z` from package.json
 * @param {string|number} runNumber the GitHub Actions run number
 * @returns {string} `x.y.z-reece.N`
 */
export function reeceVersion(baseVersion, runNumber) {
  const base = String(baseVersion ?? '').trim()
  if (!BASE_VERSION.test(base)) {
    throw new Error(
      `reece-version: base version must be plain x.y.z, got ${JSON.stringify(baseVersion)}. ` +
        'A version that already carries a prerelease tag means package.json was stamped ' +
        'by a previous run and committed by mistake.'
    )
  }
  const run = Number(runNumber)
  if (!Number.isInteger(run) || run < 1) {
    throw new Error(
      `reece-version: run number must be a positive integer, got ${JSON.stringify(runNumber)}.`
    )
  }
  return `${base}-reece.${run}`
}

/** Stamp package.json in place and return the new version. */
export function stampPackageJson(packageJsonPath, runNumber) {
  const raw = readFileSync(packageJsonPath, 'utf8')
  const pkg = JSON.parse(raw)
  const next = reeceVersion(pkg.version, runNumber)
  pkg.version = next
  // Two-space indent + trailing newline: matches the file as committed, so a
  // stamped checkout has a one-line diff instead of a whole-file reformat.
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  return next
}

// CLI: `node scripts/reece-version.mjs <run-number>`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    process.stdout.write(`${stampPackageJson(join(root, 'package.json'), process.argv[2])}\n`)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
}
