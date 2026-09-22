# The listen reconnect policy

Read this before touching the always-on mic lane's reconnect, backoff or circuit
breaker. The rules below are not preferences — each one is load-bearing against a
specific way this lane has already failed in the field.

Code: `src/renderer/src/capture/listenRetryPolicy.ts` (pure, clock-injectable),
used by `src/renderer/src/capture/liveMicSession.ts`. The meeting lane is
deliberately separate — see the last section.

## The incident this exists for

**2026-09-21.** The hosted STT service was accepting `/v4/listen` handshakes in
about 200ms and then closing them within seconds with
`1011 transcription_service_unavailable`.

The lane reconnected roughly **every 8 seconds for 47 minutes**, because the loop
reset its attempt counter the moment a socket reached OPEN. A socket that connects
and dies two seconds later therefore sat on the first rung forever. That cadence
walked the account into the edge rate limiter — `429` on the handshake, surfacing
as a `1006` close — whose floor was 5s. The storm fed itself.

The contract that was violated is the repo's own
`FC-bridge-liveness-without-data-path-proof`.

## Rule 1 — reaching OPEN is not health

**A transport is healthy only once a datum has crossed the whole path.**

`noteHealthy()` is called from exactly two places, and connecting is neither:

| Proof | Where |
|---|---|
| A transcript segment arrived | `markHealthy()` on first delivery |
| The socket stayed up for `HEALTHY_SESSION_MS` (60s) while still open | the healthy timer |

The reset happens **before** the current failure is counted, so a lane that worked
for an hour and then dropped restarts at 5s rather than at 5 minutes.

One subtlety worth keeping: the failure record reads **this socket's own**
`delivered` flag, not the conversation's. The segment retainer outlives a
reconnect, so reading it would let one early segment excuse every later failure —
which is the 47-minute storm again, wearing a different hat.

## Rule 2 — a clean close must not strike

`1000 NORMAL` and `1001 GOING_AWAY` classify as `clean_restart`: they reconnect at
the first rung and **cost nothing**. They are not failures and the breaker never
counts them.

They are orderly teardowns — a user stop, a machine going to sleep, or main's own
stale-socket watchdog, which closes with `1000` *specifically so this lane
reconnects*. A breaker that tripped on them would freeze capture on a laptop that
simply slept overnight.

## The ladder

```
LADDER_MS           5s → 15s → 45s → 120s → 300s, then HOLDS at 300s
JITTER_FRACTION     ±20% on an ordinary rung
HEALTHY_SESSION_MS  60s      socket lifetime that counts as healthy
RATE_LIMIT_FLOOR_MS 60s      a 429 is never retried sooner, ever
RETRY_AFTER_CAP_MS  300s     the most a server Retry-After may park us
MAX_CONSECUTIVE_FAILURES 10  then the breaker opens
CIRCUIT_PAUSE_MS    600s     how long it stays open
```

Failures classify like this:

| Signal | Reason | Counts as a failure? |
|---|---|---|
| `429`, or a rate-limited drop message | `rate_limited` | yes |
| close `1011` | `service_unavailable` | yes |
| close `1000` / `1001` | `clean_restart` | **no** |
| any other close code | `abnormal_close` | yes |
| no close code at all | `connect_error` | yes |

**Rate-limited jitter is additive only.** A symmetric ±20% on a 60s floor could
retry at 48s, which breaks the single guarantee that branch exists to make. The
delay is the largest of the ladder rung, any `Retry-After`, and the 60s floor —
then jittered *upward*.

A bogus `Retry-After` is capped at 300s. A server must not be able to park a
recording indefinitely.

## The breaker

At 10 consecutive failures the policy returns `pause` instead of `retry`, and the
lane stands down for ten minutes.

The retry after that pause is a **half-open probe**: `failures` is still at the
limit, so if the probe also fails the next decision is another pause. Steady state
during a real outage is one handshake every ten minutes — never another storm. A
delivered segment (or a 60s-lived socket) closes the breaker and resets the count.

**Order matters when the breaker opens.** `liveMicSession` finalizes the
conversation *to completion* before running the from-segments rescue. The backend
already holds every retained segment — they came back from it — so finalizing turns
them into a real cloud conversation; the rescue exists for when it did not, and
dedupes by reading the cloud list first. Reversing the order makes the dedupe
non-deterministic.

## Reading it in the field

The reconnect loop lives in the capture **renderer**, whose console never reaches
disk. Only main-process console is tee'd to `main.log`, and `main.log` is the only
artifact anyone has when this lane misbehaves on a real machine. So each decision
is sent over IPC to be printed there:

```
[omi-listen] retry in 15s (attempt 2, reason=service_unavailable)
[omi-listen] paused after 10 failures; next attempt at 3:41:07 PM
```

`formatRetryNotice` (`src/main/ipc/omiListen.ts`) clamps every number and checks
the reason against a closed set. That channel crosses from a window that handles
transcripts, so nothing but numbers and enum words may reach the log file — do not
relax that to pass through a message string.

## Why the meeting lane keeps a different ladder

The meeting system lane (`meetingSession.ts`) uses `liveRescue`'s
`reconnectDelayJitteredMs`, **not** this policy, and that is deliberate:

| | mic lane (`/v4/listen`) | meeting system lane (`transcribe_stream`) |
|---|---|---|
| curve | 5s/15s/45s/120s/300s, holds | capped exponential, max **32s** |
| rate-limit floor | 60s | 5s |
| `Retry-After` cap | 300s | 120s |
| budget | breaker at 10, then 10-min pauses | 10 attempts, then terminal |
| resets on | delivered segment **or** 60s uptime | delivered segment only |

The lanes differ because their failure modes do. The mic lane is always on and must
survive a multi-hour outage without hammering the backend; a meeting is bounded and
a user is watching, so a 5-minute gap in a meeting transcript is worse than a few
extra handshakes. The meeting lane is transcription-only — there is no server
conversation to resume — so a reconnect just keeps appending to the same local
transcript.

Two meeting-lane quirks that look like bugs and are not:

- **The ~120s budget-slice cut.** A backend without the budget-slice fix — including
  Omi's hosted `api.omi.me` — closes every `transcribe_stream` session after roughly
  120s of audio with "Daily transcription budget exhausted". Audio sent never exceeds
  wall time, so a lane that lived ≥100s is assumed to have hit that per-session cut
  and reconnects in 250ms, **outside** the attempt budget. A genuinely spent daily
  budget is refused within ~1s of the next connect, so that short-lived lane falls
  through to the terminal stop instead. Remove this once every serving backend
  extends reservations in slices.
- **Gated silence is kept alive by main's keepalive**, not by reconnecting. Every
  reconnect is a fresh `voice:transcribe_stream` request, rate-limited per user and
  shared with PTT, so drops have to stay rare.

## Things that surprise people

- **A permanent source error is not retryable.** A dead mic — no device, permission
  denied, unusable device, impossible constraints — is a `getUserMedia` DOMException,
  and reconnecting the socket can never fix it. Before that was checked by `name`
  rather than message text, a machine with no enumerable audio input retried silently
  for the whole backoff budget with nothing ever reaching the UI.
- **A bare connect must not reset the budget.** Only proof of data (or 60s of
  uptime) does. This was fixed once already; re-introducing an `onopen` reset
  recreates the 47-minute storm exactly.
- **The policy is pure.** `now` and `rand` are injected, so the whole schedule —
  ladder, jitter, the 429 floor, the healthy reset, the breaker — is tested in node
  with no socket and no timers (`listenRetryPolicy.test.ts`). Keep it that way; a
  policy that needs a live socket to test is a policy nobody will change safely.
