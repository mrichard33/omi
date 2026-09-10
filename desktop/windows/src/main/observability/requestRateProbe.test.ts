import { describe, it, expect, vi } from 'vitest'
import { RequestRateWindow, registerRequestRateProbe, routeKey } from './requestRateProbe'

describe('registerRequestRateProbe', () => {
  it('counts token-bearing requests but not CORS preflights (no Authorization)', () => {
    process.env.OMI_REQUEST_RATE_WARN = '2'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let onCompleted: (d: { method: string; url: string }) => void = () => undefined
    const session = {
      webRequest: {
        onCompleted: (_filter: unknown, fn: typeof onCompleted) => {
          onCompleted = fn
        }
      }
    } as unknown as Parameters<typeof registerRequestRateProbe>[0]
    registerRequestRateProbe(session)

    onCompleted({ method: 'OPTIONS', url: 'https://api.omi.me/v1/goals/all' })
    onCompleted({ method: 'OPTIONS', url: 'https://api.omi.me/v3/memories' })
    expect(warn).not.toHaveBeenCalled() // two preflights spend nothing
    onCompleted({ method: 'GET', url: 'https://api.omi.me/v1/goals/all' })
    onCompleted({ method: 'GET', url: 'https://api.omi.me/v3/memories?limit=5' })
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain('2 api.omi.me requests')
    expect(String(warn.mock.calls[0][0])).not.toContain('OPTIONS')

    warn.mockRestore()
    delete process.env.OMI_REQUEST_RATE_WARN
  })
})

describe('routeKey', () => {
  it('keeps method + plain path words, collapses ids, drops the query', () => {
    expect(routeKey('get', 'https://api.omi.me/v1/conversations?limit=50&offset=0')).toBe(
      'GET /v1/conversations'
    )
    expect(
      routeKey('PATCH', 'https://api.omi.me/v1/action-items/3f2a9c1e-77aa-4d1b-9e0f-2b8c1d4e5f60')
    ).toBe('PATCH /v1/action-items/:id')
  })

  it('never lets an email, date or token-like segment into the key', () => {
    expect(routeKey('GET', 'https://api.omi.me/v1/users/someone@example.com/profile')).toBe(
      'GET /v1/users/:id/profile'
    )
    expect(routeKey('GET', 'https://api.omi.me/v2/daily/2026-09-10')).toBe('GET /v2/daily/:id')
  })
})

describe('RequestRateWindow', () => {
  it('reports once when a minute reaches the threshold, naming the top routes', () => {
    let t = 0
    const w = new RequestRateWindow(5, 60_000, () => t)
    const keys = ['GET /v1/a', 'GET /v1/a', 'GET /v1/a', 'GET /v1/b']
    for (const k of keys) {
      expect(w.record(k)).toBeNull()
      t += 1_000
    }
    const report = w.record('WS /v4/listen')
    expect(report).toEqual({
      total: 5,
      top: [
        ['GET /v1/a', 3],
        ['GET /v1/b', 1],
        ['WS /v4/listen', 1]
      ]
    })
    // Still hot, but it already warned this window — stays quiet.
    expect(w.record('GET /v1/a')).toBeNull()
  })

  it('ages requests out of the sliding window', () => {
    let t = 0
    const w = new RequestRateWindow(3, 60_000, () => t)
    w.record('GET /v1/a')
    w.record('GET /v1/a')
    t = 61_000 // the first two are now older than a minute
    expect(w.record('GET /v1/a')).toBeNull()
  })
})
