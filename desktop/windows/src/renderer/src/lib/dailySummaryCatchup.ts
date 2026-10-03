import type { AxiosRequestConfig } from 'axios'
import { omiApi } from './apiClient'
import type { DailySummariesResponse } from './omiApi.generated'

// Daily-summary catch-up (Reece, 2026-10-03).
//
// Daily summaries ("recaps") are made by Omi's hosted server: an hourly job picks
// each owner at 10 PM local and summarizes the day. For Mark's account that job
// reached him only about once a week (Sept 11, 19 and 26), each time back-filling at
// most 3 missed days, and nothing at all after Sept 26 while recording carried on
// every day. The macOS app covers the server's misses by asking for a recap itself
// (`POST /v1/users/daily-summaries`, APIClient+DailySummaries.swift); this Windows
// build never did, so a skipped night simply stayed empty.
//
// This job is that missing caller. It lists the recent recaps, and for each of the
// last LOOKBACK_DAYS local days with none, asks the server to make one. The server
// returns an existing recap without spending tokens, answers 400 when a day has
// nothing to summarize, and 409 while its own job is mid-way through the same day.
//
// "Today" is only asked for from TODAY_AFTER_HOUR, so the server's own 10 PM run
// (which also sends the phone push) goes first.

export const LOOKBACK_DAYS = 7
export const TODAY_AFTER_HOUR = 23
const FIRST_RUN_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 30 * 60 * 1000
const SLOT_STORAGE_KEY = 'omi.dailySummaryCatchup.lastSlot'
// Generating a recap is one LLM call over the whole day; macOS gives it 180s too.
const GENERATE_TIMEOUT_MS = 180_000

// Background calls: never route a dead session to the sign-in screen, and own 429
// ourselves (the interceptor's 5 retries would only hammer a quota/cooldown answer).
const BACKGROUND = { __sessionPreserving: true, __noRetry: true } as AxiosRequestConfig

export type CatchupApi = {
  get: (url: string, config?: AxiosRequestConfig) => Promise<{ data: unknown }>
  post: (url: string, body: unknown, config?: AxiosRequestConfig) => Promise<{ data: unknown }>
}

export type CatchupDeps = {
  api: CatchupApi
  now: () => Date
}

export type CatchupResult = {
  created: string[]
  nothingToSummarize: string[]
  // Stopped early on a quota / rate answer; the rest waits for the next slot.
  stopped: boolean
  // A day the server was busy with, or a network error: try again next pass.
  retryLater: boolean
}

/** YYYY-MM-DD for the LOCAL calendar day of `d` (the server's recap date format). */
export function localDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** The local days to make sure have a recap, newest first. */
export function candidateDates(now: Date): string[] {
  const out: string[] = []
  if (now.getHours() >= TODAY_AFTER_HOUR) out.push(localDateKey(now))
  for (let back = 1; back <= LOOKBACK_DAYS; back++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    out.push(localDateKey(d))
  }
  return out
}

/** One pass per half-day is enough: the morning pass fills earlier days, the late
 *  evening pass adds today. */
export function slotKey(now: Date): string {
  return `${localDateKey(now)}|${now.getHours() >= TODAY_AFTER_HOUR ? 'late' : 'day'}`
}

function statusOf(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status
}

export async function runDailySummaryCatchup(deps: CatchupDeps): Promise<CatchupResult> {
  const result: CatchupResult = {
    created: [],
    nothingToSummarize: [],
    stopped: false,
    retryLater: false
  }
  const listed = await deps.api.get('/v1/users/daily-summaries', {
    ...BACKGROUND,
    params: { limit: LOOKBACK_DAYS + 7 }
  })
  const summaries = (listed.data as DailySummariesResponse | undefined)?.summaries ?? []
  const have = new Set(summaries.map((s) => s.date))

  for (const date of candidateDates(deps.now())) {
    if (have.has(date)) continue
    try {
      await deps.api.post(
        '/v1/users/daily-summaries',
        { date },
        { ...BACKGROUND, timeout: GENERATE_TIMEOUT_MS }
      )
      result.created.push(date)
    } catch (e) {
      const status = statusOf(e)
      if (status === 400) {
        result.nothingToSummarize.push(date)
      } else if (status === 402 || status === 403 || status === 429) {
        // Out of quota or rate-limited: asking for more days only collects more no's.
        result.stopped = true
        break
      } else if (status === undefined || status === 409 || status >= 500) {
        // 409 (the server is making it right now), 5xx, timeout, offline.
        result.retryLater = true
      }
      // Any other 4xx (e.g. 422 when the server's idea of "today" differs) is not
      // going to change in half an hour; the next slot asks again.
    }
  }
  return result
}

function readSlot(): string | null {
  try {
    return localStorage.getItem(SLOT_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeSlot(slot: string): void {
  try {
    localStorage.setItem(SLOT_STORAGE_KEY, slot)
  } catch {
    // Storage unavailable: the in-memory guard still holds for this session.
  }
}

let started = false
let running = false
let doneSlot: string | null = null

async function tick(deps: CatchupDeps): Promise<void> {
  if (running) return
  const slot = slotKey(deps.now())
  if (doneSlot === slot || readSlot() === slot) return
  running = true
  try {
    const r = await runDailySummaryCatchup(deps)
    if (r.created.length || r.nothingToSummarize.length || r.stopped) {
      console.log(
        `[daily-summary] catch-up: made ${r.created.length} (${r.created.join(', ') || '-'}), ` +
          `nothing to summarize ${r.nothingToSummarize.length}` +
          (r.stopped ? ', stopped on quota/rate limit' : '')
      )
    }
    // A busy or failed day leaves the slot open so the next half-hour tick retries it.
    if (!r.retryLater) {
      doneSlot = slot
      writeSlot(slot)
    }
  } catch (e) {
    console.warn('[daily-summary] catch-up failed:', (e as Error).message)
  } finally {
    running = false
  }
}

/** Start the catch-up once per app session: shortly after launch, then every 30
 *  minutes (each tick is a no-op once its half-day slot is done). */
export function maybeStartDailySummaryCatchup(
  deps: CatchupDeps = { api: omiApi as unknown as CatchupApi, now: () => new Date() }
): void {
  if (started) return
  started = true
  setTimeout(() => void tick(deps), FIRST_RUN_DELAY_MS)
  setInterval(() => void tick(deps), CHECK_INTERVAL_MS)
}
