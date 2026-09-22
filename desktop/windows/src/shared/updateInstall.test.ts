import { describe, it, expect } from 'vitest'
import {
  describeUpdateInstall,
  resolveUpdateInstall,
  type UpdateInstallResult
} from './updateInstall'

describe('resolveUpdateInstall', () => {
  const idle = { listening: false, meetingCapturing: false }

  it('installs when an update is staged and nothing is being captured', () => {
    expect(resolveUpdateInstall(true, idle)).toBe('installing')
  })

  it('never restarts during an active listening session', () => {
    expect(resolveUpdateInstall(true, { listening: true, meetingCapturing: false })).toBe('busy')
  })

  it('never restarts during a meeting capture', () => {
    expect(resolveUpdateInstall(true, { listening: false, meetingCapturing: true })).toBe('busy')
  })

  it('reports nothing staged before it considers capture at all', () => {
    // A user pressing "Restart to update" with nothing staged must be told that,
    // not told the app is busy — the two cases have different next steps.
    expect(resolveUpdateInstall(false, { listening: true, meetingCapturing: true })).toBe(
      'not-staged'
    )
    expect(resolveUpdateInstall(false, idle)).toBe('not-staged')
  })
})

describe('describeUpdateInstall', () => {
  it('says nothing on success and explains every refusal', () => {
    expect(describeUpdateInstall('installing')).toBeNull()
    expect(describeUpdateInstall('busy')).toMatch(/recording/i)
    expect(describeUpdateInstall('not-staged')).toMatch(/no longer staged/i)
  })

  it('covers every result the guard can return', () => {
    const all: UpdateInstallResult[] = ['installing', 'busy', 'not-staged']
    for (const result of all) expect(describeUpdateInstall(result)).not.toBeUndefined()
  })
})
