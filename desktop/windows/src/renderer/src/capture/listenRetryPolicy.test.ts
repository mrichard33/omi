import { describe, expect, it } from 'vitest'
import {
  CIRCUIT_PAUSE_MS,
  LADDER_MS,
  MAX_CONSECUTIVE_FAILURES,
  RATE_LIMIT_FLOOR_MS,
  RETRY_AFTER_CAP_MS,
  classifyFailure,
  createListenRetryPolicy,
  type ListenFailure
} from './listenRetryPolicy'

/** A drop that proves nothing: connected, then died before any transcript. */
function deadOnArrival(over: Partial<ListenFailure> = {}): ListenFailure {
  return {
    message: 'Omi /v4/listen closed (1011) transcription_service_unavailable',
    closeCode: 1011,
    connectedForMs: 2_000,
    deliveredSegments: false,
    ...over
  }
}

/** rand() = 0.5 sits exactly on the rung, so ladder assertions read as the schedule. */
const neutral = { rand: () => 0.5 }

describe('the ladder', () => {
  it('climbs 5/15/45/120/300s and then holds', () => {
    const p = createListenRetryPolicy(neutral)
    const delays = Array.from({ length: 7 }, () => p.onFailure(deadOnArrival()))
    expect(delays.map((d) => (d.action === 'retry' ? d.delayMs : `pause`))).toEqual([
      5_000, 15_000, 45_000, 120_000, 300_000, 300_000, 300_000
    ])
  })

  it('never lets a rung fall outside ±20%', () => {
    for (let i = 0; i < 50; i++) {
      const r = i / 50
      const p = createListenRetryPolicy({ rand: () => r })
      const d = p.onFailure(deadOnArrival())
      if (d.action !== 'retry') throw new Error('expected a retry')
      expect(d.delayMs).toBeGreaterThanOrEqual(LADDER_MS[0] * 0.8)
      expect(d.delayMs).toBeLessThanOrEqual(LADDER_MS[0] * 1.2)
    }
  })

  it('spreads the first rung across the full ±20% band', () => {
    const at = (r: number): number => {
      const d = createListenRetryPolicy({ rand: () => r }).onFailure(deadOnArrival())
      return d.action === 'retry' ? d.delayMs : -1
    }
    expect(at(0)).toBe(4_000)
    expect(at(0.5)).toBe(5_000)
    expect(at(0.999)).toBe(5_998)
  })
})

describe('429 handling', () => {
  const rateLimited = (over: Partial<ListenFailure> = {}): ListenFailure =>
    deadOnArrival({
      message: 'Unexpected server response: 429',
      status: 429,
      closeCode: 1006,
      connectedForMs: 0,
      ...over
    })

  it('never retries sooner than 60s, for any jitter draw', () => {
    for (let i = 0; i < 50; i++) {
      const p = createListenRetryPolicy({ rand: () => i / 50 })
      const d = p.onFailure(rateLimited())
      if (d.action !== 'retry') throw new Error('expected a retry')
      expect(d.delayMs).toBeGreaterThanOrEqual(RATE_LIMIT_FLOOR_MS)
      expect(d.reason).toBe('rate_limited')
    }
  })

  it('honors a Retry-After longer than the floor', () => {
    const p = createListenRetryPolicy({ rand: () => 0 })
    const d = p.onFailure(rateLimited({ retryAfterMs: 90_000 }))
    expect(d.action === 'retry' && d.delayMs).toBe(90_000)
  })

  it('does not let a short Retry-After undercut the 60s floor', () => {
    const p = createListenRetryPolicy({ rand: () => 0 })
    const d = p.onFailure(rateLimited({ retryAfterMs: 10_000 }))
    expect(d.action === 'retry' && d.delayMs).toBe(RATE_LIMIT_FLOOR_MS)
  })

  it('clamps an absurd Retry-After to the cap', () => {
    const p = createListenRetryPolicy({ rand: () => 0 })
    const d = p.onFailure(rateLimited({ retryAfterMs: 86_400_000 }))
    expect(d.action === 'retry' && d.delayMs).toBe(RETRY_AFTER_CAP_MS)
  })

  it('ignores a NaN Retry-After and falls back to the floor', () => {
    const p = createListenRetryPolicy({ rand: () => 0 })
    const d = p.onFailure(rateLimited({ retryAfterMs: Number.NaN }))
    expect(d.action === 'retry' && d.delayMs).toBe(RATE_LIMIT_FLOOR_MS)
  })

  it('recognises the 1008 rate-limit close, which carries no HTTP status', () => {
    const p = createListenRetryPolicy({ rand: () => 0 })
    const d = p.onFailure(
      deadOnArrival({
        message: 'Omi transcribe-stream closed (1008) Rate limit exceeded. Retry in 30s.',
        closeCode: 1008,
        status: undefined
      })
    )
    expect(d.action === 'retry' && d.delayMs).toBe(RATE_LIMIT_FLOOR_MS)
  })
})

describe('what resets the budget', () => {
  // The live bug: ten sockets that connected and died seconds later kept the lane
  // pinned on the first rung. The ladder must climb through all of them.
  it('a connect that dies in seconds does NOT reset it', () => {
    const p = createListenRetryPolicy(neutral)
    const first = p.onFailure(deadOnArrival())
    const second = p.onFailure(deadOnArrival())
    const third = p.onFailure(deadOnArrival())
    expect([first, second, third].map((d) => (d.action === 'retry' ? d.delayMs : -1))).toEqual([
      5_000, 15_000, 45_000
    ])
  })

  it('a session that lived 60s resets it', () => {
    const p = createListenRetryPolicy(neutral)
    p.onFailure(deadOnArrival())
    p.onFailure(deadOnArrival())
    p.onFailure(deadOnArrival())
    const after = p.onFailure(deadOnArrival({ connectedForMs: 60_000 }))
    expect(after.action === 'retry' && after.delayMs).toBe(5_000)
  })

  it('59.999s is not long enough', () => {
    const p = createListenRetryPolicy(neutral)
    p.onFailure(deadOnArrival())
    const after = p.onFailure(deadOnArrival({ connectedForMs: 59_999 }))
    expect(after.action === 'retry' && after.delayMs).toBe(15_000)
  })

  it('a delivered segment resets it however short the session was', () => {
    const p = createListenRetryPolicy(neutral)
    p.onFailure(deadOnArrival())
    p.onFailure(deadOnArrival())
    const after = p.onFailure(deadOnArrival({ connectedForMs: 1_200, deliveredSegments: true }))
    expect(after.action === 'retry' && after.delayMs).toBe(5_000)
  })

  it('noteHealthy() resets it between failures', () => {
    const p = createListenRetryPolicy(neutral)
    p.onFailure(deadOnArrival())
    p.onFailure(deadOnArrival())
    p.noteHealthy()
    expect(p.state()).toEqual({ failures: 0, pausedUntil: null })
    const after = p.onFailure(deadOnArrival())
    expect(after.action === 'retry' && after.delayMs).toBe(5_000)
  })
})

describe('the circuit breaker', () => {
  it('retries nine times, then pauses for ten minutes', () => {
    const clock = 1_000_000
    const p = createListenRetryPolicy({ now: () => clock, rand: () => 0.5 })
    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      expect(p.onFailure(deadOnArrival()).action).toBe('retry')
    }
    const opened = p.onFailure(deadOnArrival())
    expect(opened).toEqual({
      action: 'pause',
      delayMs: CIRCUIT_PAUSE_MS,
      resumeAtMs: clock + CIRCUIT_PAUSE_MS,
      failures: MAX_CONSECUTIVE_FAILURES,
      reason: 'service_unavailable'
    })
    expect(p.state().pausedUntil).toBe(clock + CIRCUIT_PAUSE_MS)
  })

  it('re-pauses when the half-open probe also fails — never another storm', () => {
    let clock = 0
    const p = createListenRetryPolicy({ now: () => clock, rand: () => 0.5 })
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) p.onFailure(deadOnArrival())
    clock += CIRCUIT_PAUSE_MS
    const probeFailed = p.onFailure(deadOnArrival())
    expect(probeFailed.action).toBe('pause')
    expect(probeFailed.action === 'pause' && probeFailed.resumeAtMs).toBe(clock + CIRCUIT_PAUSE_MS)
  })

  it('a healthy probe closes the breaker and the ladder starts over', () => {
    const p = createListenRetryPolicy(neutral)
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) p.onFailure(deadOnArrival())
    p.noteHealthy()
    expect(p.state()).toEqual({ failures: 0, pausedUntil: null })
    const next = p.onFailure(deadOnArrival())
    expect(next.action === 'retry' && next.delayMs).toBe(5_000)
  })

  it('a probe that succeeds through onFailure alone also resets', () => {
    // No noteHealthy() call: the socket simply outlived HEALTHY_SESSION_MS before
    // dropping, which is proof enough on its own.
    const p = createListenRetryPolicy(neutral)
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) p.onFailure(deadOnArrival())
    const after = p.onFailure(deadOnArrival({ connectedForMs: 120_000 }))
    expect(after.action === 'retry' && after.delayMs).toBe(5_000)
  })
})

describe('clean closes', () => {
  it('reconnect promptly and never strike', () => {
    const p = createListenRetryPolicy(neutral)
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 2; i++) {
      const d = p.onFailure(
        deadOnArrival({
          message: 'Omi /v4/listen closed (1000) watchdog: stale',
          closeCode: 1000
        })
      )
      expect(d.action).toBe('retry')
      expect(d.action === 'retry' && d.delayMs).toBe(5_000)
      expect(d.reason).toBe('clean_restart')
    }
    expect(p.state().failures).toBe(0)
  })

  it('treats 1001 going-away (sleep) the same', () => {
    const p = createListenRetryPolicy(neutral)
    const d = p.onFailure(deadOnArrival({ message: 'closed (1001)', closeCode: 1001 }))
    expect(d.reason).toBe('clean_restart')
    expect(p.state().failures).toBe(0)
  })
})

describe('classifyFailure', () => {
  it('names each reason', () => {
    expect(classifyFailure(deadOnArrival({ status: 429 })).valueOf()).toBe('rate_limited')
    expect(classifyFailure(deadOnArrival({ closeCode: 1011 }))).toBe('service_unavailable')
    expect(classifyFailure(deadOnArrival({ closeCode: 1000 }))).toBe('clean_restart')
    expect(classifyFailure(deadOnArrival({ closeCode: 1001 }))).toBe('clean_restart')
    expect(classifyFailure(deadOnArrival({ closeCode: 1006 }))).toBe('abnormal_close')
    expect(
      classifyFailure({
        message: 'could not connect',
        connectedForMs: 0,
        deliveredSegments: false
      })
    ).toBe('connect_error')
  })

  it('reads a rate limit ahead of the close code it arrived on', () => {
    // A rejected 429 handshake aborts as a 1006; the 429 is the real reason.
    expect(
      classifyFailure(
        deadOnArrival({ message: 'Unexpected server response: 429', status: 429, closeCode: 1006 })
      )
    ).toBe('rate_limited')
  })
})
