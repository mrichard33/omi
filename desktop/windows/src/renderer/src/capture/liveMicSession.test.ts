import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TranscriptionCallbacks } from '../lib/transcriptionClient'

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Capture every startTranscription call so the test can drive its callbacks and
// assert the mode + clientConversationId passed on each (re)connect.
type Call = {
  source: string
  cb: TranscriptionCallbacks
  mode?: string
  clientConversationId?: string
}
const calls: Call[] = []
const stop = vi.fn()
const finalizeHandle = vi.fn()

// Preserve the module's real exports and mock only startTranscription.
vi.mock('../lib/transcriptionClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/transcriptionClient')>()
  return {
    ...actual,
    startTranscription: vi.fn(
      async (
        source: string,
        cb: TranscriptionCallbacks,
        mode?: string,
        clientConversationId?: string
      ) => {
        calls.push({ source, cb, mode, clientConversationId })
        return { stop, finalize: finalizeHandle }
      }
    )
  }
})

vi.mock('../lib/liveConversation', () => ({
  isConversationBoundary: () => false,
  onFinalizeRequest: () => () => {}
}))

vi.mock('../lib/retentionRules', () => ({
  transcriptWordCount: (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0)
}))

vi.mock('../lib/voice/injectedTranscript', () => ({
  isInjectedLineId: () => false
}))

const storeSegments: { id?: string; speaker?: string; text: string }[] = []
vi.mock('./liveStore', () => ({
  captureLiveStore: {
    reset: vi.fn(() => {
      storeSegments.length = 0
    }),
    setStatus: vi.fn(),
    appendLine: vi.fn((l: { id?: string; speaker?: string; text: string }) =>
      storeSegments.push(l)
    ),
    saved: vi.fn(),
    getSegments: () => storeSegments
  }
}))

const syncLocalConversation = vi.fn(async (_row: unknown) => ({
  status: 'done',
  cloudId: 'c1',
  deduped: false
}))
vi.mock('../lib/sync/conversationSync', () => ({
  syncLocalConversation: (row: unknown) => syncLocalConversation(row)
}))

const trackEvent = vi.fn()
vi.mock('../lib/analytics', () => ({
  trackEvent: (event: string, props?: Record<string, unknown>) => trackEvent(event, props)
}))

// The REAL conversationFinalize module runs; only its transport is stubbed, so
// these tests exercise the actual close-code rule and the actual streaming guard
// rather than a re-statement of them.
const finalizePost = vi.fn(async () => ({ data: {} }))
vi.mock('../lib/apiClient', () => ({
  omiApi: {
    post: (...a: unknown[]) => finalizePost(...(a as [])),
    get: async () => ({ data: [] })
  }
}))

import {
  getLiveMicSessionHealth,
  isLiveMicSessionActive,
  startLiveMicSession,
  waitForLiveMicSessionReady
} from './liveMicSession'
import { MAX_CONSECUTIVE_FAILURES } from './listenRetryPolicy'
import {
  FINALIZE_GRACE_MS,
  __resetConversationFinalizeStateForTests
} from '../lib/conversationFinalize'

// Longer than any single rung of the reconnect ladder (300s, and rand is pinned to
// 0 so the ±20% jitter subtracts): advancing by this always fires the next connect.
const PAST_BACKOFF_MS = 240_000
// The first rung, with rand pinned to 0: 5s - 20%.
const FIRST_RUNG_MS = 4_000

const insertLocalConversation = vi.fn(async (_row: unknown) => {})
const notifyConversationsChanged = vi.fn()
const listenRetryNotice = vi.fn()

/** The callbacks the most recent (re)connect registered. */
function latest(): Call {
  return calls[calls.length - 1]
}

beforeEach(() => {
  vi.useFakeTimers()
  // Every rung carries ±20% jitter. Pin rand to 0 so each delay is exactly 0.8x its
  // rung and the timing assertions below are arithmetic, not a range.
  vi.spyOn(Math, 'random').mockReturnValue(0)
  calls.length = 0
  storeSegments.length = 0
  stop.mockClear()
  syncLocalConversation.mockClear()
  insertLocalConversation.mockClear()
  notifyConversationsChanged.mockClear()
  listenRetryNotice.mockClear()
  trackEvent.mockClear()
  finalizePost.mockClear()
  __resetConversationFinalizeStateForTests()
  vi.stubGlobal('window', {
    omi: { insertLocalConversation, notifyConversationsChanged, listenRetryNotice }
  })
  if (!globalThis.crypto?.randomUUID) {
    let n = 0
    vi.stubGlobal('crypto', { randomUUID: () => `uuid-${n++}` })
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('startLiveMicSession', () => {
  it('opens a conversation-mode /v4/listen session with a client_conversation_id', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0) // fire the deferred initial connect
    expect(calls).toHaveLength(1)
    expect(latest().source).toBe('mic')
    expect(latest().mode).toBe('conversation')
    expect(latest().clientConversationId).toBeTruthy()
    ctrl.stop()
  })

  it('reconnects on a drop and RESUMES the same conversation id', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    const firstId = latest().clientConversationId
    // Prove it was live, then drop the socket.
    latest().cb.onBackend('omi')
    latest().cb.onError(new Error('socket dropped'))
    // The first rung is 5s, minus the pinned-to-zero jitter.
    await vi.advanceTimersByTimeAsync(FIRST_RUNG_MS)
    expect(calls).toHaveLength(2)
    expect(latest().clientConversationId).toBe(firstId) // resume, not a new conversation
    ctrl.stop()
  })

  it('when the breaker opens, rescues the recording via a from-segments upload', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    // Capture enough speech that the rescue is worth uploading (≥ 5 words).
    latest().cb.onSegments?.([
      { id: 's1', text: 'this is a genuine long enough sentence', is_user: true, start: 0, end: 2 }
    ])
    // Drive drops until the breaker opens. Each onError schedules the next attempt;
    // advance past the longest rung so the next connect fires.
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      latest().cb.onError(new Error('outage'))
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    }

    expect(insertLocalConversation).toHaveBeenCalledOnce()
    const row = insertLocalConversation.mock.calls[0][0] as unknown as {
      syncState: string
      segments: { text: string }[]
      transcript: string
    }
    // Inserted 'unconfirmed' so the outbox dedupes against the cloud before posting
    // (never double-creates if the backend also finalized the pre-drop audio).
    expect(row.syncState).toBe('unconfirmed')
    expect(row.segments).toHaveLength(1)
    expect(row.transcript).toContain('genuine long enough sentence')
    expect(syncLocalConversation).toHaveBeenCalledOnce()
    // Standing down is reported, once, as the mode change it is: the recording is
    // now riding the client-side rescue path rather than a backend conversation.
    expect(trackEvent).toHaveBeenCalledWith('fallback_triggered', {
      component: 'live_capture',
      from: 'v4_listen',
      to: 'from_segments',
      reason: 'circuit_open',
      outcome: 'exhausted'
    })
    expect(listenRetryNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'paused', failures: MAX_CONSECUTIVE_FAILURES })
    )
    ctrl.stop()
  })

  // THE REGRESSION. Before this, onBackend reset the attempt counter, so a socket
  // that connected and died seconds later kept the lane on the first rung. Live,
  // that meant a reconnect every ~8s for 47 minutes, straight into a 429 storm.
  it('does NOT reset the ladder when a connect dies seconds later', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)

    const drop = async (advanceMs: number): Promise<number> => {
      latest().cb.onBackend('omi') // the socket reached OPEN — which proves nothing
      await vi.advanceTimersByTimeAsync(2_000) // ...and died two seconds later
      const before = calls.length
      latest().cb.onError(
        Object.assign(new Error('closed (1011) transcription_service_unavailable'), {
          closeCode: 1011
        })
      )
      await vi.advanceTimersByTimeAsync(advanceMs - 1)
      const early = calls.length
      await vi.advanceTimersByTimeAsync(1)
      expect(early).toBe(before) // nothing reconnected before the rung elapsed
      return calls.length
    }

    expect(await drop(4_000)).toBe(2) // 5s  - 20%
    expect(await drop(12_000)).toBe(3) // 15s - 20%
    expect(await drop(36_000)).toBe(4) // 45s - 20%
    ctrl.stop()
  })

  it('resets the ladder once a session has lived a full minute', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    // Climb two rungs on fast-dying sockets...
    latest().cb.onError(new Error('outage'))
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    latest().cb.onError(new Error('outage'))
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    // ...then a socket that simply stays up long enough to count as healthy.
    latest().cb.onBackend('omi')
    await vi.advanceTimersByTimeAsync(61_000)
    const before = calls.length
    latest().cb.onError(new Error('outage'))
    await vi.advanceTimersByTimeAsync(FIRST_RUNG_MS)
    expect(calls.length).toBe(before + 1) // back to the first rung, not the third
    ctrl.stop()
  })

  it('resets the ladder on a delivered segment however short the socket lived', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    latest().cb.onError(new Error('outage'))
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    latest().cb.onError(new Error('outage'))
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    latest().cb.onBackend('omi')
    latest().cb.onSegments?.([
      { id: 's9', text: 'a real transcript', is_user: true, start: 0, end: 1 }
    ])
    const before = calls.length
    latest().cb.onError(new Error('outage'))
    await vi.advanceTimersByTimeAsync(FIRST_RUNG_MS)
    expect(calls.length).toBe(before + 1)
    ctrl.stop()
  })

  it('waits out a 429 Retry-After before reconnecting', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    latest().cb.onError(
      Object.assign(new Error('Unexpected server response: 429'), {
        status: 429,
        retryAfterMs: 90_000
      })
    )
    await vi.advanceTimersByTimeAsync(89_000)
    expect(calls).toHaveLength(1) // still standing down
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toHaveLength(2)
    ctrl.stop()
  })

  it('pauses for ten minutes, then resumes on a fresh conversation', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    const firstId = latest().clientConversationId
    // Nine drops climb the ladder; the tenth opens the breaker. The cooldown is
    // timed from THAT drop, so it is fired without advancing past it first.
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
      latest().cb.onError(new Error('outage'))
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    }
    latest().cb.onError(new Error('outage'))
    const atPause = calls.length
    expect(listenRetryNotice).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'paused', failures: MAX_CONSECUTIVE_FAILURES })
    )
    await vi.advanceTimersByTimeAsync(599_999)
    expect(calls.length).toBe(atPause) // silent for the whole cooldown
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.length).toBe(atPause + 1) // exactly one half-open probe
    // A new id: the retained transcript was already rescued under the old one, so
    // resuming it would post the same speech twice.
    expect(latest().clientConversationId).not.toBe(firstId)
    ctrl.stop()
  })

  it('reconnects a clean 1000 close promptly and never counts it against the breaker', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    // The main process force-closes a stale socket with 1000 SO THAT this lane
    // reconnects. Twelve of those must not trip a ten-failure breaker.
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 2; i++) {
      latest().cb.onError(
        Object.assign(new Error('closed (1000) watchdog: stale'), { closeCode: 1000 })
      )
      await vi.advanceTimersByTimeAsync(FIRST_RUNG_MS)
    }
    expect(calls).toHaveLength(MAX_CONSECUTIVE_FAILURES + 3)
    expect(insertLocalConversation).not.toHaveBeenCalled() // never rescued, never paused
    ctrl.stop()
  })

  it('stop() cancels a pending resume', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      latest().cb.onError(new Error('outage'))
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    }
    const atPause = calls.length
    ctrl.stop()
    await vi.advanceTimersByTimeAsync(700_000)
    expect(calls.length).toBe(atPause)
  })

  it('does NOT reconnect on a quota/entitlement error — surfaces it immediately', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    latest().cb.onError(
      new Error('Omi transcription stopped: free Omi transcription quota is used up (1008)')
    )
    // Give any (wrongly-scheduled) reconnect ample time to fire — none should.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    expect(insertLocalConversation).not.toHaveBeenCalled()
    ctrl.stop()
  })

  it('does NOT rescue a trivial blip (< 5 words) when the breaker opens', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    latest().cb.onSegments?.([{ id: 's1', text: 'hi there', is_user: true, start: 0, end: 1 }])
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      latest().cb.onError(new Error('outage'))
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    }
    expect(insertLocalConversation).not.toHaveBeenCalled()
    ctrl.stop()
  })

  it('reports active while running and clears on stop (C6 defer signal)', async () => {
    const ctrl = startLiveMicSession()
    expect(isLiveMicSessionActive()).toBe(true)
    expect(getLiveMicSessionHealth()).toBe('connecting')
    await vi.advanceTimersByTimeAsync(0)
    const ready = waitForLiveMicSessionReady()
    latest().cb.onBackend('omi')
    await expect(ready).resolves.toBe(true)
    expect(getLiveMicSessionHealth()).toBe('ready')
    ctrl.stop()
    expect(isLiveMicSessionActive()).toBe(false)
    expect(getLiveMicSessionHealth()).toBe('inactive')
    ctrl.stop() // idempotent — must not drive the count negative
    expect(isLiveMicSessionActive()).toBe(false)
  })

  it('reports terminal startup failure to delegated meeting readiness', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    const ready = waitForLiveMicSessionReady()

    latest().cb.onError(new Error('Omi transcription unavailable (not signed in)'))

    await expect(ready).resolves.toBe(false)
    expect(getLiveMicSessionHealth()).toBe('failed')
    ctrl.stop()
  })
})

// THE STRANDED-CONVERSATION REGRESSION (measured 2026-09-22): 33 of 36 desktop
// conversations sat at "Processing" for 2h–4d because /v4/listen only finalizes
// a desktop conversation when its teardown sees close code 1000
// (backend/routers/listen/runtime.py), and nothing in this client ever asked for
// one by id. These cover the three live triggers; the sweep and the close-code
// rule itself are covered in lib/conversationFinalize.test.ts.
describe('startLiveMicSession — conversation finalize', () => {
  const announce = (id: string): void =>
    latest().cb.onEvent?.({
      type: 'conversation_session',
      raw: { type: 'conversation_session', conversation_id: id }
    })

  // Segments alone: this is what the backend stored, and what decides whether an
  // abnormally-closed conversation has content worth finalizing.
  const receiveSegments = (text = 'a long enough sentence to finalize'): void => {
    latest().cb.onSegments?.([{ id: 's1', text, is_user: true, start: 0, end: 2 }])
  }

  // Segments AND a delivered line — the line is what arms the 30s silence timer,
  // so only the tests that want a silence finalize use this.
  const speak = (text = 'this is a long enough sentence to finalize'): void => {
    receiveSegments(text)
    latest().cb.onLine({ id: 's1', text })
  }

  it('finalizes the conversation when the session stops', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    latest().cb.onBackend('omi')
    announce('conv-stop')
    speak()

    ctrl.stop()
    await vi.advanceTimersByTimeAsync(FINALIZE_GRACE_MS)
    expect(finalizePost).toHaveBeenCalledWith('/v1/conversations/conv-stop/finalize', {})
  })

  it('finalizes the conversation the silence timeout closes, then starts a new one', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    latest().cb.onBackend('omi')
    announce('conv-silence')
    speak()

    // 30s of silence ends the conversation; the grace delay then finalizes it.
    await vi.advanceTimersByTimeAsync(30_000 + FINALIZE_GRACE_MS)
    expect(finalizePost).toHaveBeenCalledWith('/v1/conversations/conv-silence/finalize', {})
    ctrl.stop()
  })

  it('finalizes after an abnormal close once the lane gives up (1011 + real audio)', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    latest().cb.onBackend('omi')
    announce('conv-1011')
    receiveSegments()

    const drop = (): void => {
      latest().cb.onError(
        Object.assign(new Error('closed (1011) transcription_service_unavailable'), {
          closeCode: 1011
        })
      )
    }
    // Reconnects RESUME the same conversation, so nothing is finalized while the
    // lane is still trying — only when the breaker opens and abandons it.
    drop()
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    expect(finalizePost).not.toHaveBeenCalled()

    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      drop()
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    }
    expect(finalizePost).toHaveBeenCalledWith('/v1/conversations/conv-1011/finalize', {})
    ctrl.stop()
  })

  it('does NOT finalize an abnormal close that carried no audio', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    latest().cb.onBackend('omi')
    announce('conv-empty') // announced, but not one segment ever arrived

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      latest().cb.onError(Object.assign(new Error('outage'), { closeCode: 1011 }))
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS)
    }
    await vi.advanceTimersByTimeAsync(FINALIZE_GRACE_MS)
    expect(finalizePost).not.toHaveBeenCalled()
    ctrl.stop()
  })

  it('finalizes the id the BACKEND named, not the one we proposed', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    const proposed = latest().clientConversationId
    latest().cb.onBackend('omi')
    announce('server-rolled-id') // the backend rolled to an id of its own
    speak()

    ctrl.stop()
    await vi.advanceTimersByTimeAsync(FINALIZE_GRACE_MS)
    expect(finalizePost).toHaveBeenCalledWith('/v1/conversations/server-rolled-id/finalize', {})
    expect(finalizePost).not.toHaveBeenCalledWith(`/v1/conversations/${proposed}/finalize`, {})
  })

  it('never finalizes a conversation that is still streaming', async () => {
    const ctrl = startLiveMicSession()
    await vi.advanceTimersByTimeAsync(0)
    latest().cb.onBackend('omi')
    announce('conv-live')
    speak()

    // Still live: no stop, no abandonment, and well past any grace delay.
    await vi.advanceTimersByTimeAsync(FINALIZE_GRACE_MS * 4)
    expect(finalizePost).not.toHaveBeenCalled()
    ctrl.stop()
  })
})
