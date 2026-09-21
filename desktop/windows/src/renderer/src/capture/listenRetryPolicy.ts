// When the always-on mic's /v4/listen socket may reconnect, and when it must stop
// trying for a while. Pure and clock-injectable so the whole schedule — ladder,
// jitter, the 429 floor, the healthy-session reset and the breaker — is testable
// in node without a socket or a timer.
//
// 2026-09-21. Written after a live storm on the Windows desktop: the hosted STT
// service was accepting /v4/listen handshakes in ~200ms and then closing them
// within seconds with 1011 transcription_service_unavailable. The lane reconnected
// about every 8 SECONDS for 47 minutes, because the previous loop reset its attempt
// counter the moment a socket reached OPEN. A socket that connects and dies two
// seconds later therefore sat on the first rung forever. That cadence walked the
// account into the edge rate limiter (429 on the handshake, surfacing as 1006),
// whose floor was 5s, so the storm fed itself.
//
// The contract this file defends is the repo's own
// FC-bridge-liveness-without-data-path-proof: a transport is healthy only once a
// datum has crossed the WHOLE path. Connecting is not evidence of anything.
import { isRateLimitedDropError } from './liveRescue'

/** 1-based reconnect delays; past the end the schedule HOLDS at the last rung. */
export const LADDER_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const
/** ±20% spread on an ordinary rung, decorrelating lanes and clients. */
export const JITTER_FRACTION = 0.2
/** A 429 is never retried sooner than this, with or without a Retry-After. */
export const RATE_LIMIT_FLOOR_MS = 60_000
/** A server Retry-After is honored only up to here — a bogus value must not park
 *  the recording for longer than the schedule's own hold. */
export const RETRY_AFTER_CAP_MS = 300_000
/** A socket must stay up this long to count as healthy on lifetime alone. */
export const HEALTHY_SESSION_MS = 60_000
/** Consecutive failures before the breaker opens. */
export const MAX_CONSECUTIVE_FAILURES = 10
/** How long the breaker stays open before a single half-open probe. */
export const CIRCUIT_PAUSE_MS = 600_000

export type ListenRetryReason =
  | 'rate_limited'
  | 'service_unavailable'
  | 'abnormal_close'
  | 'connect_error'
  | 'clean_restart'

export type ListenFailure = {
  message: string
  /** The WS close code, when the lane ended on a close frame. */
  closeCode?: number
  /** HTTP status of a rejected handshake (429 from the edge rate limit). */
  status?: number
  /** That rejection's Retry-After in ms, when the server sent one. */
  retryAfterMs?: number
  /** How long this socket was up before it died. 0 if it never connected. */
  connectedForMs: number
  /** Whether this socket delivered any transcript before it died. */
  deliveredSegments: boolean
}

export type ListenRetryDecision =
  | { action: 'retry'; delayMs: number; attempt: number; reason: ListenRetryReason }
  | {
      action: 'pause'
      delayMs: number
      resumeAtMs: number
      failures: number
      reason: ListenRetryReason
    }

export type ListenRetryPolicy = {
  /** Decide what to do about a drop. Also advances the failure count. */
  onFailure: (failure: ListenFailure) => ListenRetryDecision
  /** Proof the lane works — a delivered segment, or a socket that reached the
   *  healthy age while still open. Clears the count and closes the breaker. */
  noteHealthy: () => void
  state: () => { failures: number; pausedUntil: number | null }
}

/** Which rung this attempt sits on; past the ladder's end it holds at the last. */
function ladderStepMs(attempt: number): number {
  const i = Math.min(Math.max(1, attempt), LADDER_MS.length) - 1
  return LADDER_MS[i]
}

export function classifyFailure(f: ListenFailure): ListenRetryReason {
  if (f.status === 429 || isRateLimitedDropError(f.message)) return 'rate_limited'
  // 1000 NORMAL and 1001 GOING_AWAY are orderly teardowns: a user stop, a machine
  // going to sleep, or the main process's own stale-socket watchdog, which closes
  // with 1000 SPECIFICALLY so this lane reconnects. Reconnecting is right; counting
  // it as a failure is not, and a breaker that trips on them would freeze capture.
  if (f.closeCode === 1000 || f.closeCode === 1001) return 'clean_restart'
  if (f.closeCode === 1011) return 'service_unavailable'
  if (f.closeCode !== undefined) return 'abnormal_close'
  return 'connect_error'
}

export function createListenRetryPolicy(
  deps: { now?: () => number; rand?: () => number } = {}
): ListenRetryPolicy {
  const now = deps.now ?? Date.now
  const rand = deps.rand ?? Math.random
  let failures = 0
  let pausedUntil: number | null = null

  const reset = (): void => {
    failures = 0
    pausedUntil = null
  }

  return {
    noteHealthy: reset,
    state: () => ({ failures, pausedUntil }),
    onFailure(f): ListenRetryDecision {
      const reason = classifyFailure(f)

      // An orderly teardown reconnects at the first rung and spends nothing: it is
      // how a normal stop, a sleep/resume and the watchdog all come back.
      if (reason === 'clean_restart') {
        return {
          action: 'retry',
          delayMs: jitter(LADDER_MS[0], rand),
          attempt: failures + 1,
          reason
        }
      }

      // Health is proven by data crossing the path, or by a socket that simply
      // lived long enough. Either clears the slate BEFORE this failure is counted,
      // so a lane that worked for an hour restarts at 5s rather than at 5 minutes.
      if (f.deliveredSegments || f.connectedForMs >= HEALTHY_SESSION_MS) reset()

      failures += 1

      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        // Open the breaker. The retry after the pause is a half-open probe: if it
        // also fails, `failures` is still at the limit, so the next decision is
        // another pause. Steady state during a real outage is one handshake every
        // ten minutes — never another storm.
        const resumeAtMs = now() + CIRCUIT_PAUSE_MS
        pausedUntil = resumeAtMs
        return { action: 'pause', delayMs: CIRCUIT_PAUSE_MS, resumeAtMs, failures, reason }
      }

      return {
        action: 'retry',
        delayMs:
          reason === 'rate_limited'
            ? rateLimitedDelayMs(f, failures, rand)
            : jitter(ladderStepMs(failures), rand),
        attempt: failures,
        reason
      }
    }
  }
}

/** An ordinary rung, spread ±20%. */
function jitter(baseMs: number, rand: () => number): number {
  return Math.round(baseMs * (1 - JITTER_FRACTION + rand() * JITTER_FRACTION * 2))
}

/**
 * A rate-limited retry. The server has explicitly said "slow down", so the floor is
 * the largest of the ladder rung, any Retry-After it sent, and a hard 60s — and the
 * jitter is ADDITIVE ONLY. A symmetric ±20% on a 60s floor could retry at 48s, which
 * would break the one guarantee this branch exists to make.
 */
function rateLimitedDelayMs(f: ListenFailure, attempt: number, rand: () => number): number {
  const serverAsked =
    f.retryAfterMs !== undefined && Number.isFinite(f.retryAfterMs)
      ? Math.min(RETRY_AFTER_CAP_MS, Math.max(0, f.retryAfterMs))
      : 0
  const floor = Math.max(ladderStepMs(attempt), serverAsked, RATE_LIMIT_FLOOR_MS)
  return Math.round(floor * (1 + rand() * JITTER_FRACTION))
}
