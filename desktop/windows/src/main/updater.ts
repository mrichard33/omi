// Auto-update via electron-updater, from Mark's private release train and
// nothing else (see updateFeed.ts for the feed and its token).
//
// Silent by design: checks on launch and every 4 hours, downloads in the
// background, and installs on the next quit. The only path that restarts the
// app on the updater's schedule is the explicit "Restart to update" action, and
// that is refused while a recording or meeting capture is live
// (shared/updateInstall.ts).
//
// EVERY build published here carries a `-reece.N` prerelease version
// (scripts/reece-version.mjs), so `allowPrerelease` is on unconditionally. With
// it off, electron-updater would filter out every single build Mark ships and
// report "up to date" forever, with no error to notice.
//
// For local testing, set OMI_UPDATER_DEV=1 and provide dev-app-update.yml. That
// keeps electron-updater on the developer-supplied feed.
import { app, type BrowserWindow } from 'electron'
import { autoUpdater, type CancellationToken } from 'electron-updater'
import { setTrayUpdateReady } from './tray'
import { markQuitting } from './lifecycle'
import { showBestEffortNotification } from './notify'
import { describeUpdateFeed, resolveUpdateFeed, type UpdateFeedConfig } from './updateFeed'
import { resolveUpdateInstall, type UpdateInstallResult } from '../shared/updateInstall'
import type { UpdateCheckResult } from '../shared/types'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** Delayed so the first check does not compete with startup/renderer load. */
const FIRST_CHECK_DELAY_MS = 45_000

/** Reads the live capture state. Injected so the updater never imports the
 *  listen/meeting modules directly and stays unit-testable. */
export type CaptureActivityProbe = () => { listening: boolean; meetingCapturing: boolean }

let started = false
let pendingUpdate: { version: string } | null = null
let feed: UpdateFeedConfig | null = null
let updateCheckTail: Promise<void> = Promise.resolve()
let activeDownload: { version: string; cancellationToken: CancellationToken } | null = null
/** Fail SAFE: with no probe wired we assume capture is live and refuse the
 *  restart, rather than taking the app down mid-recording. */
let probeActivity: CaptureActivityProbe = () => ({ listening: true, meetingCapturing: true })

type ElectronUpdateCheckResult = Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>

/** The update staged for install-on-quit, if any. The update:ready event fires
 * once (usually while nobody is on Settings), so the UI queries this on mount. */
export function getPendingUpdate(): { version: string } | null {
  return pendingUpdate ? { version: pendingUpdate.version } : null
}

/** Busy unless the probe positively says otherwise. A probe that threw, or gave
 *  back something that is not the expected shape, must never read as "idle" and
 *  let a restart through mid-recording. */
const BUSY = { listening: true, meetingCapturing: true }

function readActivity(): { listening: boolean; meetingCapturing: boolean } {
  try {
    const activity = probeActivity()
    if (typeof activity !== 'object' || activity === null) return BUSY
    if (typeof activity.listening !== 'boolean' || typeof activity.meetingCapturing !== 'boolean') {
      return BUSY
    }
    return { listening: activity.listening, meetingCapturing: activity.meetingCapturing }
  } catch (e) {
    console.warn(`[updater] error capture probe failed, treating as busy: ${(e as Error).message}`)
    return BUSY
  }
}

function runUpdateCheck(): Promise<ElectronUpdateCheckResult> {
  const operation = updateCheckTail.then(async (): Promise<ElectronUpdateCheckResult> => {
    if (pendingUpdate) return null
    if (activeDownload) {
      activeDownload.cancellationToken.cancel()
      activeDownload = null
    }

    console.log('[updater] checking')
    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable || !result.cancellationToken) {
      console.log('[updater] none')
      return result
    }

    const version = typeof result.updateInfo?.version === 'string' ? result.updateInfo.version : ''
    console.log(`[updater] available ${version}`)
    const download = { version, cancellationToken: result.cancellationToken }
    activeDownload = download
    try {
      await autoUpdater.downloadUpdate(download.cancellationToken)
    } finally {
      if (activeDownload === download) activeDownload = null
    }
    return result
  })
  updateCheckTail = operation.then(
    (): undefined => undefined,
    (): undefined => undefined
  )
  return operation
}

/**
 * Manual update check for Settings -> About. In unpackaged dev or on an
 * unsupported platform the updater never starts, so there is nothing to check.
 * When active, a staged download reports `update-available`, a newer feed
 * version reports `update-available`, otherwise `up-to-date`. Never throws.
 */
export async function checkForUpdatesNow(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  if (!started) return { status: 'unsupported', version: current }
  if (pendingUpdate) return { status: 'update-available', version: pendingUpdate.version }
  try {
    const res = await runUpdateCheck()
    const found = typeof res?.updateInfo?.version === 'string' ? res.updateInfo.version : undefined
    if (found && found !== current) return { status: 'update-available', version: found }
    return { status: 'up-to-date', version: current }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn(`[updater] error ${message}`)
    return { status: 'error', message }
  }
}

/**
 * Install the staged update now (Settings -> About and the tray's "Restart to
 * update"). Plain app.quit() relies on autoInstallOnAppQuit, which runs the
 * NSIS installer without relaunching; quitAndInstall(silent, forceRunAfter)
 * installs and comes back up on the new version, which is what the button
 * promises.
 *
 * Refused while a recording or meeting capture is live — the staged installer
 * still runs on the next quit, so nothing is lost by waiting.
 */
export function installUpdateNow(): UpdateInstallResult {
  const outcome = resolveUpdateInstall(started && !!pendingUpdate, readActivity())
  if (outcome !== 'installing') {
    if (outcome === 'busy') console.log('[updater] restart deferred: capture in progress')
    return outcome
  }
  markQuitting()
  autoUpdater.quitAndInstall(true, true)
  return 'installing'
}

export function initAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
  captureActivity: CaptureActivityProbe,
  platform: NodeJS.Platform = process.platform
): void {
  if (started || platform !== 'win32') return
  const devForced = process.env.OMI_UPDATER_DEV === '1'
  if (!app.isPackaged && !devForced) return

  probeActivity = captureActivity
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // Every published build is a `-reece.N` prerelease; see the header.
  autoUpdater.allowPrerelease = true

  if (devForced) {
    autoUpdater.forceDevUpdateConfig = true
  } else {
    feed = resolveUpdateFeed(import.meta.env.MAIN_VITE_UPDATER_READ_TOKEN)
    if (!feed) {
      // No token baked in: do not start, rather than fall through to whatever
      // app-update.yml happens to say. A build that cannot authenticate to the
      // private feed has no feed at all.
      console.warn('[updater] error no updater token in this build — auto-update is off')
      return
    }
    autoUpdater.setFeedURL(feed)
  }
  started = true
  console.log(`[updater] feed ${devForced ? 'dev-app-update.yml' : describeUpdateFeed(feed)}`)

  autoUpdater.on('update-downloaded', (info) => {
    // electron-updater emits this before downloadUpdate() settles.
    const download = activeDownload
    const version = typeof info?.version === 'string' ? info.version : ''
    if (!download || version !== download.version) return

    pendingUpdate = { version }
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('update:ready', { version })
    setTrayUpdateReady(true)
    autoUpdater.autoInstallOnAppQuit = true
    console.log(`[updater] downloaded ${version}`)
    // One non-blocking notice. Windows toasts cannot carry action buttons from
    // Electron (`actions` is macOS-only), so the "Restart now" affordance is the
    // tray's "Restart to update" item and the button in Settings -> About; the
    // notice is what tells the user they are there.
    showBestEffortNotification('Update ready — restart to apply', `Omi ${version} is ready.`)
  })

  autoUpdater.on('error', (err) => {
    console.warn(`[updater] error ${err?.message ?? err}`)
  })

  const check = async (): Promise<void> => {
    try {
      await runUpdateCheck()
    } catch (e) {
      console.warn(`[updater] error ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  setTimeout((): void => {
    void check()
  }, FIRST_CHECK_DELAY_MS)
  setInterval((): void => {
    void check()
  }, CHECK_INTERVAL_MS)
}
