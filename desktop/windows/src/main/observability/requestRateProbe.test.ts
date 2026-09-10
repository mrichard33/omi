import { describe, it, expect } from 'vitest'
import { RequestRateWindow, routeKey } from './requestRateProbe'

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
