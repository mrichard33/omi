import { ipcMain, WebContents, webContents } from 'electron'
import WebSocket from 'ws'
import {
  PCM_PENDING_MAX_BYTES,
  type BackendSegment,
  type ListenEvent,
  type ListenMessage,
  type ListenMode,
  type ListenRetryNotice,
  type ListenStartArgs
} from '../../shared/types'
import { ByokKeyStore } from '../agentKernel/byokStore'
import { isByokActive, withByokHeaders } from '../../shared/byok'
import { decodeUidFromIdToken } from '../auth/omiAuth'
import { noteBackendStatus } from '../observability/backendDegraded'

/**
 * An HTTP `Retry-After` (delta-seconds or an HTTP-date) as ms from `now`, or
 * undefined when absent/unparseable. Negative dates clamp to 0.
 */
export function parseRetryAfterMs(
  value: string | string[] | undefined,
  now: number = Date.now()
): number | undefined {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim()
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) return Number(raw) * 1000
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

const RETRY_REASONS = new Set([
  'rate_limited',
  'service_unavailable',
  'abnormal_close',
  'connect_error',
  'clean_restart'
])

/**
 * One reconnect decision as a log line. The reconnect loop lives in the capture
 * RENDERER, whose console never reaches disk — only main-process console is tee'd
 * to main.log (see mainLog.ts), and main.log is the only artifact anyone has when
 * this lane misbehaves in the field. So the decision is sent here to be printed.
 *
 * Everything is clamped and the reason is checked against a closed set: this
 * channel crosses from a window that handles transcripts, and nothing but numbers
 * and enum words may reach the log file.
 */
export function formatRetryNotice(notice: ListenRetryNotice, locale?: string): string | null {
  if (notice?.kind === 'retry') {
    const delayMs = Math.max(0, Math.round(Number(notice.delayMs) || 0))
    const attempt = Math.max(1, Math.round(Number(notice.attempt) || 1))
    const reason = RETRY_REASONS.has(notice.reason) ? notice.reason : 'other'
    return `[omi-listen] retry in ${Math.round(delayMs / 1000)}s (attempt ${attempt}, reason=${reason})`
  }
  if (notice?.kind === 'paused') {
    const failures = Math.max(0, Math.round(Number(notice.failures) || 0))
    const at = Number(notice.resumeAtMs)
    const when = Number.isFinite(at) ? new Date(at).toLocaleTimeString(locale) : 'unknown'
    return `[omi-listen] paused after ${failures} failures; next attempt at ${when}`
  }
  return null
}

// Lazy so this module stays import-pure (ByokKeyStore's default path needs
// app.getPath('userData'), only ready after the app is).
let byokStore: ByokKeyStore | null = null
function getByokStore(): ByokKeyStore {
  if (!byokStore) byokStore = new ByokKeyStore()
  return byokStore
}

/**
 * The listen socket is the STT lane. When BYOK is active (any LLM key set — see
 * `isByokActive`), attach an X-BYOK-* header for every configured key so the
 * session runs on the user's keys (Deepgram only when a Deepgram key is set;
 * otherwise managed STT). Backend rule (`backend/utils/byok.py`): a BYOK-active
 * user must send a header for EVERY enrolled provider or the upgrade is refused
 * (WS 4003); headers for non-enrolled providers are ignored. Note that on a
 * BYOK session the backend also structures the conversation with the user's
 * OpenAI key, so a bad key fails conversation saving, not transcription. Keys
 * are read fresh per connection (no caching) and never logged.
 */
function byokSttHeaders(base: Record<string, string>): Record<string, string> {
  try {
    const keys = getByokStore().getAllKeys()
    return isByokActive(keys) ? withByokHeaders(base, keys) : base
  } catch {
    // A broken/unavailable key store must never fail the listen socket — fall
    // back to Omi-managed transcription (no BYOK headers) rather than throw.
    return base
  }
}

/**
 * Build the WebSocket endpoint for a listen session by mode.
 *
 * - 'conversation' → `/v4/listen`: the full pipeline (speech profiles, speaker
 *   assignment, memory events) that keeps a per-uid server-side conversation.
 *   Used for continuous MIC-ONLY recording. Codec `pcm16`.
 * - 'ptt' and 'transcribe' → `/v2/voice-message/transcribe-stream`:
 *   transcription-only, NO conversation lifecycle. 'ptt' is the overlay's
 *   hold-to-talk (separate holds never share state — an earlier hold's speech
 *   can't bleed into the next; mirrors the macOS `.ptt` mode). 'transcribe' is
 *   the same endpoint for SCREEN-session lanes (mic + system): two /v4/listen
 *   sockets from one uid coalesce via a racy user-global Redis pointer (verified
 *   splitting/bleeding on prod), so screen lanes stream transcription-only and
 *   the client creates the conversation on stop via from-segments. The distinct
 *   mode value keeps PTT's supersede logic from killing screen sessions.
 *   NOTE: this endpoint requires `codec=linear16` (it rejects `pcm16` with a
 *   1008 close); linear16 is the same little-endian PCM16 bytes we already send,
 *   just the name the endpoint expects.
 *
 * The caller appends `&uid=` for conversation mode only (PTT is header-auth only).
 *
 * `clientConversationId` (conversation mode only): forwarded as
 * `client_conversation_id` so a reconnect resumes the SAME server-side conversation
 * (see ListenStartArgs). Ignored for the transcription-only endpoints.
 */
export function buildListenEndpoint(
  mode: ListenMode,
  language: string,
  clientConversationId?: string
): string {
  const lang = encodeURIComponent(language || 'en')
  if (mode === 'ptt' || mode === 'transcribe') {
    return (
      'wss://api.omi.me/v2/voice-message/transcribe-stream' +
      `?language=${lang}` +
      '&sample_rate=16000' +
      '&codec=linear16' +
      '&channels=1'
    )
  }
  return (
    'wss://api.omi.me/v4/listen' +
    `?language=${lang}` +
    '&sample_rate=16000' +
    '&codec=pcm16' +
    '&channels=1' +
    '&include_speech_profile=true' +
    '&source=desktop' +
    '&speaker_auto_assign=enabled' +
    (clientConversationId
      ? `&client_conversation_id=${encodeURIComponent(clientConversationId)}`
      : '')
  )
}

// ── Silence keepalive (long-lived sockets: conversation + transcribe) ─────────
// The backend closes a /v4/listen socket after 90s with no received data
// (transcribe.py inactivity_timeout, close 1001), and a transcribe-stream socket
// after 60s with no audio frame (chat.py _WS_IDLE_TIMEOUT_S, close 1008 "Idle
// timeout"). The renderer VAD gate drops silence before feeding, so a quiet
// stretch would silently starve the socket and kill live transcription — for a
// meeting's system lane that is any lull on the remote side. During gated
// silence we send the documented silence keepalive (b'\x00'*320): on /v4/listen
// it resets last_activity_time WITHOUT advancing the conversation's finished_at
// (see docs/.../listen_pusher_pipeline.mdx §6); on transcribe-stream it is 10ms
// of silence that resets the audio-idle clock (screen/meeting lanes re-derive
// wall-clock segment times at arrival — lib/sync/segmentRetention.ts — so the
// padding doesn't skew them). Never after 'finalize' (the backend closes a
// finalized stream on the next audio frame) and never for PTT, whose holds are
// short. Mac streams ALL audio so its socket never starves; we keep the gate (a
// tested bandwidth optimization — see soak.ts / run-vad-playback.mjs) and add
// the keepalive instead.
const KEEPALIVE_IDLE_MS = 30_000 // send a keepalive after this long with no real audio (well under 60s)
const SERVICE_CHECK_MS = 15_000 // how often to service the socket (keepalive + watchdog)
// A conversation socket that receives nothing (not even the ~10s ping) for this
// long is a dead/half-open connection TCP hasn't reset — force-close it so the
// client reconnects. Matches the macOS reference (60s stale threshold).
const WATCHDOG_STALE_MS = 60_000
// 320 zero bytes = 10ms of 16kHz mono s16le silence — the exact frame the pipeline
// contract names. Kept as a fresh Buffer per session send is unnecessary (ws copies
// on send); a shared frozen frame is fine.
const KEEPALIVE_FRAME = Buffer.alloc(320)

/** Pure decision: should this session emit a silence keepalive now? Only the
 *  long-lived sockets (conversation, and transcribe-stream screen/meeting lanes)
 *  starve on silence — never a short PTT hold, never a finalized stream; only when
 *  OPEN; only after the idle threshold. */
export function shouldSendKeepalive(
  mode: ListenMode,
  readyState: number,
  msSinceLastFeed: number,
  finalized: boolean
): boolean {
  return (
    mode !== 'ptt' &&
    !finalized &&
    readyState === WebSocket.OPEN &&
    msSinceLastFeed >= KEEPALIVE_IDLE_MS
  )
}

/** Pure decision: has this conversation socket gone silent long enough to be
 *  considered dead (no inbound frame incl. ping)? OPEN conversation sockets only. */
export function isSocketStale(
  mode: ListenMode,
  readyState: number,
  msSinceLastMessage: number
): boolean {
  return (
    mode === 'conversation' &&
    readyState === WebSocket.OPEN &&
    msSinceLastMessage >= WATCHDOG_STALE_MS
  )
}

type Session = {
  ws: WebSocket
  ownerId: number // webContents id for routing replies back
  source: 'mic' | 'system'
  mode: ListenMode
  closed: boolean
  // Audio captured before the socket reaches OPEN. The renderer starts streaming
  // PCM the moment the mic is live, but the WS handshake can take a beat (esp. PTT
  // transcribe-stream under load). Without this, a quick hold ("hello") is spoken
  // and released before OPEN, so every chunk is dropped and nothing transcribes.
  // We buffer those pre-OPEN chunks (bounded) and flush them on 'open'.
  pending: Buffer[]
  pendingBytes: number
  // Epoch ms of the last REAL audio chunk fed (not keepalives). Drives the silence
  // keepalive so a gated-silent conversation socket never starves past 90s.
  lastFeedAt: number
  // Epoch ms of the last message RECEIVED from the backend (incl. pings, which
  // arrive ~every 10s). Drives the watchdog: a half-open socket that TCP hasn't
  // reset stops delivering pings, so no message for WATCHDOG_STALE_MS means the
  // socket is dead and must be force-closed so the client reconnects.
  lastMessageAt: number
  // A transcribe-stream session that was sent 'finalize': any later audio frame
  // (a keepalive included) makes the backend close it, so keepalives stop.
  finalized: boolean
  // Long-lived sockets only (not PTT): periodic idleness check (keepalive, plus
  // the watchdog on conversation sockets).
  keepaliveTimer: ReturnType<typeof setInterval> | null
}

const sessions = new Map<string, Session>()
// Ownership outlives the WebSocket itself. A socket can close before the
// renderer sends audio-stop; retaining this record lets the same renderer tear
// down its local capture pipeline without opening control to other windows.
const sessionOwners = new Map<string, number>()
const ownersWithDestroyHook = new Set<number>()

// Base headers every v4/listen WS carries: auth plus the platform/device
// identity the backend's platform normalization reads (X-App-Platform,
// X-Device-Id-Hash). BYOK STT headers are layered on top at the call site.
export function buildListenHeaders(token: string, deviceIdHash: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-App-Platform': 'windows',
    'X-Device-Id-Hash': deviceIdHash
  }
}

// Verification counters — monotonic bytes/chunks the renderer has fed per
// `${mode}:${source}`, read by the soak + VAD-playback harnesses via
// getListenStats(). Post-gate audio only (the renderer's VAD gate drops silence
// before feeding), so a flat byte delta across a silent interval proves gating.
// Never reset within a process.
const listenStats = new Map<string, { bytes: number; chunks: number }>()

function recordFed(mode: ListenMode, source: 'mic' | 'system', bytes: number): void {
  const key = `${mode}:${source}`
  const cur = listenStats.get(key) ?? { bytes: 0, chunks: 0 }
  cur.bytes += bytes
  cur.chunks += 1
  listenStats.set(key, cur)
}

/** OMI_E2E only: register a socketless counting session so the VAD-playback
 * harness can assert post-gate byte flow with zero auth/network. feedSession
 * counts via recordFed then drops the bytes (stub is never OPEN/CONNECTING). */
export function startTestListenSession(sessionId: string, source: 'mic' | 'system'): boolean {
  if (process.env.OMI_E2E !== '1') return false
  const stub = {
    readyState: 3, // CLOSED — feedSession counts, then neither sends nor buffers
    close(): void {
      /* no socket */
    },
    send(): void {
      /* no socket */
    }
  } as unknown as WebSocket
  sessions.set(sessionId, {
    ws: stub,
    ownerId: -1,
    source,
    mode: 'conversation',
    closed: false,
    pending: [],
    pendingBytes: 0,
    lastFeedAt: Date.now(),
    lastMessageAt: Date.now(),
    finalized: false,
    keepaliveTimer: null
  })
  return true
}

export function stopTestListenSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  s.closed = true
  sessions.delete(sessionId)
}

/** Snapshot of bytes/chunks fed per mode:source since process start. */
export function getListenStats(): Record<string, { bytes: number; chunks: number }> {
  const out: Record<string, { bytes: number; chunks: number }> = {}
  for (const [k, v] of listenStats) out[k] = { bytes: v.bytes, chunks: v.chunks }
  return out
}

function emit(ownerId: number, msg: ListenMessage): void {
  const wc = webContents.fromId(ownerId)
  if (wc && !wc.isDestroyed()) {
    wc.send('omi-listen:message', msg)
  }
}

/** Stop and clear a session's keepalive/watchdog timer, if any. Shared by every
 *  path that tears a session down so the timer can't drift between call sites. */
function stopKeepalive(s: Session): void {
  if (s.keepaliveTimer) {
    clearInterval(s.keepaliveTimer)
    s.keepaliveTimer = null
  }
}

const SERVICE_STATUS_LOG_FIELDS = ['status', 'reason', 'provider', 'outcome', 'retryable'] as const

/** Log-safe summary of a backend `service_status` event: only the bounded
 *  primitive fields, each truncated — never the raw payload. */
export function serviceStatusLogFields(event: Record<string, unknown>): string {
  return SERVICE_STATUS_LOG_FIELDS.flatMap((key) => {
    const value = event[key]
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? [`${key}=${String(value).slice(0, 64)}`]
      : []
  }).join(' ')
}

/** The one way a session dies early: mark closed, drop buffers, remove from the
 *  map, close the socket. Shared by replace/supersede/stop so Session cleanup
 *  can't drift between call sites. */
function killSession(id: string, s: Session, why: string): void {
  console.log(`[omi-listen] ${why} ${id} mode=${s.mode} (readyState=${s.ws.readyState})`)
  s.closed = true
  s.pending = []
  s.pendingBytes = 0
  stopKeepalive(s)
  sessions.delete(id)
  try {
    // A client-initiated stop of an OPEN socket is a normal closure, so say so:
    // `/v4/listen` only finalizes a desktop conversation at teardown when the
    // close code is 1000 (backend/routers/listen/runtime.py), and a bare close()
    // sends an empty close frame the server sees as 1005. A socket that never
    // opened just aborts its handshake.
    if (s.ws.readyState === WebSocket.OPEN) s.ws.close(1000, 'client stop')
    else s.ws.close()
  } catch {
    /* ignore */
  }
}

function startSession(args: ListenStartArgs, owner: WebContents): void {
  const registeredOwner = sessionOwners.get(args.sessionId)
  if (registeredOwner !== undefined && registeredOwner !== owner.id) {
    console.warn('[omi-listen] rejected cross-owner session replacement')
    return
  }
  const existing = sessions.get(args.sessionId)
  if (existing) {
    // Already running under the same id — caller bug; tear down to avoid leaks.
    killSession(args.sessionId, existing, 'replace')
  }
  sessionOwners.set(args.sessionId, owner.id)
  if (!ownersWithDestroyHook.has(owner.id)) {
    ownersWithDestroyHook.add(owner.id)
    owner.once('destroyed', () => {
      ownersWithDestroyHook.delete(owner.id)
      killSessionsForOwner(owner.id)
    })
  }
  const mode: ListenMode = args.mode ?? 'conversation'

  // Push-to-talk is a single-at-a-time gesture. When a new PTT hold opens its
  // connection, close any prior PTT session for the same window — a rapid series of
  // holds otherwise leaves several connections handshaking to the same endpoint at
  // once, and they contend (connect times balloon from ~100ms to 4-11s). The
  // superseded hold is NOT lost: its renderer job keeps its locally-retained
  // buffer, sees the stream death, and falls back to batch transcription.
  if (mode === 'ptt') {
    for (const [id, s] of sessions) {
      if (id !== args.sessionId && s.mode === 'ptt' && s.ownerId === owner.id) {
        killSession(id, s, `supersede (new PTT hold ${args.sessionId})`)
      }
    }
  }

  const base = buildListenEndpoint(mode, args.language, args.clientConversationId)
  let url = base
  if (mode === 'conversation') {
    // Decode (not verify) the JWT to derive the uid for the query param; the
    // backend verifies the token from the Authorization header. uid stays empty
    // when the token is undecodable (the backend also reads the Authorization
    // header). Official docs require `uid` as a query param; backend source reads
    // the token from the Authorization header too — send both.
    const uid = decodeUidFromIdToken(args.token)
    if (uid) url = `${base}&uid=${encodeURIComponent(uid)}`
  }
  // PTT is header-auth only (no uid query param, matching the macOS client) since
  // there's no per-uid conversation to key.

  const ws = new WebSocket(url, {
    headers: byokSttHeaders(buildListenHeaders(args.token, args.deviceIdHash))
  })
  ws.binaryType = 'arraybuffer'
  const session: Session = {
    ws,
    ownerId: owner.id,
    source: args.source,
    mode,
    closed: false,
    pending: [],
    pendingBytes: 0,
    lastFeedAt: Date.now(),
    lastMessageAt: Date.now(),
    finalized: false,
    keepaliveTimer: null
  }
  sessions.set(args.sessionId, session)
  const t0 = Date.now()
  console.log(`[omi-listen] start ${args.sessionId} mode=${mode} source=${args.source}`)

  // A non-101 handshake reply — in practice the edge rate limit's 429 in front of
  // /v4/listen. ws's default turns it into a bare "Unexpected server response: N"
  // error and DROPS the response, Retry-After included, so the renderer could only
  // guess a backoff. Keep the status + Retry-After, then terminate: from CONNECTING
  // that runs ws's own handshake abort, so 'error' and 'close' still fire as before.
  let rejection: { status: number; retryAfterMs?: number } | null = null
  ws.on('unexpected-response', (_req, res) => {
    rejection = {
      status: res.statusCode ?? 0,
      retryAfterMs: parseRetryAfterMs(res.headers['retry-after'])
    }
    noteBackendStatus(rejection.status, 'WS /v4/listen') // feeds the 429-storm banner
    ws.terminate()
  })

  ws.on('open', () => {
    console.log(`[omi-listen] connected ${args.sessionId} mode=${mode} in ${Date.now() - t0}ms`)
    noteBackendStatus(200, 'WS /v4/listen') // an accepted handshake is a recovery signal
    // Flush audio captured while the handshake was in flight, in order, so speech
    // spoken during the connect window (e.g. a quick "hello") isn't lost.
    if (session.pending.length > 0) {
      console.log(
        `[omi-listen] flush ${args.sessionId} ${session.pending.length} pre-connect chunk(s) (${session.pendingBytes}B)`
      )
      for (const chunk of session.pending) {
        try {
          ws.send(chunk)
        } catch {
          /* ignore */
        }
      }
      session.pending = []
      session.pendingBytes = 0
    }
    // Reset the idle/liveness clocks at connect (a slow handshake shouldn't count
    // as silence) and start servicing the long-lived (non-PTT) socket.
    session.lastFeedAt = Date.now()
    session.lastMessageAt = Date.now()
    if (mode !== 'ptt' && !session.keepaliveTimer) {
      session.keepaliveTimer = setInterval(() => serviceSocket(session), SERVICE_CHECK_MS)
      session.keepaliveTimer.unref?.() // never keep the process alive just to service a socket
    }
    emit(session.ownerId, { sessionId: args.sessionId, kind: 'connected' })
  })

  ws.on('message', (data, isBinary) => {
    // Any inbound frame — including the ~10s heartbeat ping — proves the socket is
    // still alive; stamp it BEFORE filtering pings so the watchdog sees liveness.
    session.lastMessageAt = Date.now()
    if (isBinary) return // both endpoints send text only; ignore stray binary
    const text = data.toString().trim()
    if (text === 'ping' || text === '') return
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return
    }
    if (Array.isArray(json)) {
      const segments = json as BackendSegment[]
      console.log(`[omi-listen] segments ${args.sessionId} mode=${mode} count=${segments.length}`)
      emit(session.ownerId, {
        sessionId: args.sessionId,
        kind: 'segments',
        segments
      })
      return
    }
    if (json && typeof json === 'object' && 'type' in (json as object)) {
      const obj = json as Record<string, unknown>
      const event: ListenEvent = { type: String(obj.type), raw: obj }
      if (event.type === 'service_status') {
        // A terminal STT failure (then close 1011 transcription_service_unavailable)
        // explains itself only here; keep the why in main.log.
        console.log(
          `[omi-listen] service_status ${args.sessionId} mode=${mode} ${serviceStatusLogFields(obj)}`
        )
      }
      emit(session.ownerId, { sessionId: args.sessionId, kind: 'event', event })
    }
  })

  ws.on('error', (err) => {
    // A rejected handshake keeps ws's historical message (the renderer's 429
    // classifier matches it) and adds the structured status + Retry-After.
    const r: { status: number; retryAfterMs?: number } | null = rejection
    const message = r ? `Unexpected server response: ${r.status}` : err.message
    const retryAfter = r?.retryAfterMs !== undefined ? ` retry-after=${r.retryAfterMs}ms` : ''
    console.log(
      `[omi-listen] error ${args.sessionId} mode=${mode} after ${Date.now() - t0}ms (readyState=${ws.readyState}): ${message}${retryAfter}`
    )
    emit(session.ownerId, {
      sessionId: args.sessionId,
      kind: 'error',
      message,
      fatal: ws.readyState !== WebSocket.OPEN,
      ...(r ? { status: r.status, retryAfterMs: r.retryAfterMs } : {})
    })
  })

  ws.on('close', (code, reasonBuf) => {
    if (session.closed) return
    session.closed = true
    stopKeepalive(session)
    sessions.delete(args.sessionId)
    const reason = reasonBuf.toString()
    console.log(
      `[omi-listen] closed ${args.sessionId} mode=${mode} code=${code}${reason ? ` reason=${reason}` : ''}`
    )
    emit(session.ownerId, {
      sessionId: args.sessionId,
      kind: 'closed',
      code,
      reason
    })
  })
}

/** Periodic service for a long-lived socket: first the watchdog (conversation
 *  only — force-close a dead/half-open socket so the client reconnects), then the
 *  silence keepalive (b'\x00'*320 during gated silence so the backend's inactivity
 *  timer never fires). Keepalives are NOT counted in listenStats — they're
 *  transport padding, not fed audio, so the soak/gate harnesses still see a flat
 *  byte delta across silence. */
function serviceSocket(s: Session): void {
  if (s.closed) return
  if (isSocketStale(s.mode, s.ws.readyState, Date.now() - s.lastMessageAt)) {
    console.log(
      `[omi-listen] watchdog: no data for ${Date.now() - s.lastMessageAt}ms — forcing reconnect`
    )
    try {
      s.ws.close(1000, 'watchdog: stale')
    } catch {
      /* ignore — close handler still fires */
    }
    return
  }
  if (!shouldSendKeepalive(s.mode, s.ws.readyState, Date.now() - s.lastFeedAt, s.finalized)) return
  try {
    s.ws.send(KEEPALIVE_FRAME)
  } catch {
    /* ignore — a failing send means the socket is already dying; close will fire */
  }
}

function feedSession(sessionId: string, pcm: ArrayBuffer): void {
  const s = sessions.get(sessionId)
  if (!s) return
  recordFed(s.mode, s.source, pcm.byteLength)
  s.lastFeedAt = Date.now()
  if (s.ws.readyState === WebSocket.OPEN) {
    s.ws.send(pcm)
    return
  }
  // Still connecting (or closing): buffer so pre-OPEN speech isn't dropped. Once
  // OPEN the 'open' handler flushes these. Bounded — drop oldest past the cap.
  if (s.ws.readyState === WebSocket.CONNECTING) {
    const chunk = Buffer.from(pcm)
    s.pending.push(chunk)
    s.pendingBytes += chunk.byteLength
    while (s.pendingBytes > PCM_PENDING_MAX_BYTES && s.pending.length > 1) {
      const dropped = s.pending.shift()!
      s.pendingBytes -= dropped.byteLength
    }
  }
}

/**
 * Transcribe-stream sessions only ('ptt'/'transcribe'): ask the backend to flush
 * buffered audio and finalize Deepgram so the trailing segment is emitted promptly
 * (~0.3s), instead of waiting out silence. PTT CONTRACT: the renderer only calls
 * this after it has observed the 'connected' message — a hold released while still
 * connecting skips the stream lane entirely and batch-transcribes its
 * locally-retained buffer instead, so a not-OPEN call here is simply a no-op.
 * Screen sessions ('transcribe') call it at stop so trailing speech lands before
 * the lanes are merged; a never-connected lane is likewise a no-op.
 */
function finalizeSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s || s.mode === 'conversation' || s.ws.readyState !== WebSocket.OPEN) return
  console.log(`[omi-listen] finalize ${sessionId}`)
  s.finalized = true
  try {
    s.ws.send('finalize')
  } catch {
    /* ignore */
  }
}

function stopSession(sessionId: string, ownerId?: number): void {
  if (ownerId !== undefined && sessionOwners.get(sessionId) !== ownerId) return
  const s = sessions.get(sessionId)
  if (s) killSession(sessionId, s, 'stop')
  sessionOwners.delete(sessionId)
}

/** Close every session owned by a webContents that no longer exists — a crashed
 * capture window leaves its sessions' WebSockets lingering until server timeout
 * otherwise. Called by captureWindow on respawn. */
export function killSessionsForOwner(ownerId: number): void {
  for (const [id, s] of sessions) {
    if (s.ownerId === ownerId) killSession(id, s, `owner ${ownerId} gone`)
  }
  for (const [id, registeredOwner] of sessionOwners) {
    if (registeredOwner === ownerId) sessionOwners.delete(id)
  }
}

/** Authorization seam for captureBridge: an audio command may only control the
 * listen session opened by that same renderer. */
export function isListenSessionOwnedBy(sessionId: string, ownerId: number): boolean {
  return sessionOwners.get(sessionId) === ownerId
}

export function registerOmiListenHandlers(canStartSession: (ownerId: number) => boolean): void {
  // Expose the byte counters to the E2E harnesses (VAD-playback / soak) so a
  // Playwright electronApp.evaluate can read them from the main process. Gated on
  // OMI_E2E — inert in production.
  if (process.env.OMI_E2E === '1') {
    ;(globalThis as Record<string, unknown>).__omiGetListenStats = getListenStats
  }
  ipcMain.handle('omi-listen:start', (e, args: ListenStartArgs) => {
    if (!canStartSession(e.sender.id)) {
      throw new Error('listen session is not allowed from this window')
    }
    startSession(args, e.sender)
  })
  ipcMain.handle('omi-listen:stop', (e, sessionId: string) => {
    stopSession(sessionId, e.sender.id)
  })
  // `on` (not `handle`) — feed is fire-and-forget to keep audio throughput cheap.
  ipcMain.on('omi-listen:feed', (e, sessionId: string, pcm: ArrayBuffer) => {
    if (!isListenSessionOwnedBy(sessionId, e.sender.id)) return
    feedSession(sessionId, pcm)
  })
  ipcMain.on('omi-listen:finalize', (e, sessionId: string) => {
    if (!isListenSessionOwnedBy(sessionId, e.sender.id)) return
    finalizeSession(sessionId)
  })
  // Log-only: the reconnect loop runs in the capture renderer, whose console never
  // reaches main.log. No session id and no ownership check because nothing is
  // mutated — the worst a stray sender can do is print a clamped line.
  ipcMain.on('omi-listen:retry-notice', (_e, notice: ListenRetryNotice) => {
    const line = formatRetryNotice(notice)
    if (line) console.log(line)
  })
}
