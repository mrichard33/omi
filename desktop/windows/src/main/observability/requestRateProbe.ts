// Counts this install's requests to api.omi.me over a sliding minute and warns —
// once per window — when the count nears the edge rate limit, naming the routes
// that spent the budget.
//
// Why: api.omi.me sits behind a per-Authorization-header edge rate limit (~120
// requests/min; see backend/routers/memories.py). The /v4/listen handshake shares
// that budget with every REST call the app makes under the same token, so a burst
// of background reads 429s the NEXT listen reconnect, and the user sees "Unexpected
// server response: 429" with no hint of which caller spent the budget. This makes
// the spender visible in main.log.
//
// Sources: the webRequest hook sees every Chromium-stack request (renderer XHR/
// fetch AND main-process net.fetch); the listen socket (node `ws`) reports its own
// handshakes via noteApiRequest.
//
// LOGGING SECURITY: only METHOD + a normalized path. Query strings are dropped and
// any path segment that is not a plain word or version (ids, emails, dates) becomes
// `:id`.
import type { Session } from 'electron'

const WINDOW_MS = 60_000
/** Warn below the ~120/min edge limit, while there is still budget to spare. */
const DEFAULT_WARN_AT = 80
const TOP_ROUTES = 8

/** A plain path word (`conversations`, `action-items`) or an API version (`v4`). */
const PLAIN_SEGMENT = /^(?:v\d{1,2}|[A-Za-z_-]{1,40})$/

/** `GET /v1/conversations/:id` — method + normalized path, never a query string. */
export function routeKey(method: string, url: string): string {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return `${method.toUpperCase()} :unparseable`
  }
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => (PLAIN_SEGMENT.test(s) ? s : ':id'))
  return `${method.toUpperCase()} /${segments.join('/')}`
}

export type RateReport = { total: number; top: Array<[string, number]> }

/** Pure sliding-window counter. `record` returns a report the first time the
 *  window reaches `warnAt`, then stays quiet until a full window has passed. */
export class RequestRateWindow {
  private hits: Array<{ at: number; key: string }> = []
  private lastReportAt = -Infinity

  constructor(
    private readonly warnAt: number,
    private readonly windowMs: number = WINDOW_MS,
    private readonly now: () => number = Date.now
  ) {}

  record(key: string): RateReport | null {
    const t = this.now()
    this.hits.push({ at: t, key })
    const cutoff = t - this.windowMs
    let i = 0
    while (i < this.hits.length && this.hits[i].at < cutoff) i++
    if (i > 0) this.hits = this.hits.slice(i)

    if (this.hits.length < this.warnAt || t - this.lastReportAt < this.windowMs) return null
    this.lastReportAt = t
    const counts = new Map<string, number>()
    for (const h of this.hits) counts.set(h.key, (counts.get(h.key) ?? 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_ROUTES)
    return { total: this.hits.length, top }
  }
}

function warnThreshold(): number {
  const v = Number(process.env.OMI_REQUEST_RATE_WARN)
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_WARN_AT
}

let rateWindow: RequestRateWindow | null = null

/** Record one request to api.omi.me. Non-throwing; logs at most once a minute. */
export function noteApiRequest(key: string): void {
  rateWindow ??= new RequestRateWindow(warnThreshold())
  const report = rateWindow.record(key)
  if (!report) return
  const routes = report.top.map(([k, n]) => `${k} x${n}`).join(', ')
  console.warn(
    `[request-rate] ${report.total} api.omi.me requests in the last 60s (edge limit ~120/token): ${routes}`
  )
}

/** Count every completed Chromium-stack request to api.omi.me. Uses onCompleted,
 *  which nothing else in the app registers (Electron keeps one listener per event). */
export function registerRequestRateProbe(session: Session): void {
  session.webRequest.onCompleted({ urls: ['https://api.omi.me/*'] }, (details) => {
    noteApiRequest(routeKey(details.method, details.url))
  })
}
