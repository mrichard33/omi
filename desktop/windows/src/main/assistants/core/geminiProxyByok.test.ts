// Which BYOK keys ride on a Gemini-proxy request. The backend funds a Free-plan
// analyzer call only from a validated X-BYOK-Gemini, and 403s an enrolled user's
// request whose BYOK set omits or mismatches any enrolled provider — so the rule
// is all-or-none. The store is the controllable seam.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  keys: {} as Record<string, string>,
  enrolled: {} as Record<string, string>,
  validated: [] as string[],
  throwOnRead: false
}))

vi.mock('../../agentKernel/byokStore', () => ({
  ByokKeyStore: class {
    getAllKeys(): Record<string, string> {
      if (h.throwOnRead) throw new Error('Secure storage is unavailable on this system')
      return h.keys
    }
    getEnrolledFingerprints(): Record<string, string> {
      return h.enrolled
    }
    validatedProviders(): string[] {
      return h.validated
    }
  }
}))

import { geminiProxyHeaders, selectGeminiByokKeys } from './geminiProxy'

beforeEach(() => {
  h.keys = {}
  h.enrolled = {}
  h.validated = []
  h.throwOnRead = false
})

describe('geminiProxyHeaders', () => {
  it('sends every enrolled key when Gemini is enrolled and all keys still match', () => {
    h.keys = { gemini: 'gm-key', openai: 'sk-o', anthropic: 'sk-a' }
    h.enrolled = { gemini: 'fp1', openai: 'fp2', anthropic: 'fp3' }
    h.validated = ['openai', 'anthropic', 'gemini']

    expect(geminiProxyHeaders('tok')).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
      'X-BYOK-Gemini': 'gm-key',
      'X-BYOK-OpenAI': 'sk-o',
      'X-BYOK-Anthropic': 'sk-a'
    })
  })

  // Legacy principal: an account enrolled before this change with no Gemini key
  // (this user's exact state — OpenAI + Anthropic only). Its requests must stay
  // byte-identical to before: no BYOK headers, the Omi-funded path.
  it('sends no BYOK headers when Gemini is not enrolled', () => {
    h.keys = { openai: 'sk-o', anthropic: 'sk-a' }
    h.enrolled = { openai: 'fp2', anthropic: 'fp3' }
    h.validated = ['openai', 'anthropic']

    expect(geminiProxyHeaders('tok')).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json'
    })
  })

  it('sends none when a stored key was edited after enrollment (the backend would 403)', () => {
    h.keys = { gemini: 'gm-key', openai: 'sk-rotated' }
    h.enrolled = { gemini: 'fp1', openai: 'fp2' }
    h.validated = ['gemini'] // openai's current key no longer matches fp2

    expect(Object.keys(geminiProxyHeaders('tok'))).toEqual(['Authorization', 'Content-Type'])
  })

  it('falls back to no BYOK headers when the key store is unavailable', () => {
    h.throwOnRead = true
    expect(geminiProxyHeaders('tok')).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json'
    })
  })
})

describe('selectGeminiByokKeys', () => {
  it('never sends a stored-but-unenrolled key alongside the enrolled set', () => {
    const out = selectGeminiByokKeys(
      { gemini: 'gm', deepgram: 'dg-unenrolled' },
      { gemini: 'fp1' },
      ['gemini']
    )
    expect(out).toEqual({ gemini: 'gm' })
  })
})
