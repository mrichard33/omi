import { startTranscription, type TranscriptionHandle } from '../lib/transcriptionClient'
import { isConversationBoundary, onFinalizeRequest } from '../lib/liveConversation'
import { transcriptWordCount } from '../lib/retentionRules'
import { isInjectedLineId } from '../lib/voice/injectedTranscript'
import { syncLocalConversation } from '../lib/sync/conversationSync'
import { captureLiveStore } from './liveStore'
import {
  isRetryableDropError,
  toSyncSegments,
  segmentsToTranscript,
  createSegmentRetainer
} from './liveRescue'
import { HEALTHY_SESSION_MS, createListenRetryPolicy } from './listenRetryPolicy'
import {
  conversationIdFromEvent,
  finalizeConversation,
  markConversationSettled,
  markConversationStreaming,
  scheduleFinalize,
  shouldFinalizeAfterClose
} from '../lib/conversationFinalize'
import { trackEvent } from '../lib/analytics'
import type { ListenError } from '../lib/omiListenClient'
import type { LocalConversation } from '../../../shared/types'

// After this much silence (no new finalized speech) the current conversation is
// finalized: the session ends so the backend stores it, then a fresh one starts.
const SILENCE_MS = 30000
// Below this word count a transcript is a trivial blip not worth its own
// conversation — used both by finalize and by the reconnect-exhausted rescue.
const MIN_WORDS = 5

export type LiveMicController = {
  /** Stop the session and tear everything down (call from effect cleanup). */
  stop: () => void
}

export type LiveMicSessionHealth = 'inactive' | 'connecting' | 'ready' | 'failed'

// Track each controller independently so React StrictMode overlap cannot make a
// stopped controller overwrite the health of its replacement.
let nextControllerId = 1
const controllerHealth = new Map<number, Exclude<LiveMicSessionHealth, 'inactive'>>()
const healthListeners = new Set<(health: LiveMicSessionHealth) => void>()
let aggregateHealth: LiveMicSessionHealth = 'inactive'

function computeAggregateHealth(): LiveMicSessionHealth {
  const states = [...controllerHealth.values()]
  if (states.includes('ready')) return 'ready'
  if (states.includes('connecting')) return 'connecting'
  return states.length > 0 ? 'failed' : 'inactive'
}

function setControllerHealth(
  controllerId: number,
  health: Exclude<LiveMicSessionHealth, 'inactive'> | null
): void {
  if (health) controllerHealth.set(controllerId, health)
  else controllerHealth.delete(controllerId)
  const next = computeAggregateHealth()
  if (next === aggregateHealth) return
  aggregateHealth = next
  for (const listener of healthListeners) listener(next)
}

/** True when an always-on continuous mic session is running. Read by the meeting
 *  session to defer to it instead of opening a duplicate mic /v4/listen. */
export function isLiveMicSessionActive(): boolean {
  return controllerHealth.size > 0
}

export function getLiveMicSessionHealth(): LiveMicSessionHealth {
  return aggregateHealth
}

export function onLiveMicSessionHealth(
  listener: (health: LiveMicSessionHealth) => void
): () => void {
  healthListeners.add(listener)
  listener(aggregateHealth)
  return () => healthListeners.delete(listener)
}

/** Wait for an in-flight continuous mic to become usable. A meeting uses this
 *  as part of its own startup barrier instead of assuming controller existence
 *  means the user's voice is already being captured. */
export function waitForLiveMicSessionReady(
  signal?: AbortSignal,
  timeoutMs = 3_500
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (aggregateHealth === 'ready') return Promise.resolve(true)
  if (aggregateHealth !== 'connecting') return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      healthListeners.delete(onHealth)
      signal?.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const onHealth = (health: LiveMicSessionHealth): void => {
      if (health === 'ready') finish(true)
      else if (health === 'failed' || health === 'inactive') finish(false)
    }
    const onAbort = (): void => finish(false)
    const timer = setTimeout(() => finish(false), timeoutMs)
    healthListeners.add(onHealth)
    signal?.addEventListener('abort', onAbort, { once: true })
    // Close the subscribe-after-check race.
    onHealth(aggregateHealth)
  })
}

/**
 * The single owner of an always-on mic → /v4/listen session that drives the
 * shared `liveConversation` store. Runs INSIDE the capture window (mounted by
 * ContinuousSessionHost) so capture is independent of any UI window. It handles:
 * connect, feeding segments into the live store, the 30s-silence and "Save now"
 * finalize (end → store → restart), the backend's own boundary, resilient
 * reconnect that RESUMES the same conversation across a socket drop, a
 * from-segments rescue when reconnect is exhausted, and a StrictMode-safe deferred
 * connect.
 *
 * Resilience (fixes: any close was terminal → a network blip lost the recording):
 *  - Each conversation carries a client-generated `clientConversationId`. A dropped
 *    socket reconnects with capped backoff (up to MAX_RECONNECT_ATTEMPTS) re-sending
 *    that SAME id, so the backend resumes the in-progress conversation instead of
 *    stranding it (transcribe.py keys the conversation on client_conversation_id).
 *  - Raw segments are retained for the current conversation. If every reconnect
 *    fails (an extended outage), the retained segments are pushed through the sync
 *    outbox as a from-segments upload so the recording survives — as 'unconfirmed'
 *    so the outbox dedupes against the cloud first and never double-creates.
 *
 * Every store mutation goes through `captureLiveStore`, which mirrors it to UI
 * windows as a LiveStoreOp. On finalize it broadcasts a `saved` op carrying the
 * segments; the UI window (LiveMirrorHost) turns that into an optimistically-
 * titled pending conversation and refreshes the cloud list — those UI side
 * effects deliberately do NOT run here (this window has no UI).
 */
export function startLiveMicSession(): LiveMicController {
  let cancelled = false
  const controllerId = nextControllerId++
  setControllerHealth(controllerId, 'connecting')
  let handle: TranscriptionHandle | null = null
  let hasSpeech = false
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  const timers: ReturnType<typeof setTimeout>[] = []

  // Per-conversation state, reset by resetConversation() at each boundary.
  let clientConversationId = crypto.randomUUID()
  // The conversation the BACKEND says this socket is writing into. Starts as our
  // proposed id (the backend adopts it verbatim) and follows every
  // `conversation_session` event, so a server-side rollover cannot leave us
  // finalizing the previous, already-finished conversation.
  let backendConversationId: string = clientConversationId
  // Segments delivered into the CURRENT backend conversation. A socket that
  // ended abnormally without any is not worth finalizing — there is no content.
  let segmentsInConversation = 0
  let conversationStartedAt = Date.now()
  let retainer = createSegmentRetainer()
  // The reconnect budget spans conversations: the backend, not the conversation,
  // is what fails, and a boundary crossed successfully already counts as healthy.
  const retry = createListenRetryPolicy()
  // Latched so a pause emits its telemetry once, and the matching recovery only
  // after a pause actually happened.
  let circuitOpen = false

  const clearSilence = (): void => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  const armSilence = (): void => {
    clearSilence()
    silenceTimer = setTimeout(() => {
      if (!cancelled && hasSpeech) finalize()
    }, SILENCE_MS)
  }

  // Words in the current live transcript (using the same counter the retention
  // rules use) — trivial blips below this aren't worth finalizing. Injected
  // assistant lines (Omi's own words, Phase 6) are EXCLUDED so they can't push
  // an otherwise-trivial human blip over the finalize threshold.
  const liveWordCount = (): number =>
    transcriptWordCount(
      captureLiveStore
        .getSegments()
        .filter((s) => !isInjectedLineId(s.id))
        .map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text))
        .join('\n')
    )

  // Save the just-spoken transcript as its own conversation: broadcast the saved
  // segments (the UI window titles + lists them) and keep them on the live screen
  // flagged "saved", then start a fresh session so capture continues.
  const saveCurrent = (): void => {
    captureLiveStore.saved(captureLiveStore.getSegments())
  }

  // The reconnect breaker opened: the backend is unreachable and will not be asked
  // again for ten minutes, so its own conversation was never finalized. Persist what we captured and push it through the sync outbox
  // as a from-segments upload so the recording isn't lost. Inserted as
  // 'unconfirmed' so the outbox runs its dedupe-against-cloud BEFORE posting — if
  // the backend DID manage to finalize a conversation from the pre-drop audio we
  // adopt it instead of creating a duplicate.
  // `segs` + `startedAt` are passed in (not read from the live state) because the
  // rescue can now run AFTER the abandoned conversation has been finalized and
  // the lane has rolled to a fresh one — see the breaker branch in connect().
  const rescue = (segs = retainer.list(), startedAt = conversationStartedAt): void => {
    const transcript = segmentsToTranscript(segs)
    if (transcriptWordCount(transcript) < MIN_WORDS) return
    const row: LocalConversation = {
      id: `local-${crypto.randomUUID()}`,
      startedAt,
      endedAt: Date.now(),
      transcript,
      createdAt: Date.now(),
      syncState: 'unconfirmed',
      segments: toSyncSegments(segs)
    }
    void window.omi
      .insertLocalConversation(row)
      .then(() => {
        window.omi.notifyConversationsChanged?.()
        return syncLocalConversation(row)
      })
      .catch((e) => console.warn('[live-mic] rescue upload failed:', (e as Error).message))
  }

  // Finalize on the silence timeout or "Save now": end the session (the backend
  // stores it), then restart. No-op if nothing was said since the last finalize.
  const finalize = (): void => {
    if (cancelled || !hasSpeech) return
    // Don't make a conversation out of a trivial blip (< 5 words) — keep
    // listening so it merges into the next real one.
    if (liveWordCount() < MIN_WORDS) {
      armSilence()
      return
    }
    hasSpeech = false
    clearSilence()
    try {
      handle?.stop()
    } catch {
      /* ignore */
    }
    handle = null
    saveCurrent()
    // Closing the socket asks the backend to finalize, but it only obliges when
    // its teardown sees close code 1000 — so say so explicitly rather than
    // trusting the transport. Scheduled (not immediate) so the backend's own
    // teardown flushes the trailing segments first; the call then no-ops.
    scheduleFinalize(backendConversationId, 'stop')
    startConversation() // fresh conversation: new resumable id, cleared retainer
  }

  // Open (or reconnect) the socket for the CURRENT conversation, re-sending the
  // same clientConversationId so a reconnect resumes it.
  const connect = (): void => {
    // Per-SOCKET, not per-session: connect() builds a fresh closure each attempt,
    // so these describe only the socket this call opens.
    let connectedAt = 0
    let delivered = false
    let healthyTimer: ReturnType<typeof setTimeout> | null = null

    // Proof the lane actually works. Clears the reconnect budget and, if the
    // breaker had opened, closes it and reports the recovery.
    const markHealthy = (): void => {
      delivered = true
      retry.noteHealthy()
      if (circuitOpen) {
        circuitOpen = false
        trackEvent('fallback_triggered', {
          component: 'live_capture',
          from: 'from_segments',
          to: 'v4_listen',
          reason: 'circuit_open',
          outcome: 'recovered'
        })
      }
    }

    setControllerHealth(controllerId, 'connecting')
    captureLiveStore.setStatus('connecting')
    void startTranscription(
      'mic',
      {
        onLine: (line) => {
          if (cancelled) return
          markHealthy() // a delivered transcript is data across the WHOLE path
          setControllerHealth(controllerId, 'ready')
          captureLiveStore.setStatus('live')
          captureLiveStore.appendLine(line)
          hasSpeech = true
          armSilence() // reset the silence countdown on each new utterance
        },
        onInterim: () => {},
        onBackend: () => {
          if (cancelled) return
          // Connecting is NOT health, and treating it as such is the bug this
          // lane shipped with: during the 2026-09-21 storm the hosted STT service
          // accepted the handshake in ~200ms and closed it seconds later with
          // 1011, so resetting here pinned the ladder on its first rung and the
          // lane reconnected every ~8s for 47 minutes, straight into the edge
          // rate limiter. The budget now only clears once a segment arrives, or
          // once this socket has simply stayed up long enough to count.
          connectedAt = Date.now()
          if (healthyTimer) clearTimeout(healthyTimer)
          healthyTimer = setTimeout(() => {
            if (!cancelled) markHealthy()
          }, HEALTHY_SESSION_MS)
          timers.push(healthyTimer)
          setControllerHealth(controllerId, 'ready')
          captureLiveStore.setStatus('live')
        },
        onSegments: (segs) => {
          if (cancelled) return
          retainer.add(segs) // retained for the breaker-pause rescue
          segmentsInConversation += segs.length
          if (segs.length > 0) markHealthy()
        },
        onEvent: (ev) => {
          if (cancelled) return
          const announced = conversationIdFromEvent(ev)
          if (announced && announced !== backendConversationId) {
            // The backend named a different conversation than the one we were
            // tracking — either it adopted our proposed id, or it rolled to a
            // server-minted one. Follow it: that is what any finalize must name.
            markConversationSettled(backendConversationId)
            backendConversationId = announced
            segmentsInConversation = 0
          }
          if (announced) markConversationStreaming(announced)
          if (isConversationBoundary(ev)) {
            // Backend finalized on its own (beat our silence timer). Skip trivial
            // blips; otherwise keep the transcript shown as saved, and reset the
            // rescue window so it scopes to the next conversation.
            clearSilence()
            hasSpeech = false
            if (liveWordCount() >= MIN_WORDS) saveCurrent()
            retainer = createSegmentRetainer()
            conversationStartedAt = Date.now()
            // The backend finalized this one itself; nothing left to ask for, and
            // its content must not count towards the NEXT conversation's
            // abnormal-close decision. The id it rolls to arrives as the next
            // `conversation_session` event.
            markConversationSettled(backendConversationId)
            segmentsInConversation = 0
          }
        },
        onError: (e) => {
          if (cancelled) return
          try {
            handle?.stop()
          } catch {
            /* ignore */
          }
          handle = null
          if (!isRetryableDropError((e as Error).message, (e as Error).name)) {
            // Quota/entitlement/sign-in error — reconnecting can't help. Surface it
            // now (no rescue: a quota-blocked account can't create conversations).
            // On a quota exhaustion this mirrored 'error' status drives the main
            // window's LiveMirrorHost → maybeTriggerTranscriptionQuotaPopup, which
            // raises the "Upgrade" modal. Do NOT call showUsageLimit here: this
            // hidden capture window is a separate renderer, so its in-memory popup
            // signal never reaches the popup host.
            // The lane is done with this conversation and nothing will reopen it,
            // so anything already captured must be finalized here or it sits at
            // "Processing" until someone opens the web app.
            if (shouldFinalizeAfterClose((e as ListenError).closeCode, segmentsInConversation)) {
              scheduleFinalize(backendConversationId, 'abnormal_close')
            }
            setControllerHealth(controllerId, 'failed')
            captureLiveStore.setStatus('error', (e as Error).message)
            return
          }
          if (healthyTimer) clearTimeout(healthyTimer)
          const err = e as ListenError
          const decision = retry.onFailure({
            message: err.message,
            closeCode: err.closeCode,
            status: err.status,
            retryAfterMs: err.retryAfterMs,
            connectedForMs: connectedAt ? Date.now() - connectedAt : 0,
            // THIS socket's own delivery, not the conversation's: the retainer
            // outlives a reconnect, so reading it would let one early segment
            // excuse every later failure.
            deliveredSegments: delivered
          })

          if (decision.action === 'retry') {
            // Transient drop (or connect failure) — reconnect and RESUME the same
            // conversation. The retainer + live store are preserved across this.
            window.omi.listenRetryNotice({
              kind: 'retry',
              attempt: decision.attempt,
              delayMs: decision.delayMs,
              reason: decision.reason
            })
            setControllerHealth(controllerId, 'connecting')
            captureLiveStore.setStatus('connecting')
            timers.push(
              setTimeout(() => {
                if (!cancelled) connect()
              }, decision.delayMs)
            )
            return
          }

          // The breaker opened. Finalize and rescue what was captured, then stand
          // down for ten minutes rather than keep hammering a backend that is
          // plainly down — it is the fast retries themselves that earn the 429s.
          //
          // ORDER MATTERS. The backend already holds every retained segment (they
          // came back from it), so finalizing turns them into a real cloud
          // conversation; the rescue exists for when it did NOT, and dedupes by
          // reading the cloud list first. Running the finalize to completion
          // BEFORE the rescue is what makes that dedupe deterministic instead of
          // a race — otherwise both can post the same speech.
          const abandonedId = backendConversationId
          const abandonedSegments = segmentsInConversation
          const retained = retainer.list()
          const retainedStartedAt = conversationStartedAt
          markConversationSettled(abandonedId)
          if (shouldFinalizeAfterClose(err.closeCode, abandonedSegments)) {
            void finalizeConversation(abandonedId, 'abnormal_close').finally(() =>
              rescue(retained, retainedStartedAt)
            )
          } else {
            rescue(retained, retainedStartedAt)
          }
          circuitOpen = true
          trackEvent('fallback_triggered', {
            component: 'live_capture',
            from: 'v4_listen',
            to: 'from_segments',
            reason: 'circuit_open',
            outcome: 'exhausted'
          })
          window.omi.listenRetryNotice({
            kind: 'paused',
            failures: decision.failures,
            resumeAtMs: decision.resumeAtMs
          })
          // Roll the conversation: the retained transcript has just been rescued
          // under the current id, so resuming it would post the same speech twice.
          resetConversation()
          setControllerHealth(controllerId, 'failed')
          captureLiveStore.setStatus('paused', err.message)
          timers.push(
            setTimeout(() => {
              if (!cancelled) connect()
            }, decision.delayMs)
          )
        }
      },
      'conversation',
      clientConversationId
    )
      .then((h) => {
        if (cancelled) {
          try {
            h.stop()
          } catch {
            /* ignore */
          }
          return
        }
        handle = h
      })
      // startTranscription reports the same initial failure through onError,
      // which already owns retry/quota handling above.
      .catch(() => {})
  }

  // New resumable id and a cleared retainer. Deliberately does NOT touch the
  // reconnect budget: the breaker rolls the conversation when it opens, and that
  // is the one case where the lane is anything but healthy.
  function resetConversation(): void {
    markConversationSettled(backendConversationId)
    clientConversationId = crypto.randomUUID()
    backendConversationId = clientConversationId
    // Claimed before the socket opens: the backend adopts a client-proposed id
    // verbatim, so from here on the sweep must treat it as live, not orphaned.
    markConversationStreaming(backendConversationId)
    segmentsInConversation = 0
    conversationStartedAt = Date.now()
    retainer = createSegmentRetainer()
  }

  // Begin a fresh conversation after a boundary the lane crossed successfully —
  // which is itself proof it works, so the budget clears here.
  function startConversation(): void {
    resetConversation()
    retry.noteHealthy()
    circuitOpen = false
    connect()
  }

  captureLiveStore.reset()
  // Defer the initial connect a macrotask so React dev StrictMode's
  // mount→unmount→remount doesn't open two competing /v4/listen sessions (the
  // second "could not connect"); this controller's stop() clears it first.
  timers.push(setTimeout(startConversation, 0))
  const unsubFinalize = onFinalizeRequest(finalize)

  return {
    stop: (): void => {
      if (cancelled) return // idempotent — decrement the active count exactly once
      cancelled = true
      setControllerHealth(controllerId, null)
      clearSilence()
      timers.forEach(clearTimeout)
      unsubFinalize()
      try {
        handle?.stop()
      } catch {
        /* ignore */
      }
      handle = null
      // The session is over (the user stopped listening, the app is sleeping or
      // quitting). Closing the socket asks the backend to finalize; say it
      // outright as well, since the backend only obliges on a clean 1000 and a
      // teardown mid-quit rarely gets one. Nothing captured → nothing to ask for.
      if (segmentsInConversation > 0) scheduleFinalize(backendConversationId, 'stop')
      captureLiveStore.reset()
    }
  }
}
