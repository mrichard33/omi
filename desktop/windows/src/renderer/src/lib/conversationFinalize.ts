import type { AxiosRequestConfig } from 'axios'
import { omiApi } from './apiClient'
import type { CloudConversation } from './conversationTypes'

// WHY THIS EXISTS (measured 2026-09-22)
//
// A Windows-recorded conversation used to sit at "Processing" on Omi's servers
// for hours or days: of 36 desktop conversations over 36h, 33 arrived 2h–4d
// late, released in batches at exactly the moments the Omi WEB app was opened.
//
// The backend only auto-processes a `desktop` conversation when the /v4/listen
// socket tears down with close code 1000 — `backend/routers/listen/runtime.py`
// (`_teardown_components`, the `self.state.close_code == 1000` guard). Anything
// else (a 1011 from a failing STT provider, a half-open socket, an app crash or
// quit) leaves the row `in_progress` with nothing scheduled. The backend's own
// rescue, `recover_stale_in_progress()` in `backend/routers/listen/conversations.py`,
// only runs on the NEXT /v4/listen connect, only past an HOUR of idleness
// (STALE_IN_PROGRESS_RECOVERY_AGE_SECONDS = 3600) and only 10 rows at a time —
// which is precisely the batched release we measured.
//
// Every other client finalizes EXPLICITLY instead of trusting the socket close:
//   - web:    finalizeConversationById() — web/app/src/lib/api.ts:360,
//             called on stop in web/app/src/hooks/useRecording.ts:233
//   - macOS:  apiClient.finalizeConversation(id:) — desktop/macos/Desktop/Sources/
//             ConversationFinalizationService.swift:405
//   - mobile: processInProgressConversation() — app/lib/backend/http/api/
//             conversations.dart:27, called from capture_controller.dart:2332
// The Windows client called neither endpoint. This module is that missing call.
//
// POST /v1/conversations/{id}/finalize is the by-id form and the one to use: it
// does not touch the user's shared Redis "current in-progress" pointer, so it
// can never steal a recording from the phone (backend/routers/conversations.py,
// `finalize_conversation`). It is idempotent — a conversation that is no longer
// `in_progress` returns 200 without reprocessing — so calling it after the
// socket already did the job is free.

export type FinalizeReason = 'stop' | 'meeting_end' | 'abnormal_close' | 'sweep'

/** Wait this long after a socket ends before finalizing, so the backend's own
 *  teardown (which flushes trailing segments and, on a clean 1000, finalizes by
 *  itself) gets to go first. Our call then no-ops instead of racing it. */
export const FINALIZE_GRACE_MS = 2_500

/** How often the startup sweep re-checks for conversations nothing owns. */
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000
/** A conversation is only swept once it has been idle this long. Any live
 *  session — this app's, the phone's, the web app's — refreshes `finished_at`
 *  on every segment (backend/database/conversations.py, `select_stale_in_progress`),
 *  so 5 minutes of no movement means no session owns the row. */
export const SWEEP_MIN_IDLE_MS = 5 * 60 * 1000
/** Deferred past app startup so the sweep never competes with sign-in. */
const SWEEP_START_DELAY_MS = 15_000
/** Bounded page: a backlog drains over several passes rather than in one burst. */
const SWEEP_PAGE_LIMIT = 25
/** Bound on the "already done" memo so a long-running app can't grow it forever. */
const FINALIZED_MEMO_MAX = 200

// Conversation ids a lane in THIS app is currently streaming into. A streaming
// conversation is never finalized — that would cut a live recording in half.
const streamingIds = new Set<string>()
// In-flight + recently completed finalizes, so the 10-minute sweep can't re-post
// one that a stop already handled seconds ago.
const inFlightIds = new Set<string>()
const finalizedIds = new Set<string>()

/** Mark a conversation as actively streaming (call when its socket opens). */
export function markConversationStreaming(conversationId: string): void {
  streamingIds.add(conversationId)
}

/** Release a conversation: it is no longer being streamed into and may now be
 *  finalized. Call this BEFORE asking for a finalize. */
export function markConversationSettled(conversationId: string): void {
  streamingIds.delete(conversationId)
}

export function isConversationStreaming(conversationId: string): boolean {
  return streamingIds.has(conversationId)
}

function rememberFinalized(conversationId: string): void {
  if (finalizedIds.size >= FINALIZED_MEMO_MAX) {
    const oldest = finalizedIds.values().next()
    if (!oldest.done) finalizedIds.delete(oldest.value)
  }
  finalizedIds.add(conversationId)
}

/**
 * A socket that ended after delivering real audio. `1000` is the one code the
 * backend finalizes on by itself; everything else (1011 from a failing STT
 * provider, 1005/1006 from a dropped connection, 1008 on a quota close) strands
 * the conversation, so the client must finalize it. A socket that never
 * delivered a segment has nothing worth finalizing — an empty row would only be
 * deleted at the other end.
 */
export function shouldFinalizeAfterClose(
  closeCode: number | undefined,
  segmentsReceived: number
): boolean {
  if (segmentsReceived <= 0) return false
  return closeCode !== 1000
}

/**
 * The backend announces the conversation a socket is writing into with a
 * `conversation_session` event carrying its id (backend/models/message_event.py,
 * `ConversationSessionEvent`). Following it matters because the id can change
 * mid-socket: when the backend rolls the conversation itself (a silence boundary,
 * a discarded-row rollover) it mints a SERVER-side id the client never proposed,
 * and our `clientConversationId` then names the previous, already-finished one.
 */
export function conversationIdFromEvent(event: {
  type: string
  raw: Record<string, unknown>
}): string | null {
  if (event.type !== 'conversation_session') return null
  const id = event.raw.conversation_id
  return typeof id === 'string' && id ? id : null
}

/** The subset of a conversation the sweep needs; keeps the selection pure. */
export type SweepCandidate = Pick<CloudConversation, 'id'> & {
  status?: CloudConversation['status']
  finished_at?: CloudConversation['finished_at']
}

/**
 * Which in-progress conversations the sweep may finalize: idle past the cutoff,
 * not being streamed by this app, and not one we just finalized. A row with no
 * readable `finished_at` is SKIPPED rather than swept — the same call the
 * backend makes in `select_stale_in_progress`: without a trustworthy idle clock
 * the row cannot be proven orphaned.
 */
export function selectSweepCandidates(
  conversations: SweepCandidate[],
  opts: { now: number; minIdleMs?: number }
): string[] {
  const minIdleMs = opts.minIdleMs ?? SWEEP_MIN_IDLE_MS
  const out: string[] = []
  for (const conversation of conversations) {
    const id = conversation.id
    if (!id) continue
    if (conversation.status && conversation.status !== 'in_progress') continue
    if (streamingIds.has(id) || inFlightIds.has(id) || finalizedIds.has(id)) continue
    const finishedAt = conversation.finished_at ? Date.parse(conversation.finished_at) : NaN
    if (!Number.isFinite(finishedAt)) continue
    if (opts.now - finishedAt < minIdleMs) continue
    out.push(id)
  }
  return out
}

/**
 * Finalize one conversation now. Logs exactly one line per attempt:
 * `[omi-finalize] conversation <id> reason=<reason> result=<ok|error>`.
 * Returns true when the backend accepted it. Never throws.
 */
export async function finalizeConversation(
  conversationId: string,
  reason: FinalizeReason
): Promise<boolean> {
  if (!conversationId) return false
  // The one hard rule: a conversation a lane is still streaming into is never
  // finalized, whatever asked for it.
  if (streamingIds.has(conversationId)) return false
  if (inFlightIds.has(conversationId) || finalizedIds.has(conversationId)) return false
  inFlightIds.add(conversationId)
  try {
    await omiApi.post(`/v1/conversations/${encodeURIComponent(conversationId)}/finalize`, {})
    rememberFinalized(conversationId)
    console.log(`[omi-finalize] conversation ${conversationId} reason=${reason} result=ok`)
    return true
  } catch (e) {
    console.warn(
      `[omi-finalize] conversation ${conversationId} reason=${reason} result=error ` +
        `(${(e as Error).message})`
    )
    return false
  } finally {
    inFlightIds.delete(conversationId)
  }
}

/**
 * Finalize after the grace delay, so the backend's own socket teardown goes
 * first. The conversation is released from the streaming set immediately: the
 * lane that asked for this has already stopped feeding it.
 */
export function scheduleFinalize(
  conversationId: string,
  reason: FinalizeReason,
  delayMs: number = FINALIZE_GRACE_MS
): void {
  if (!conversationId) return
  markConversationSettled(conversationId)
  setTimeout(() => void finalizeConversation(conversationId, reason), delayMs)
}

// A BACKGROUND read: a dead-session 401 here must reject quietly instead of
// yanking the user to the sign-in screen — that is what apiClient's
// `__sessionPreserving` knob is for (see responseErrorHandler).
const SWEEP_READ_CONFIG = {
  params: {
    statuses: 'in_progress',
    include_discarded: false,
    limit: SWEEP_PAGE_LIMIT,
    offset: 0
  },
  __sessionPreserving: true
} as AxiosRequestConfig

let sweepRunning = false

/**
 * One sweep pass: finalize every in-progress conversation that has been idle
 * past the cutoff. This is the backstop for everything the live triggers cannot
 * reach — a conversation stranded while the app was closed, killed, or asleep.
 */
export async function runFinalizeSweep(nowMs: number = Date.now()): Promise<number> {
  if (sweepRunning) return 0
  sweepRunning = true
  try {
    const r = await omiApi.get<CloudConversation[]>('/v1/conversations', SWEEP_READ_CONFIG)
    const list = Array.isArray(r.data) ? r.data : []
    const ids = selectSweepCandidates(list, { now: nowMs })
    let finalized = 0
    for (const id of ids) {
      if (await finalizeConversation(id, 'sweep')) finalized++
    }
    return finalized
  } catch (e) {
    console.warn('[omi-finalize] sweep failed:', (e as Error).message)
    return 0
  } finally {
    sweepRunning = false
  }
}

let sweepStarted = false

/** Start the startup + every-10-minutes sweep once per app session. */
export function maybeStartFinalizeSweep(): void {
  if (sweepStarted) return
  sweepStarted = true
  setTimeout(() => void runFinalizeSweep(), SWEEP_START_DELAY_MS)
  setInterval(() => void runFinalizeSweep(), SWEEP_INTERVAL_MS)
}

/** Test seam: drop all cross-test state. Not used in production. */
export function __resetConversationFinalizeStateForTests(): void {
  streamingIds.clear()
  inFlightIds.clear()
  finalizedIds.clear()
  sweepRunning = false
  sweepStarted = false
}
