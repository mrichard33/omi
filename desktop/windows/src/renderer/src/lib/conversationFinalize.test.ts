import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const post = vi.fn(async (_url: string, _body?: unknown) => ({ data: {} }))
const get = vi.fn(async (_url: string, _config?: { params?: Record<string, unknown> }) => ({
  data: [] as unknown[]
}))
// Wrapped in arrows, not passed directly: vi.mock's factory is hoisted above the
// const declarations above, so naming them here would read them before init.
vi.mock('./apiClient', () => ({
  omiApi: {
    post: (url: string, body?: unknown) => post(url, body),
    get: (url: string, config?: { params?: Record<string, unknown> }) => get(url, config)
  }
}))

import {
  conversationIdFromEvent,
  finalizeConversation,
  markConversationSettled,
  markConversationStreaming,
  runFinalizeSweep,
  scheduleFinalize,
  selectSweepCandidates,
  shouldFinalizeAfterClose,
  SWEEP_MIN_IDLE_MS,
  __resetConversationFinalizeStateForTests
} from './conversationFinalize'

const MINUTE = 60_000
const iso = (ms: number): string => new Date(ms).toISOString()

beforeEach(() => {
  __resetConversationFinalizeStateForTests()
  post.mockClear()
  post.mockResolvedValue({ data: {} })
  get.mockClear()
  get.mockResolvedValue({ data: [] })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// The close-code rule is the whole point of this module: /v4/listen only
// finalizes a desktop conversation itself when its teardown sees close code 1000
// (backend/routers/listen/runtime.py). Everything else strands it.
describe('shouldFinalizeAfterClose', () => {
  it('finalizes after an abnormal close that carried real audio', () => {
    expect(shouldFinalizeAfterClose(1011, 4)).toBe(true) // STT provider failure
    expect(shouldFinalizeAfterClose(1006, 1)).toBe(true) // connection dropped
    expect(shouldFinalizeAfterClose(1008, 2)).toBe(true) // quota/entitlement close
    expect(shouldFinalizeAfterClose(undefined, 3)).toBe(true) // no close frame at all
  })

  it('does not finalize an abnormal close with zero segments', () => {
    expect(shouldFinalizeAfterClose(1011, 0)).toBe(false)
    expect(shouldFinalizeAfterClose(1006, 0)).toBe(false)
  })

  it('leaves a clean 1000 close to the backend, which finalizes it itself', () => {
    expect(shouldFinalizeAfterClose(1000, 9)).toBe(false)
  })
})

describe('conversationIdFromEvent', () => {
  it('reads the id the backend announces', () => {
    expect(
      conversationIdFromEvent({
        type: 'conversation_session',
        raw: { type: 'conversation_session', conversation_id: 'conv-1' }
      })
    ).toBe('conv-1')
  })

  it('ignores every other event and a malformed id', () => {
    expect(conversationIdFromEvent({ type: 'memory_creating', raw: {} })).toBeNull()
    expect(
      conversationIdFromEvent({ type: 'conversation_session', raw: { conversation_id: 7 } })
    ).toBeNull()
  })
})

describe('selectSweepCandidates', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z')

  it('picks only conversations idle past the cutoff', () => {
    const ids = selectSweepCandidates(
      [
        { id: 'old', status: 'in_progress', finished_at: iso(now - 30 * MINUTE) },
        { id: 'just-idle', status: 'in_progress', finished_at: iso(now - 6 * MINUTE) },
        { id: 'fresh', status: 'in_progress', finished_at: iso(now - MINUTE) }
      ],
      { now }
    )
    expect(ids).toEqual(['old', 'just-idle'])
  })

  it('never touches a conversation this app is still streaming into', () => {
    markConversationStreaming('live')
    const rows = [
      { id: 'live', status: 'in_progress' as const, finished_at: iso(now - 30 * MINUTE) },
      { id: 'orphan', status: 'in_progress' as const, finished_at: iso(now - 30 * MINUTE) }
    ]
    expect(selectSweepCandidates(rows, { now })).toEqual(['orphan'])

    markConversationSettled('live')
    expect(selectSweepCandidates(rows, { now })).toEqual(['live', 'orphan'])
  })

  it('skips rows with no readable idle clock, and rows already past in_progress', () => {
    expect(
      selectSweepCandidates(
        [
          { id: 'no-clock', status: 'in_progress', finished_at: null },
          { id: 'bad-clock', status: 'in_progress', finished_at: 'not-a-date' },
          { id: 'already-done', status: 'completed', finished_at: iso(now - 30 * MINUTE) }
        ],
        { now }
      )
    ).toEqual([])
  })

  it('uses the 5-minute idle cutoff by default', () => {
    const rows = [
      { id: 'c', status: 'in_progress' as const, finished_at: iso(now - SWEEP_MIN_IDLE_MS - 1) }
    ]
    expect(selectSweepCandidates(rows, { now })).toEqual(['c'])
    expect(
      selectSweepCandidates(
        [{ id: 'c', status: 'in_progress', finished_at: iso(now - SWEEP_MIN_IDLE_MS + 1) }],
        { now }
      )
    ).toEqual([])
  })
})

describe('finalizeConversation', () => {
  it('posts the by-id finalize and logs one ok line', async () => {
    const log = vi.spyOn(console, 'log')
    await expect(finalizeConversation('conv-1', 'stop')).resolves.toBe(true)
    expect(post).toHaveBeenCalledWith('/v1/conversations/conv-1/finalize', {})
    expect(log).toHaveBeenCalledWith('[omi-finalize] conversation conv-1 reason=stop result=ok')
  })

  it('reports a failure as result=error and never throws', async () => {
    const warn = vi.spyOn(console, 'warn')
    post.mockRejectedValueOnce(new Error('Request failed with status code 404'))
    await expect(finalizeConversation('conv-2', 'sweep')).resolves.toBe(false)
    expect(warn.mock.calls[0][0]).toContain(
      '[omi-finalize] conversation conv-2 reason=sweep result=error'
    )
  })

  it('refuses a conversation that is still actively streaming', async () => {
    markConversationStreaming('conv-live')
    await expect(finalizeConversation('conv-live', 'sweep')).resolves.toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('does not re-post a conversation it already finalized', async () => {
    await finalizeConversation('conv-3', 'stop')
    await finalizeConversation('conv-3', 'sweep')
    expect(post).toHaveBeenCalledTimes(1)
  })
})

describe('scheduleFinalize', () => {
  it('releases the conversation and finalizes it after the grace delay', async () => {
    vi.useFakeTimers()
    markConversationStreaming('conv-4')
    scheduleFinalize('conv-4', 'meeting_end', 100)
    expect(post).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(post).toHaveBeenCalledWith('/v1/conversations/conv-4/finalize', {})
  })
})

describe('runFinalizeSweep', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z')

  it('finalizes only the stale rows, and never the one still streaming', async () => {
    markConversationStreaming('streaming')
    get.mockResolvedValueOnce({
      data: [
        { id: 'streaming', status: 'in_progress', finished_at: iso(now - 30 * MINUTE) },
        { id: 'stranded', status: 'in_progress', finished_at: iso(now - 2 * 60 * MINUTE) },
        { id: 'recent', status: 'in_progress', finished_at: iso(now - MINUTE) }
      ]
    })
    await expect(runFinalizeSweep(now)).resolves.toBe(1)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/v1/conversations/stranded/finalize', {})
  })

  it('asks the backend only for in-progress conversations', async () => {
    await runFinalizeSweep(now)
    expect(get.mock.calls[0][0]).toBe('/v1/conversations')
    expect(get.mock.calls[0][1]?.params?.statuses).toBe('in_progress')
  })

  it('survives a failed read without throwing', async () => {
    get.mockRejectedValueOnce(new Error('offline'))
    await expect(runFinalizeSweep(now)).resolves.toBe(0)
    expect(post).not.toHaveBeenCalled()
  })
})
