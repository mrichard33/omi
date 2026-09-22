// One auto-captured meeting session (mic + system-audio lanes), running INSIDE
// the capture window — started/stopped by main's meeting monitor via
// 'meeting-capture-start' / 'meeting-capture-stop' commands.
//
// LANE WIRING (matches useRecorder's screen path):
//  - System (remote) lane: transcription-only ('transcribe'). It is saved LOCALLY
//    only, so it never needs a server-side conversation — riding transcribe-stream
//    keeps it out of the backend's racy per-uid /v4/listen conversation pointer,
//    the same reason the screen recorder uses 'transcribe' for its system lane.
//  - Mic lane: backend-owned /v4/listen ('conversation') — the cloud creates its
//    own titled conversation from the mic stream. Opened here ONLY when no
//    continuous mic session is already running.
//
// C6 (double mic-session race): if the always-on continuous mic session is
// running, it ALREADY streams the mic to /v4/listen. Opening a second mic
// /v4/listen for the same audio spawns a duplicate, racing conversation socket
// (the backend coalesces same-uid conversation sockets). So the mic lane DEFERS
// to the continuous session when `isLiveMicSessionActive()` — the meeting then
// captures only the remote/system side. When nothing else owns the mic, the
// meeting opens the mic lane itself.
//
// LOCAL-SAVE POLICY: the local "Meeting" row saves ONLY the system-audio
// (remote-side) transcript. The mic side is backend-owned (its own cloud
// conversation, via either the continuous session or this meeting's mic lane), so
// saving mic lines here too would duplicate it.
import { startTranscription, type TranscriptionHandle } from '../lib/transcriptionClient'
import { classifyTranscriptionStop } from '../../../shared/transcriptionStop'
import {
  isRateLimitedDropError,
  isRetryableDropError,
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayJitteredMs
} from './liveRescue'
import {
  getLiveMicSessionHealth,
  onLiveMicSessionHealth,
  waitForLiveMicSessionReady
} from './liveMicSession'
import {
  conversationIdFromEvent,
  markConversationSettled,
  markConversationStreaming,
  scheduleFinalize,
  shouldFinalizeAfterClose
} from '../lib/conversationFinalize'
import type { ListenSource, TranscriptLine } from '../../../shared/types'

export type MeetingSessionHandle = {
  /** Finalize: stop both lanes and save the conversation. Resolves when saved. */
  stop: () => Promise<void>
}

/** The local "Meeting" conversation carries the system-audio (remote-side)
 *  transcript only; the mic lane is backend-owned (its own cloud conversation),
 *  so including mic lines here would duplicate them. */
export function formatMeetingTranscript(system: TranscriptLine[]): string {
  return system
    .map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text))
    .join('\n')
    .trim()
}

export async function startMeetingSession(args: {
  appName: string
  onError: (message: string) => void
  signal?: AbortSignal
}): Promise<MeetingSessionHandle> {
  const startedAt = Date.now()
  const systemLines: TranscriptLine[] = []
  let stopped = args.signal?.aborted ?? false
  // Set once startup has fully succeeded; until then a lane error is a startup
  // failure (reported, then the start rejects) rather than a reconnectable drop.
  let live = false
  const startingHandles = new Set<TranscriptionHandle>()
  let systemHandle: TranscriptionHandle | null = null
  let systemReconnectAttempt = 0
  let systemReconnectTimer: ReturnType<typeof setTimeout> | null = null
  // When the current system-lane socket connected (0 = none); see the per-session
  // budget cut in onSystemLaneError.
  let systemConnectedAt = 0
  // Cancels an in-flight reconnect startup on stop(), so a late socket/loopback
  // doesn't linger for the connect timeout after the meeting ended.
  const reconnectAbort = new AbortController()

  // MIC-LANE CONVERSATION (only when this meeting opens the mic lane itself).
  // The backend adopts a client-proposed id verbatim, so proposing one is what
  // lets the meeting name its own conversation when the meeting ends — /v4/listen
  // otherwise only finalizes on a clean 1000 close (backend/routers/listen/
  // runtime.py), and a meeting that ended on a dropped socket sat at
  // "Processing" until someone opened the web app.
  //
  // When the mic is DELEGATED to the always-on continuous session (the C6 case
  // below), this stays null: that conversation keeps recording after the meeting
  // ends, and finalizing it here would cut a live recording in half. The
  // continuous session owns its own finalize.
  const micClientConversationId = crypto.randomUUID()
  let micConversationId: string | null = null
  let micSegments = 0

  const stopStartingHandles = (): void => {
    stopped = true
    if (systemReconnectTimer) clearTimeout(systemReconnectTimer)
    systemReconnectTimer = null
    reconnectAbort.abort()
    for (const handle of startingHandles) {
      try {
        handle.stop()
      } catch {
        /* ignore */
      }
    }
  }
  args.signal?.addEventListener('abort', stopStartingHandles, { once: true })

  // SYSTEM-LANE RECONNECT: once live, a dropped system lane reopens a fresh
  // transcribe-stream socket and keeps appending to the same local transcript
  // (the lane is transcription-only, so there is no server conversation to
  // resume), with liveRescue's jittered backoff. The attempt budget resets only
  // when the lane delivers a segment — transcribe-stream accepts the socket before
  // its rate-limit/provider checks, so "connected" alone doesn't prove health.
  // Every reconnect is a new voice:transcribe_stream request (rate-limited per
  // user, shared with PTT), so drops must stay rare: gated silence is kept alive
  // by main's keepalive (ipc/omiListen.ts), not by reconnecting.
  // Terminal stops (quota, daily limit, a dead loopback source) still end capture.
  const onSystemLaneError = (e: Error): void => {
    if (stopped) return
    if (!live) {
      args.onError(`system: ${e.message}`)
      return
    }
    if (systemHandle) {
      startingHandles.delete(systemHandle)
      try {
        systemHandle.stop() // release the dead session's loopback feed
      } catch {
        /* ignore */
      }
      systemHandle = null
    }
    // PER-SESSION BUDGET CUT: a backend without the budget-slice fix (#1 in this
    // fork — FC-stream-budget-slice-treated-as-daily-cap), including Omi's hosted
    // api.omi.me, closes every transcribe-stream session after ~120s of audio
    // with "Daily transcription budget exhausted". Audio sent never exceeds wall
    // time, so a lane that lived ≥100s may have hit that per-session cut: reconnect
    // at once, outside the attempt budget. A genuinely spent daily budget is
    // refused within ~1s of the next connect (connect-time reservation), so that
    // short-lived lane falls through to the terminal daily-limit stop below.
    // Remove once every serving backend extends reservations in slices.
    const livedMs = systemConnectedAt ? Date.now() - systemConnectedAt : 0
    systemConnectedAt = 0
    let delayMs: number
    if (classifyTranscriptionStop(e.message) === 'daily_limit' && livedMs >= 100_000) {
      delayMs = 250
    } else if (
      !isRetryableDropError(e.message, e.name) ||
      systemReconnectAttempt >= MAX_RECONNECT_ATTEMPTS
    ) {
      args.onError(`system: ${e.message}`)
      return
    } else {
      systemReconnectAttempt++
      delayMs = reconnectDelayJitteredMs(systemReconnectAttempt, {
        rateLimited: isRateLimitedDropError(e.message),
        retryAfterMs: (e as { retryAfterMs?: number }).retryAfterMs
      })
    }
    console.warn(`[meeting-session] system lane dropped, reconnecting in ${delayMs}ms:`, e.message)
    systemReconnectTimer = setTimeout(() => {
      systemReconnectTimer = null
      if (stopped) return
      startLane('system', 'transcribe', reconnectAbort.signal)
        .then((handle) => {
          systemHandle = handle
        })
        // A failed reconnect already reported through onSystemLaneError, which
        // owns the next attempt (or the terminal error).
        .catch(() => {})
    }, delayMs)
  }

  // Both lanes ride the normal capture path: startTranscription opens the
  // main-process listen WS and issues the audio-start command that
  // AudioSessionHost (this window) services with a VAD-gated stream. The system
  // lane is transcription-only ('transcribe') and saved locally; the mic lane is
  // backend-owned ('conversation').
  const startLane = (
    source: ListenSource,
    mode: 'conversation' | 'transcribe',
    signal: AbortSignal | undefined = args.signal
  ): Promise<TranscriptionHandle> =>
    startTranscription(
      source,
      {
        onLine: (line) => {
          if (stopped || source !== 'system') return
          systemLines.push(line)
          systemReconnectAttempt = 0 // a delivered segment proves the lane is healthy
        },
        onInterim: () => {},
        onBackend: () => {
          if (source === 'system') systemConnectedAt = Date.now()
        },
        onSegments: (segs) => {
          if (source === 'mic') micSegments += segs.length
        },
        onEvent: (ev) => {
          if (source !== 'mic') return
          // Follow the conversation the backend says it is writing into: it may
          // roll to a server-minted id mid-socket, and a finalize must name the
          // one that is actually live.
          const announced = conversationIdFromEvent(ev)
          if (!announced) return
          if (micConversationId && announced !== micConversationId) {
            markConversationSettled(micConversationId)
            micSegments = 0
          }
          micConversationId = announced
          markConversationStreaming(announced)
        },
        onError: (e) => {
          console.warn(`[meeting-session] ${source} lane error:`, e.message)
          if (source === 'system') onSystemLaneError(e)
          else if (!stopped) {
            // The mic lane is terminal (it has no reconnect path) — whatever it
            // captured is stranded unless we finalize it now.
            if (
              micConversationId &&
              shouldFinalizeAfterClose((e as { closeCode?: number }).closeCode, micSegments)
            ) {
              scheduleFinalize(micConversationId, 'abnormal_close')
              micConversationId = null
            }
            args.onError(`${source}: ${e.message}`)
          }
        }
      },
      mode,
      source === 'mic' && mode === 'conversation' ? micClientConversationId : undefined,
      signal
    ).then((handle) => {
      if (stopped) {
        handle.stop()
        const error = new Error('Meeting capture startup cancelled')
        error.name = 'AbortError'
        throw error
      }
      startingHandles.add(handle)
      return handle
    })

  // The remote/system side is always captured. The mic lane is opened here only
  // if no continuous mic session already owns the mic (C6) — otherwise we'd open a
  // second, racing /v4/listen for the same audio.
  const starts: Promise<TranscriptionHandle | null>[] = [
    startLane('system', 'transcribe').then((handle) => (systemHandle = handle))
  ]
  const liveMicHealth = getLiveMicSessionHealth()
  const delegatedMic = liveMicHealth === 'connecting' || liveMicHealth === 'ready'
  if (liveMicHealth === 'connecting') {
    starts.push(
      waitForLiveMicSessionReady(args.signal).then((ready) => {
        if (!ready) throw new Error('continuous microphone transcription did not become ready')
        return null
      })
    )
  } else if (liveMicHealth !== 'ready') {
    starts.push(startLane('mic', 'conversation'))
  }

  // allSettled (not all): if one lane fails to start, the sibling lane has
  // ALREADY opened its WS + acquired its stream — Promise.all's reject would
  // strand that resolved handle with no reference (a hot mic with no way to
  // stop it). Collect every fulfilled handle so a failure can tear them ALL
  // down before rethrowing.
  const results = await Promise.allSettled(starts)
  const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
  if (failed) {
    stopStartingHandles()
    args.signal?.removeEventListener('abort', stopStartingHandles)
    throw failed.reason
  }
  if (delegatedMic && getLiveMicSessionHealth() !== 'ready') {
    stopStartingHandles()
    args.signal?.removeEventListener('abort', stopStartingHandles)
    throw new Error('continuous microphone transcription did not remain ready')
  }
  args.signal?.removeEventListener('abort', stopStartingHandles)
  live = true
  // The continuous session passes through 'connecting' on every normal rollover
  // (silence finalize → new conversation) and on each reconnect attempt, then
  // returns to 'ready'. Only 'failed' (reconnects exhausted / terminal stop) or
  // 'inactive' (the session was turned off) means the meeting has lost its mic.
  const offLiveMicHealth = delegatedMic
    ? onLiveMicSessionHealth((health) => {
        if (!stopped && (health === 'failed' || health === 'inactive')) {
          args.onError('microphone: continuous transcription stopped')
        }
      })
    : () => {}

  return {
    stop: async (): Promise<void> => {
      if (stopped) return
      stopStartingHandles()
      offLiveMicHealth()
      // The meeting ended, so the conversation this meeting's own mic lane was
      // writing into is finished — ask the backend to process it rather than
      // trusting the socket's close code. Null when the mic was delegated to the
      // always-on session, which keeps recording and owns its own finalize.
      if (micConversationId && micSegments > 0) {
        scheduleFinalize(micConversationId, 'meeting_end')
        micConversationId = null
      }
      const transcript = formatMeetingTranscript(systemLines)
      // Nothing on the system lane worth saving (mic already went to the
      // backend's own conversation pipeline) — skip the empty row.
      if (!transcript) return
      await window.omi.insertLocalConversation({
        id: `local-${crypto.randomUUID()}`,
        startedAt,
        endedAt: Date.now(),
        transcript: `Meeting (${args.appName})\n\n${transcript}`,
        createdAt: Date.now()
      })
      window.omi.notifyConversationsChanged()
    }
  }
}
