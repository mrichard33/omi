import { beforeEach, describe, expect, it, vi } from 'vitest'

// A lane that dies after connecting reaches its owner as an Error, and until now
// the WS close code died with it: closedMessage() formats the code into a human
// string and the number is thrown away. The reconnect policy needs 1011 (a
// transient server fault, retry) told apart from a clean 1000/1001 teardown
// (the stale-socket watchdog's own close, which must not count as a failure),
// so the code now rides on the Error as `closeCode`.

const h = vi.hoisted(() => ({
  auth: { currentUser: { uid: 'user-1' } as null | { uid: string } },
  startOmiListen: vi.fn()
}))

vi.mock('./firebase', () => ({ auth: h.auth }))
vi.mock('./omiListenClient', () => ({ startOmiListen: h.startOmiListen }))

import { startTranscription, type TranscriptionCallbacks } from './transcriptionClient'
import type { ListenError } from './omiListenClient'

type Listener = {
  onConnected: () => void
  onSegments: (segments: unknown[]) => void
  onEvent: (event: unknown) => void
  onError: (error: Error, fatal: boolean) => void
  onClosed: (code: number, reason: string) => void
}

function callbacks(): TranscriptionCallbacks {
  return { onLine: vi.fn(), onInterim: vi.fn(), onBackend: vi.fn(), onError: vi.fn() }
}

/** Start a lane that reaches ready, and hand back its listener so a test can close it. */
async function connectedLane(cb: TranscriptionCallbacks): Promise<Listener> {
  let listener!: Listener
  h.startOmiListen.mockImplementation(async (_source: string, l: Listener) => {
    listener = l
    setTimeout(() => l.onConnected(), 0)
    return { stop: vi.fn(), finalize: vi.fn() }
  })
  await startTranscription('mic', cb, 'conversation')
  return listener
}

beforeEach(() => {
  h.auth.currentUser = { uid: 'user-1' }
  h.startOmiListen.mockReset()
})

describe('close code threading', () => {
  it('carries 1011 through to the reconnect owner', async () => {
    const cb = callbacks()
    const lane = await connectedLane(cb)

    lane.onClosed(1011, 'transcription_service_unavailable')

    expect(cb.onError).toHaveBeenCalledOnce()
    const err = (cb.onError as ReturnType<typeof vi.fn>).mock.calls[0][0] as ListenError
    expect(err.closeCode).toBe(1011)
    // The human message is unchanged — every existing regex over it still matches.
    expect(err.message).toBe(
      'Omi transcription stopped: Omi /v4/listen closed (1011) transcription_service_unavailable'
    )
  })

  it('carries a clean 1000 through, so the policy can tell it apart', async () => {
    const cb = callbacks()
    const lane = await connectedLane(cb)

    lane.onClosed(1000, 'watchdog: stale')

    const err = (cb.onError as ReturnType<typeof vi.fn>).mock.calls[0][0] as ListenError
    expect(err.closeCode).toBe(1000)
  })

  it('carries the code on a quota close without making it retryable', async () => {
    const cb = callbacks()
    const lane = await connectedLane(cb)

    lane.onClosed(1008, 'trial_expired')

    const err = (cb.onError as ReturnType<typeof vi.fn>).mock.calls[0][0] as ListenError
    expect(err.closeCode).toBe(1008)
    // The code is reported, but it is NOT what makes this terminal: closedMessage
    // has already folded the reason into the fixed quota string, and
    // isRetryableDropError stops the lane on that message before any delay is
    // computed. The backend uses 1008 for idle timeouts and rate limits too, which
    // is exactly why the reason, not the code, decides retryable-vs-terminal.
    expect(err.message).toContain('free Omi transcription quota is used up')
  })

  it('carries the code on a pre-connect close, where a rejected 429 handshake lands', async () => {
    const cb = callbacks()
    h.startOmiListen.mockImplementation(async (_source: string, l: Listener) => {
      const err: ListenError = new Error('v4/listen closed (1006)')
      err.closeCode = 1006
      setTimeout(() => l.onError(err, true), 0)
      return { stop: vi.fn(), finalize: vi.fn() }
    })

    await expect(startTranscription('mic', cb, 'conversation')).rejects.toMatchObject({
      closeCode: 1006
    })
  })
})
