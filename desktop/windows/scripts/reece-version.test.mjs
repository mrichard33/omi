import { describe, it, expect } from 'vitest'
import { reeceVersion } from './reece-version.mjs'

// The whole auto-update train rests on one property: every build published from
// main must compare STRICTLY NEWER than the one before it. If that ordering ever
// breaks, installed apps silently stop updating with no error anywhere — so it is
// pinned here rather than discovered in a release.
describe('reeceVersion', () => {
  it('stamps the run number as a prerelease tag', () => {
    expect(reeceVersion('1.0.35', 42)).toBe('1.0.35-reece.42')
    expect(reeceVersion('1.0.35', '7')).toBe('1.0.35-reece.7')
  })

  it('orders consecutive runs strictly newer, including across a decimal digit', async () => {
    const semver = (await import('semver')).default
    expect(semver.gt(reeceVersion('1.0.35', 43), reeceVersion('1.0.35', 42))).toBe(true)
    // Numeric prerelease identifiers compare NUMERICALLY under semver, so run 10
    // beats run 9 (a string compare would have put "10" before "9").
    expect(semver.gt(reeceVersion('1.0.35', 10), reeceVersion('1.0.35', 9))).toBe(true)
    expect(semver.gt(reeceVersion('1.0.35', 100), reeceVersion('1.0.35', 99))).toBe(true)
  })

  it('lets an upstream version bump outrank every earlier run', async () => {
    const semver = (await import('semver')).default
    expect(semver.gt(reeceVersion('1.0.36', 1), reeceVersion('1.0.35', 999))).toBe(true)
  })

  it('produces a version electron-updater only sees with allowPrerelease', async () => {
    // Documents WHY updater.ts sets allowPrerelease unconditionally: every build
    // here carries a prerelease component, so a stable-only updater would find
    // nothing, forever, with no error.
    const semver = (await import('semver')).default
    expect(semver.prerelease(reeceVersion('1.0.35', 42))).toEqual(['reece', 42])
  })

  it('refuses a base version that was already stamped', () => {
    // Guards the one way this silently degrades: a stamped package.json getting
    // committed, after which every later build would re-stamp the stamp.
    expect(() => reeceVersion('1.0.35-reece.42', 43)).toThrow(/plain x\.y\.z/)
    expect(() => reeceVersion('1.0', 1)).toThrow(/plain x\.y\.z/)
    expect(() => reeceVersion('', 1)).toThrow(/plain x\.y\.z/)
  })

  it('refuses a missing or nonsensical run number', () => {
    expect(() => reeceVersion('1.0.35', undefined)).toThrow(/positive integer/)
    expect(() => reeceVersion('1.0.35', 0)).toThrow(/positive integer/)
    expect(() => reeceVersion('1.0.35', 'abc')).toThrow(/positive integer/)
    expect(() => reeceVersion('1.0.35', 1.5)).toThrow(/positive integer/)
  })
})
