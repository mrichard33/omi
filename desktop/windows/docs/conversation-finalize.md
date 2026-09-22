# Conversation Finalize (mic sessions → processed, without the web app)

How a `/v4/listen` conversation recorded by this app actually gets summarized.
Client-only; the backend behavior described here was read out of `backend/` at
the commit this document landed on, and the lag numbers are measured.

## The problem this exists for

Measured 2026-09-22 over 36 hours: **33 of 36 desktop conversations arrived in
the downstream pipeline 2 hours to 4 days after they ended**, in batches at
exactly the moments the Omi **web** app was opened. Only 3 arrived within 35
minutes. All 36 had `source = desktop`.

Two facts in the backend explain it:

1. `/v4/listen` finalizes a `desktop` conversation at teardown **only when the
   close code is 1000** — `backend/routers/listen/runtime.py`,
   `_teardown_components` (`self.state.close_code == 1000`). The state defaults
   to **1001** and is set to 1000 only when the client's own disconnect frame
   carries it; a receive timeout leaves it at 1001, and a failing STT provider
   sets **1011** (`backend/routers/listen/receiver.py`). Any of those strands
   the conversation at `in_progress` with nothing scheduled.
2. The backend's own rescue, `recover_stale_in_progress()` in
   `backend/routers/listen/conversations.py`, runs **only on the next
   `/v4/listen` connect**, only past an **hour** of idleness
   (`STALE_IN_PROGRESS_RECOVERY_AGE_SECONDS = 3600`), and only **10 rows** per
   connect (`STALE_IN_PROGRESS_RECOVERY_BATCH`). That is the batched release.

So nothing on the Windows side ever asked for a conversation to be processed.

## What the other clients do

Every other Omi client finalizes **explicitly** rather than trusting the socket:

| Client | Call | Where |
|---|---|---|
| Web | `finalizeConversationById(id)` → `POST /v1/conversations/{id}/finalize` | `web/app/src/lib/api.ts` → called on stop in `web/app/src/hooks/useRecording.ts` |
| macOS | `apiClient.finalizeConversation(id:)` → same endpoint | `desktop/macos/Desktop/Sources/ConversationFinalizationService.swift` |
| Mobile | `processInProgressConversation()` → `POST /v1/conversations` | `app/lib/backend/http/api/conversations.dart` → `capture_controller.dart` |

Windows called neither. `src/renderer/src/lib/conversationFinalize.ts` is that
missing call.

## Why the by-id endpoint, not `POST /v1/conversations`

`POST /v1/conversations` operates on the user's **shared Redis "current
in-progress" pointer**, which spans device + web, so it can finalize the
phone's recording instead of ours. `POST /v1/conversations/{id}/finalize` names
exactly one conversation and never touches that pointer — the backend's own
docstring says so. It is also idempotent: a conversation that is no longer
`in_progress` returns 200 without reprocessing, so calling it after the socket
already did the job costs nothing.

## Triggers

| Reason | When |
|---|---|
| `stop` | The session ends: user stops listening, "Save now", the 30s silence boundary, app sleep/quit. |
| `meeting_end` | A meeting's **own** mic lane ends. Not when the mic was delegated to the always-on session — that conversation keeps recording. |
| `abnormal_close` | A socket ended on anything but 1000 **after at least one segment**, and the lane abandoned the conversation (quota/entitlement stop, or the reconnect breaker opening). A reconnect that RESUMES the conversation finalizes nothing. |
| `sweep` | Every 10 minutes and ~15s after startup: any `in_progress` conversation idle more than 5 minutes. Catches whatever was stranded while the app was closed or crashed. |

Each attempt logs exactly one line:

```
[omi-finalize] conversation <id> reason=<stop|meeting_end|abnormal_close|sweep> result=<ok|error>
```

## Two rules that keep this safe

- **Never finalize a conversation that is still streaming.** Lanes register
  their conversation id with `markConversationStreaming()`; `finalizeConversation()`
  refuses a registered id whatever asked for it.
- **The 5-minute idle cutoff is the ownership test.** Any live session — this
  app's, the phone's, the web app's — refreshes `finished_at` on every segment
  (`backend/database/conversations.py`, `select_stale_in_progress`), so five
  minutes of no movement means no session owns the row. A conversation with no
  readable `finished_at` is **skipped**, not swept: the same call the backend
  makes, for the same reason — without a trustworthy idle clock the row cannot
  be proven orphaned.

## Which id gets finalized

The backend adopts a client-proposed `client_conversation_id` verbatim, so a
lane knows its conversation id before the first segment. But the backend can
**roll to a server-minted id mid-socket** (its own silence boundary, a
discarded-row rollover), after which our proposed id names the previous,
already-finished conversation. So both lanes follow the `conversation_session`
event the backend sends (`backend/models/message_event.py`,
`ConversationSessionEvent`) and finalize the id it last announced.

## Where the sweep runs

In the **capture window** (`src/renderer/src/capture/CaptureApp.tsx`), not the
main window's app-lifetime jobs. The capture window owns every capture lane, so
it is the only one that knows which conversations are still streaming — and it
is respawned when it dies (`src/main/captureWindow.ts`), so the sweep is
app-lifetime with it.
