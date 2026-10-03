import { describe, it, expect, vi } from 'vitest'

// The module imports the real axios client for its default deps; the tests pass
// their own fake api, so keep the real one (and Firebase behind it) out of the way.
vi.mock('./apiClient', () => ({ omiApi: {} }))

import {
  candidateDates,
  localDateKey,
  runDailySummaryCatchup,
  slotKey,
  LOOKBACK_DAYS,
  type CatchupApi
} from './dailySummaryCatchup'

// Saturday 2026-10-03, 09:15 local.
const MORNING = new Date(2026, 9, 3, 9, 15)
const LATE = new Date(2026, 9, 3, 23, 5)

function httpError(status: number): Error & { response: { status: number } } {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } })
}

function fakeApi(
  existing: string[],
  postAnswer: (date: string) => unknown
): CatchupApi & {
  posted: string[]
} {
  const posted: string[] = []
  return {
    posted,
    get: vi.fn(async () => ({ data: { summaries: existing.map((date) => ({ id: date, date })) } })),
    post: vi.fn(async (_url: string, body: unknown) => {
      const date = (body as { date: string }).date
      posted.push(date)
      const answer = postAnswer(date)
      if (answer instanceof Error) throw answer
      return { data: { id: `new-${date}`, date } }
    })
  }
}

describe('candidateDates', () => {
  it('covers the previous LOOKBACK_DAYS local days, newest first, and not today before 11 PM', () => {
    const dates = candidateDates(MORNING)
    expect(dates).toHaveLength(LOOKBACK_DAYS)
    expect(dates[0]).toBe('2026-10-02')
    expect(dates).not.toContain('2026-10-03')
    expect(dates[dates.length - 1]).toBe('2026-09-26')
  })

  it('adds today once it is late, after the server’s own 10 PM run', () => {
    expect(candidateDates(LATE)[0]).toBe('2026-10-03')
  })

  it('crosses a month boundary on the local calendar', () => {
    expect(candidateDates(new Date(2026, 9, 1, 8))[0]).toBe('2026-09-30')
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('slotKey', () => {
  it('is one slot for the day and one for late evening', () => {
    expect(slotKey(MORNING)).toBe('2026-10-03|day')
    expect(slotKey(LATE)).toBe('2026-10-03|late')
  })
})

describe('runDailySummaryCatchup', () => {
  it('asks only for the missing days and records each outcome', async () => {
    // Sept 26 exists (the last one the server made); Oct 1 had no recordings.
    const api = fakeApi(['2026-09-26'], (date) => (date === '2026-10-01' ? httpError(400) : null))
    const r = await runDailySummaryCatchup({ api, now: () => MORNING })

    expect(api.posted).not.toContain('2026-09-26')
    expect(api.posted).toEqual([
      '2026-10-02',
      '2026-10-01',
      '2026-09-30',
      '2026-09-29',
      '2026-09-28',
      '2026-09-27'
    ])
    expect(r.created).toHaveLength(5)
    expect(r.nothingToSummarize).toEqual(['2026-10-01'])
    expect(r.stopped).toBe(false)
    expect(r.retryLater).toBe(false)
  })

  it('makes no generate call when every day already has a recap', async () => {
    const api = fakeApi(candidateDates(MORNING), () => null)
    const r = await runDailySummaryCatchup({ api, now: () => MORNING })
    expect(api.post).not.toHaveBeenCalled()
    expect(r.created).toEqual([])
  })

  it.each([402, 429])('stops at the first %i (out of quota / rate limited)', async (status) => {
    const api = fakeApi([], () => httpError(status))
    const r = await runDailySummaryCatchup({ api, now: () => MORNING })
    expect(api.posted).toHaveLength(1)
    expect(r.stopped).toBe(true)
  })

  it('leaves a day the server is busy with (409) or a network failure for the next pass', async () => {
    const api = fakeApi([], (date) =>
      date === '2026-10-02' ? httpError(409) : date === '2026-10-01' ? new Error('offline') : null
    )
    const r = await runDailySummaryCatchup({ api, now: () => MORNING })
    expect(r.retryLater).toBe(true)
    // The other days still go through.
    expect(r.created).toHaveLength(LOOKBACK_DAYS - 2)
  })

  it('sends background calls that never force sign-in and never retry-storm a 429', async () => {
    const api = fakeApi([], () => null)
    await runDailySummaryCatchup({ api, now: () => MORNING })
    expect(api.get).toHaveBeenCalledWith(
      '/v1/users/daily-summaries',
      expect.objectContaining({ __sessionPreserving: true, __noRetry: true })
    )
    expect(api.post).toHaveBeenCalledWith(
      '/v1/users/daily-summaries',
      { date: '2026-10-02' },
      expect.objectContaining({ __sessionPreserving: true, __noRetry: true, timeout: 180_000 })
    )
  })
})
