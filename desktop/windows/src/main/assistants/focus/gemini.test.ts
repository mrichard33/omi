// Ambiguous local timeouts and session cancellation are both terminal. Only the
// backend may explicitly authorize a replay via its typed response contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  abortSignal: undefined as AbortSignal | undefined
}))

vi.mock('electron', () => ({ net: { fetch: h.fetch } }))
vi.mock('../core/session', () => ({ getAbortSignal: () => h.abortSignal }))

import { analyzeScreenshot } from './gemini'
import { describeAssistantError } from '../core/geminiProxy'
import type { BackendSession } from '../core/session'

const session = (): BackendSession => ({ apiBase: 'a', desktopApiBase: 'd', token: 't' })

// A fetch that never resolves on its own — it only rejects when the signal it was
// handed aborts, mirroring real fetch abort semantics (rejects with the reason).
function fetchThatAbortsWithSignal(): void {
  h.fetch.mockImplementation((_url: string, opts: { signal: AbortSignal }) => {
    const s = opts.signal
    return new Promise((_resolve, reject) => {
      const fail = (): void => reject(s.reason ?? new DOMException('aborted', 'AbortError'))
      if (s.aborted) return fail()
      s.addEventListener('abort', fail, { once: true })
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.abortSignal = undefined
})

afterEach(() => {
  vi.useRealTimers()
})

describe('analyzeScreenshot — retry classification', () => {
  it('does not replay a per-request timeout after dispatch', async () => {
    vi.useFakeTimers()
    h.abortSignal = undefined // no session abort in flight
    fetchThatAbortsWithSignal()

    const promise = analyzeScreenshot(session(), 'sys', 'prompt', 'BASE64')
    // Attach the rejection expectation synchronously so the rejection is handled.
    const assertion = expect(promise).rejects.toMatchObject({ name: 'TimeoutError' })

    await vi.advanceTimersByTimeAsync(30_000)

    await assertion
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a genuine session sign-out (single attempt, AbortError)', async () => {
    const ctrl = new AbortController()
    ctrl.abort() // the user signed out before the request went out
    h.abortSignal = ctrl.signal
    fetchThatAbortsWithSignal()

    await expect(analyzeScreenshot(session(), 'sys', 'prompt', 'BASE64')).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('analyzeScreenshot — proxy rejection', () => {
  // The Free-plan failure this app shipped with: every call 402'd, and main.log
  // showed only "GeminiHttpError". The thrown error must carry what the log needs.
  it('surfaces a plan-gate 402 with its status and enum code, and does not retry it', async () => {
    h.fetch.mockResolvedValue({
      ok: false,
      status: 402,
      headers: { get: () => null },
      json: async () => ({
        detail: { error: 'plan_gated', plan_type: 'basic', reason: 'basic_not_entitled' }
      })
    })

    const err = await analyzeScreenshot(session(), 'sys', 'prompt', 'BASE64').catch((e) => e)
    expect(describeAssistantError(err)).toBe(
      'GeminiHttpError status=402 code=plan_gated/basic_not_entitled retryable=false'
    )
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })
})
