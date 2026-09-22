# Listen Reconnect (the always-on mic lane's backoff, breaker and stand-down)

Why the `/v4/listen` mic lane reconnects the way it does, and what breaks when
any of it is undone. Client-only. The policy is
`src/renderer/src/capture/listenRetryPolicy.ts`; the lane that drives it is
`src/renderer/src/capture/liveMicSession.ts`; the log lines are printed in
`src/main/ipc/omiListen.ts`.

## The storm this exists for

**2026-09-21, Windows desktop, 47 minutes.** The hosted STT service was
accepting `/v4/listen` handshakes in **~200ms** and then closing them within
seconds with **1011 `transcription_service_unavailable`**. The lane reconnected
about **every 8 seconds** for the whole 47 minutes.

The cause was one line: the loop reset its attempt counter the moment a socket
reached `OPEN`. A socket that connects and dies two seconds later therefore sat
on the first rung forever. That cadence walked the account into the **edge rate
limiter** — a 429 on the handshake, surfacing to the client as a 1006 — whose
floor was 5s. The storm fed itself.

Everything below is the fix, and each rule is load-bearing.

## Rule 1 — connecting is not health

A transport is healthy only once a datum has crossed the **whole** path. This is
the repo's own `FC-bridge-liveness-without-data-path-proof` contract.

`onBackend` (the socket reached OPEN) therefore **does not** clear the budget.
Only two things do, both in `markHealthy()`:

| Proof | Where |
|---|---|
| A delivered transcript — a line or a non-empty segment batch | `onLine` / `onSegments` |
| The socket simply stayed up for `HEALTHY_SESSION_MS` (**60s**) while still open | `onBackend`'s `healthyTimer` |

The lifetime test is also applied retroactively in `onFailure`: if the dying
socket delivered segments *or* lived ≥60s, the slate clears **before** this
failure is counted, so a lane that worked for an hour restarts at 5s rather than
at 5 minutes.

**`deliveredSegments` is per-SOCKET, not per-conversation.** `connect()` builds a
fresh closure each attempt for exactly this reason. The segment retainer outlives
a reconnect, so reading it here would let one early segment excuse every later
failure — which is the 2026-09-21 bug wearing a different hat.

## Rule 2 — the ladder holds, it does not wrap

```
attempt   1      2       3       4        5+
delay     5s     15s     45s     120s     300s (holds)
```

`LADDER_MS`, each rung spread **±20%** (`JITTER_FRACTION`) so lanes and clients
decorrelate. Past the end the schedule **holds at 300s**; it never resets itself.

A **rate-limited** drop (429, or a message matching `isRateLimitedDropError`) is
the server explicitly saying *slow down*, so its delay is the largest of the
ladder rung, any `Retry-After` the server sent, and a hard **60s**
(`RATE_LIMIT_FLOOR_MS`) — and its jitter is **additive only**. A symmetric ±20%
on a 60s floor could retry at 48s, which would break the one guarantee that
branch exists to make. A server `Retry-After` is honored only up to
`RETRY_AFTER_CAP_MS` (**300s**), so a bogus value cannot park the recording for
longer than the schedule's own hold.

## Rule 3 — a clean 1000 close must not strike

`classifyFailure` maps close code **1000 (NORMAL)** and **1001 (GOING_AWAY)** to
`clean_restart`: an orderly teardown. These reconnect at the **first rung** and
**spend nothing** — no failure counted, no breaker progress.

They are orderly teardowns, not faults:

- a user stop,
- a machine going to sleep,
- and the main process's own stale-socket watchdog, which closes with
  **1000 specifically so this lane reconnects**
  (`src/main/ipc/omiListen.ts`, `isSocketStale` → `ws.close(1000, 'watchdog: stale')`).

**If you make 1000 count as a failure, capture freezes.** The watchdog fires
every time a half-open socket stops delivering pings for
`WATCHDOG_STALE_MS` (60s) — its whole job is to force a reconnect. Ten of those
in a bad-network stretch would trip the breaker and stand the lane down for ten
minutes, on a machine whose mic was working fine.

Everything else classifies as `service_unavailable` (1011), `abnormal_close`
(any other close code), `connect_error` (no close code at all), or
`rate_limited`.

## Rule 4 — the breaker stands down, and its order matters

After `MAX_CONSECUTIVE_FAILURES` (**10**) consecutive non-clean failures the
breaker opens and the lane pauses for `CIRCUIT_PAUSE_MS` (**600_000ms — ten
minutes**).

The retry after the pause is a **half-open probe**: `failures` is still at the
limit, so if it also fails the next decision is another pause. Steady state
during a real outage is **one handshake every ten minutes** — never another
storm. It is the fast retries themselves that earn the 429s.

When the breaker opens, `liveMicSession` does four things **in this order**:

1. **Finalize** the abandoned conversation (when `shouldFinalizeAfterClose`
   agrees — see `docs/conversation-finalize.md`), run to completion.
2. **Then** rescue the retained segments into a local conversation.
3. Roll to a fresh conversation id, so resuming cannot post the same speech
   twice.
4. Emit the `paused` notice and set status `paused`.

**Finalize must complete before the rescue starts.** The backend already holds
every retained segment — they came back from it — so finalizing turns them into
a real cloud conversation; the rescue exists for when it did *not*, and dedupes
by reading the cloud list first. Run them concurrently and that dedupe becomes a
race, and both can post the same speech.

Recovery is reported: when a later socket proves healthy while `circuitOpen`,
the lane emits `fallback_triggered` with `outcome: 'recovered'`.

## Rule 5 — the meeting lane keeps a different ladder on purpose

The system (meeting) lane in `src/renderer/src/capture/meetingSession.ts` uses
the **older, shorter** curve in `src/renderer/src/capture/liveRescue.ts` and
must keep it:

| | Mic lane (`listenRetryPolicy`) | Meeting system lane (`liveRescue`) |
|---|---|---|
| Endpoint | `/v4/listen` | `transcribe-stream` |
| Ladder | 5s → 300s, holds | 2s, 4s, 8s, 16s, 32s, then 32s |
| Jitter | ±20% | +0–1000ms, additive |
| Rate-limit floor | 60s | 5s |
| `Retry-After` cap | 300s | 120s |
| Budget | 10 failures → 10-minute stand-down | `MAX_RECONNECT_ATTEMPTS` = 10, then a terminal error |
| Total before giving up | effectively unbounded | ~2.5 minutes |

Three reasons this is not duplication to be collapsed:

1. **A meeting is bounded and in the foreground.** Failing in ~2.5 minutes and
   *saying so* beats sitting at "capturing" on a dead lane for half an hour.
2. **The two lanes ride different endpoints behind different server limits.**
   `transcribe-stream` is rate-limited **per user and shared with PTT**;
   `/v4/listen` is not. `FC-shared-backoff-conflated-independent-budgets` is
   exactly the rule against keying one cooldown to two independently governed
   budgets.
3. **The meeting lane's health proof is narrower.** `transcribe-stream` accepts
   the socket *before* its rate-limit and provider checks, so `onBackend` proves
   even less there than on `/v4/listen`. Its attempt budget resets only on a
   **delivered segment** (`onLine`) — there is no lifetime fallback.

### The per-session budget cut (a workaround, delete when the backend is fixed)

A backend without the budget-slice fix — including Omi's hosted `api.omi.me` —
closes **every** `transcribe-stream` session after ~120s of audio with *"Daily
transcription budget exhausted"* (`FC-stream-budget-slice-treated-as-daily-cap`).

So a lane classified `daily_limit` that lived **≥100s** reconnects in **250ms,
outside the attempt budget**. Audio sent never exceeds wall time, so a lane that
old cannot have burned a real daily budget. A genuinely spent budget is refused
within ~1s of the next connect (connect-time reservation), so that short-lived
lane falls through to the terminal `daily_limit` stop instead.

Remove this branch once every serving backend extends reservations in slices —
until then, deleting it caps every meeting at two minutes.

## Rule 6 — some drops are not worth reconnecting for

`isRetryableDropError` (`liveRescue.ts`) returns **false**, and the lane stops
at once rather than burning the budget, for:

- **quota / entitlement** exhaustion (`trial_expired`) and a spent
  `daily_limit`,
- **not signed in**,
- a **permanent source failure** — the `DOMException` name is one of
  `NotFoundError`, `NotAllowedError`, `NotReadableError`, `OverconstrainedError`.

The source list is why the `name` is checked and not just the message. Before it,
a dead mic (no PipeWire source enumerable — confirmed live via CDP:
`enumerateDevices()` returned zero audio inputs, `getUserMedia` threw
`NotFoundError`) retried silently for the full backoff budget with **no error
ever reaching the UI**. Reconnecting cannot fix the mic.

On the mic lane a quota stop also drives the main window's
`LiveMirrorHost` → `maybeTriggerTranscriptionQuotaPopup` via the mirrored
`'error'` status. Do **not** call `showUsageLimit` from the capture window: it is
a separate renderer, so its in-memory popup signal never reaches the popup host.

## Reading it in the field

The reconnect loop runs in the **capture renderer**, whose console never reaches
disk. Only main-process console is tee'd to `main.log` (`mainLog.ts`), and
`main.log` is the only artifact anyone has when this lane misbehaves in the
field. So each decision is sent over IPC to be printed by `formatRetryNotice`:

```
[omi-listen] retry in 15s (attempt 2, reason=service_unavailable)
[omi-listen] paused after 10 failures; next attempt at 3:41:07 PM
[omi-listen] watchdog: no data for 61204ms — forcing reconnect
```

`reason` is one of `rate_limited`, `service_unavailable`, `abnormal_close`,
`connect_error`, `clean_restart`. Everything crossing that channel is **clamped
and range-checked against a closed set** — it comes from a window that handles
transcripts, and nothing but numbers and enum words may reach the log file. The
handler does no ownership check because it mutates nothing; the worst a stray
sender can do is print a clamped line.

## What keeps the socket alive so it doesn't need reconnecting

Most reconnects are best avoided rather than backed off. The renderer's VAD gate
drops silence before feeding, so a quiet stretch would starve the socket — for a
meeting's system lane, that is any lull on the remote side.

- The backend closes a `/v4/listen` socket after **90s** with no received data
  (close 1001), and a `transcribe-stream` socket after **60s** with no audio
  frame (close 1008, *"Idle timeout"*).
- So during gated silence main sends the documented keepalive — **320 zero bytes**,
  10ms of 16kHz mono s16le — after `KEEPALIVE_IDLE_MS` (**30s**) idle, serviced
  every `SERVICE_CHECK_MS` (**15s**). On `/v4/listen` it resets
  `last_activity_time` **without** advancing the conversation's `finished_at`.
- Never after `finalize` (the backend closes a finalized stream on the next audio
  frame) and never for PTT, whose holds are short.
- A conversation socket that receives nothing at all — not even the ~10s ping —
  for `WATCHDOG_STALE_MS` (**60s**) is half-open and is force-closed with
  **1000** so this lane reconnects. See Rule 3.

Gated silence is kept alive by that keepalive, **not** by reconnecting. Every
reconnect on the meeting lane is a fresh `voice:transcribe_stream` request
against a per-user budget shared with PTT, so drops must stay rare.

## Testing

`listenRetryPolicy.ts` and `liveRescue.ts` are pure and clock-injectable (`now`,
`rand`) precisely so the whole schedule — ladder, jitter, the 429 floor, the
healthy-session reset and the breaker — is exhaustively testable in node, with no
socket and no timer. Keep them that way: a schedule that can only be exercised
against a live backend is a schedule nobody will change safely.
