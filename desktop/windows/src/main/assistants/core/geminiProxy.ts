// What every Gemini-proxy caller (focus, tasks, memory, insight, goals) shares:
// the request headers, the typed error thrown on a non-2xx, and the one formatter
// their catch sites log with.
//
// Why shared: each analyzer used to build its own headers and carry its own copy
// of the error class. None attached the user's BYOK Gemini key, so a Free-plan
// user who had enrolled one was still 402 `plan_gated` on every call; and every
// catch site logged only `e.name`, so that 402, a 429 and a 503 all read as a
// bare "GeminiHttpError" in main.log. One module means a new caller can't
// reintroduce either.
//
// LOGGING SECURITY: a proxy error body can echo the prompt (the user's profile and
// window contents), so the body is NEVER kept. Only a short, enum-shaped code is
// lifted from it (see readErrorCode) — the same tokens the backend already logs.
// BYOK key values are never logged.
import { ByokKeyStore } from '../../agentKernel/byokStore'
import {
  withByokHeaders,
  type ByokEnrolledFingerprints,
  type ByokKeys,
  type ByokProvider
} from '../../../shared/byok'

/**
 * The BYOK keys to send on a Gemini-proxy request, or `{}` to send none.
 *
 * The proxy funds a request from the user's own key only when it carries a
 * validated `X-BYOK-Gemini` (backend `_enforce_managed_plan_gate`). And once a
 * user is enrolled, the backend 403s any request whose BYOK headers omit or
 * mismatch ANY enrolled provider (`utils/byok.py::_validated_byok_keys`). So it is
 * all-or-none: send every enrolled provider's key, and only when Gemini is among
 * them and each current key still matches its enrolled fingerprint. Otherwise send
 * nothing — the request takes the ordinary Omi-funded path, as it always did.
 */
export function selectGeminiByokKeys(
  keys: ByokKeys,
  enrolled: ByokEnrolledFingerprints,
  validated: readonly ByokProvider[]
): ByokKeys {
  if (!validated.includes('gemini')) return {}
  const enrolledProviders = Object.keys(enrolled) as ByokProvider[]
  if (!enrolledProviders.every((p) => validated.includes(p))) return {}
  const out: ByokKeys = {}
  for (const p of enrolledProviders) out[p] = keys[p]
  return out
}

// Lazy so this module stays import-pure (ByokKeyStore's default path needs
// app.getPath('userData'), only ready after the app is).
let byokStore: ByokKeyStore | null = null

function geminiByokKeys(): ByokKeys {
  try {
    byokStore ??= new ByokKeyStore()
    return selectGeminiByokKeys(
      byokStore.getAllKeys(),
      byokStore.getEnrolledFingerprints(),
      byokStore.validatedProviders()
    )
  } catch {
    // An unavailable key store must never fail the analyzer — fall back to the
    // Omi-funded path (no BYOK headers).
    return {}
  }
}

/** Headers for one Gemini-proxy POST. BYOK keys are read fresh per request. */
export function geminiProxyHeaders(token: string): Record<string, string> {
  return withByokHeaders(
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    geminiByokKeys()
  )
}

/** Enum-shaped tokens only: `plan_gated`, `basic_not_entitled`, `RESOURCE_EXHAUSTED`. */
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/

/** The proxy's rate-limit details are prose; map them to stable codes. */
const KNOWN_DETAIL_CODES: Record<string, string> = {
  'Gemini request rate limit exceeded': 'burst_limit',
  'Gemini daily request limit exceeded': 'daily_limit',
  'Gemini rate limiter is unavailable': 'rate_limiter_unavailable',
  'plan authorization is temporarily unavailable': 'authorization_unavailable'
}

/** Carries typed response metadata only — never a response body. */
export class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
    /** An enum-shaped reason lifted from the error body, e.g. `plan_gated/basic_not_entitled`. */
    readonly code?: string
  ) {
    super(`gemini proxy HTTP ${status}`)
    this.name = 'GeminiHttpError'
  }
}

function enumToken(v: unknown): string | undefined {
  return typeof v === 'string' && CODE_PATTERN.test(v) ? v : undefined
}

/**
 * The enum-shaped reason from a proxy error body, or undefined. Shapes handled:
 *  - `{detail: "trial_expired"}` (a bare enum detail)
 *  - `{detail: "Gemini daily request limit exceeded"}` (known prose → stable code)
 *  - `{detail: {error: "plan_gated", reason: "basic_not_entitled"}}` (plan gate)
 *  - `{error: {status: "RESOURCE_EXHAUSTED", ...}}` (upstream Gemini pass-through)
 * Anything else — including every free-text message — yields undefined.
 */
export function readErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const { detail, error } = body as { detail?: unknown; error?: unknown }
  if (typeof detail === 'string') return KNOWN_DETAIL_CODES[detail] ?? enumToken(detail)
  if (detail && typeof detail === 'object') {
    const d = detail as { error?: unknown; reason?: unknown }
    const parts = [enumToken(d.error), enumToken(d.reason)].filter(Boolean)
    return parts.length > 0 ? parts.join('/') : undefined
  }
  if (error && typeof error === 'object') return enumToken((error as { status?: unknown }).status)
  return undefined
}

/** Minimal slice of a fetch Response this module reads. */
type ErrorResponse = {
  status: number
  headers?: { get?: (name: string) => string | null }
  json?: () => Promise<unknown>
}

/** Build the typed error for a non-ok proxy response. Never throws: an unreadable
 *  body just means no code. */
export async function geminiHttpErrorFrom(res: ErrorResponse): Promise<GeminiHttpError> {
  const retryable = res.headers?.get?.('x-omi-retryable') === 'true'
  let code: string | undefined
  try {
    if (typeof res.json === 'function') code = readErrorCode(await res.json())
  } catch {
    code = undefined
  }
  return new GeminiHttpError(res.status, retryable, code)
}

/** The log-safe one-liner every analyzer catch site uses. A GeminiHttpError shows
 *  its status, code and replay flag; anything else shows its name only (a raw
 *  message can echo user data). */
export function describeAssistantError(e: unknown): string {
  if (e instanceof GeminiHttpError) {
    const code = e.code ? ` code=${e.code}` : ''
    return `GeminiHttpError status=${e.status}${code} retryable=${e.retryable}`
  }
  return e instanceof Error ? e.name : 'Error'
}
