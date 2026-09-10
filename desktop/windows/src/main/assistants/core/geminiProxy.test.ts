// The shared Gemini-proxy error: what a non-2xx becomes, and what the analyzer
// catch sites log. The log line is the only place a user (or we) can tell a
// plan-gate 402 from a rate-limit 429 — and it must never carry a response body.
import { describe, expect, it } from 'vitest'
import {
  GeminiHttpError,
  describeAssistantError,
  geminiHttpErrorFrom,
  readErrorCode
} from './geminiProxy'

function res(
  status: number,
  body: unknown,
  retryable?: 'true' | 'false'
): Parameters<typeof geminiHttpErrorFrom>[0] {
  return {
    status,
    headers: { get: (n: string) => (n === 'x-omi-retryable' ? (retryable ?? null) : null) },
    json: async () => body
  }
}

describe('readErrorCode', () => {
  it('lifts the plan-gate error and reason from a structured 402 detail', () => {
    const body = {
      detail: { error: 'plan_gated', plan_type: 'basic', reason: 'basic_not_entitled' }
    }
    expect(readErrorCode(body)).toBe('plan_gated/basic_not_entitled')
  })

  it('keeps a bare enum detail and maps known rate-limit prose to stable codes', () => {
    expect(readErrorCode({ detail: 'trial_expired' })).toBe('trial_expired')
    expect(readErrorCode({ detail: 'Gemini daily request limit exceeded' })).toBe('daily_limit')
    expect(readErrorCode({ detail: 'Gemini request rate limit exceeded' })).toBe('burst_limit')
  })

  it('lifts only the status enum from an upstream Gemini error, never its message', () => {
    const body = {
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota for prompt X' }
    }
    expect(readErrorCode(body)).toBe('RESOURCE_EXHAUSTED')
  })

  it('drops free text that could echo user data', () => {
    expect(readErrorCode({ detail: 'failed to process: my secret window title' })).toBeUndefined()
    expect(readErrorCode({ detail: { error: 'has spaces in it', reason: 42 } })).toBeUndefined()
    expect(readErrorCode('plain string')).toBeUndefined()
    expect(readErrorCode(null)).toBeUndefined()
  })
})

describe('geminiHttpErrorFrom', () => {
  it('carries status, the backend replay flag, and the enum code', async () => {
    const err = await geminiHttpErrorFrom(
      res(402, { detail: { error: 'plan_gated', reason: 'basic_not_entitled' } }, 'false')
    )
    expect(err).toBeInstanceOf(GeminiHttpError)
    expect(err).toMatchObject({
      status: 402,
      retryable: false,
      code: 'plan_gated/basic_not_entitled'
    })
  })

  it('never throws on an unreadable body — the status alone still surfaces', async () => {
    const err = await geminiHttpErrorFrom({
      status: 503,
      headers: { get: () => 'true' },
      json: async () => {
        throw new SyntaxError('not json')
      }
    })
    expect(err).toMatchObject({ status: 503, retryable: true, code: undefined })
    // A mock without json() at all (the shape several wire tests use).
    expect(await geminiHttpErrorFrom({ status: 400 })).toMatchObject({
      status: 400,
      retryable: false
    })
  })
})

describe('describeAssistantError', () => {
  it('shows status, code and replay flag for a proxy error', () => {
    const line = describeAssistantError(
      new GeminiHttpError(402, false, 'plan_gated/basic_not_entitled')
    )
    expect(line).toBe(
      'GeminiHttpError status=402 code=plan_gated/basic_not_entitled retryable=false'
    )
    expect(describeAssistantError(new GeminiHttpError(429, true))).toBe(
      'GeminiHttpError status=429 retryable=true'
    )
  })

  it('shows only the name for any other error — a raw message can echo user data', () => {
    const e = new Error('prompt contained: private text')
    e.name = 'TimeoutError'
    expect(describeAssistantError(e)).toBe('TimeoutError')
    expect(describeAssistantError('nope')).toBe('Error')
  })
})
