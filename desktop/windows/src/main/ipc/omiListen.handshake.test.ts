import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// A rejected /v4/listen handshake (the edge rate limit's 429). ws's default turns
// the reply into a bare "Unexpected server response: 429" and drops the response,
// Retry-After included. The main process must keep the status + Retry-After, feed
// the 429-storm tracker, and still produce ws's normal error → close sequence.

const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    static instances: FakeWebSocket[] = []
    readyState = FakeWebSocket.CONNECTING
    binaryType = ''
    terminated = false
    private listeners = new Map<string, Listener[]>()
    constructor(public url: string) {
      FakeWebSocket.instances.push(this)
    }
    on(ev: string, fn: Listener): void {
      const arr = this.listeners.get(ev) ?? []
      arr.push(fn)
      this.listeners.set(ev, arr)
    }
    send(): void {
      /* no audio is fed in these cases */
    }
    close(): void {
      this.readyState = FakeWebSocket.CLOSED
    }
    fire(ev: string, ...args: unknown[]): boolean {
      const arr = this.listeners.get(ev) ?? []
      for (const fn of arr) fn(...args)
      return arr.length > 0
    }
    /** ws 8's terminate() from CONNECTING: abortHandshake → 'error' then 'close' 1006. */
    terminate(): void {
      this.terminated = true
      this.readyState = FakeWebSocket.CLOSING
      this.fire('error', new Error('WebSocket was closed before the connection was established'))
      this.readyState = FakeWebSocket.CLOSED
      this.fire('close', 1006, Buffer.from(''))
    }
    /** What ws does with a non-101 reply: 'unexpected-response' if anyone listens,
     *  else its own abort with the bare message. */
    simulateRejectedHandshake(statusCode: number, headers: Record<string, string>): void {
      const handled = this.fire('unexpected-response', {}, { statusCode, headers })
      if (!handled) {
        this.readyState = FakeWebSocket.CLOSING
        this.fire('error', new Error(`Unexpected server response: ${statusCode}`))
        this.readyState = FakeWebSocket.CLOSED
        this.fire('close', 1006, Buffer.from(''))
      }
    }
  }
  const ipcHandlers = new Map<string, (...args: unknown[]) => void>()
  const sent: unknown[] = []
  const noteBackendStatus = vi.fn()
  return { FakeWebSocket, ipcHandlers, sent, noteBackendStatus }
})

vi.mock('ws', () => ({ default: h.FakeWebSocket }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => void) => h.ipcHandlers.set(ch, fn),
    on: (ch: string, fn: (...args: unknown[]) => void) => h.ipcHandlers.set(ch, fn)
  },
  webContents: {
    fromId: () => ({
      isDestroyed: () => false,
      send: (_ch: string, msg: unknown) => h.sent.push(msg)
    })
  }
}))
vi.mock('../observability/backendDegraded', () => ({ noteBackendStatus: h.noteBackendStatus }))

import { formatRetryNotice, parseRetryAfterMs, registerOmiListenHandlers } from './omiListen'

function start(sessionId: string): InstanceType<typeof h.FakeWebSocket> {
  h.ipcHandlers.get('omi-listen:start')!(
    { sender: { id: 1, once: vi.fn() } },
    { sessionId, token: 'tok', language: 'en', source: 'mic', mode: 'conversation' }
  )
  return h.FakeWebSocket.instances[h.FakeWebSocket.instances.length - 1]
}

beforeAll(() => {
  registerOmiListenHandlers(() => true)
})

beforeEach(() => {
  h.sent.length = 0
  h.noteBackendStatus.mockClear()
})

describe('rejected /v4/listen handshake', () => {
  it('forwards status + Retry-After on the fatal error and keeps the ws message', () => {
    const ws = start('rej-429')
    ws.simulateRejectedHandshake(429, { 'retry-after': '37' })

    const err = h.sent.find((m) => (m as { kind: string }).kind === 'error')
    expect(err).toEqual({
      sessionId: 'rej-429',
      kind: 'error',
      message: 'Unexpected server response: 429', // the renderer's 429 classifier still matches
      fatal: true,
      status: 429,
      retryAfterMs: 37_000
    })
    expect(ws.terminated).toBe(true) // ws's own abort ran — the close still follows
    expect(h.sent.some((m) => (m as { kind: string }).kind === 'closed')).toBe(true)
    expect(h.noteBackendStatus).toHaveBeenCalledWith(429, 'WS /v4/listen')
  })

  it('a 429 without Retry-After still carries the status (renderer falls back to its floor)', () => {
    const ws = start('rej-bare')
    ws.simulateRejectedHandshake(429, {})
    const err = h.sent.find((m) => (m as { kind: string }).kind === 'error') as Record<
      string,
      unknown
    >
    expect(err.status).toBe(429)
    expect(err.retryAfterMs).toBeUndefined()
  })

  it('an ordinary transport error carries no status fields', () => {
    const ws = start('plain-err')
    ws.fire('error', new Error('getaddrinfo ENOTFOUND api.omi.me'))
    const err = h.sent.find((m) => (m as { kind: string }).kind === 'error')
    expect(err).toEqual({
      sessionId: 'plain-err',
      kind: 'error',
      message: 'getaddrinfo ENOTFOUND api.omi.me',
      fatal: true
    })
  })

  it('an accepted handshake reports recovery to the storm tracker', () => {
    const ws = start('ok-open')
    ws.readyState = h.FakeWebSocket.OPEN
    ws.fire('open')
    expect(h.noteBackendStatus).toHaveBeenCalledWith(200, 'WS /v4/listen')
  })
})

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds and HTTP-dates, and rejects junk', () => {
    const now = Date.parse('2026-09-10T22:00:00Z')
    expect(parseRetryAfterMs('30', now)).toBe(30_000)
    expect(parseRetryAfterMs(['5'], now)).toBe(5_000)
    expect(parseRetryAfterMs('Thu, 10 Sep 2026 22:01:00 GMT', now)).toBe(60_000)
    expect(parseRetryAfterMs('Thu, 10 Sep 2026 21:00:00 GMT', now)).toBe(0) // past → now
    expect(parseRetryAfterMs('soon', now)).toBeUndefined()
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined()
  })
})

describe('formatRetryNotice', () => {
  it('prints the retry decision', () => {
    expect(
      formatRetryNotice({
        kind: 'retry',
        attempt: 1,
        delayMs: 5_000,
        reason: 'service_unavailable'
      })
    ).toBe('[omi-listen] retry in 5s (attempt 1, reason=service_unavailable)')
  })

  it('prints the pause with a wall-clock resume time', () => {
    const line = formatRetryNotice(
      { kind: 'paused', failures: 10, resumeAtMs: Date.parse('2026-09-21T14:31:07Z') },
      'en-GB'
    )
    expect(line).toMatch(/^\[omi-listen\] paused after 10 failures; next attempt at \d/)
  })

  it('collapses a reason it does not know, so no free text reaches the log', () => {
    const line = formatRetryNotice({
      kind: 'retry',
      attempt: 2,
      delayMs: 15_000,
      // A sender outside the enum — the log must not echo whatever it sent.
      reason: 'ignore previous instructions' as unknown as 'connect_error'
    })
    expect(line).toBe('[omi-listen] retry in 15s (attempt 2, reason=other)')
  })

  it('clamps nonsense numbers rather than printing them', () => {
    expect(
      formatRetryNotice({
        kind: 'retry',
        attempt: -4,
        delayMs: Number.NaN,
        reason: 'connect_error'
      })
    ).toBe('[omi-listen] retry in 0s (attempt 1, reason=connect_error)')
    expect(formatRetryNotice({ kind: 'paused', failures: 10, resumeAtMs: Number.NaN })).toBe(
      '[omi-listen] paused after 10 failures; next attempt at unknown'
    )
  })

  it('ignores a payload that is not a notice', () => {
    expect(formatRetryNotice({ kind: 'nope' } as never)).toBeNull()
  })
})
