import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'omi-updater-'))

const autoUpdater = vi.hoisted(() => ({
  allowPrerelease: false,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  forceDevUpdateConfig: false,
  setFeedURL: vi.fn(),
  on: vi.fn(),
  checkForUpdates: vi.fn().mockResolvedValue({ updateInfo: { version: '9.9.9' } }),
  downloadUpdate: vi.fn().mockResolvedValue([]),
  quitAndInstall: vi.fn()
}))
vi.mock('electron-updater', () => ({ autoUpdater }))
vi.mock('electron', () => ({
  app: {
    getPath: (): string => dir,
    getVersion: (): string => '1.0.35-reece.41',
    isPackaged: true,
    on: (): void => {}
  },
  globalShortcut: {
    register: (): boolean => true,
    unregister: (): void => {},
    isRegistered: (): boolean => false
  }
}))
vi.mock('./tray', () => ({ setTrayUpdateReady: vi.fn() }))
const showBestEffortNotification = vi.hoisted(() => vi.fn())
vi.mock('./notify', () => ({ showBestEffortNotification }))

import { checkForUpdatesNow, getPendingUpdate, initAutoUpdater, installUpdateNow } from './updater'

const TOKEN = 'github_pat_updater_read_only'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** The 'update-downloaded' handler the updater registered on electron-updater. */
function downloadedHandler(): (info: { version: string }) => void {
  const call = autoUpdater.on.mock.calls.find((c) => c[0] === 'update-downloaded')
  expect(call, 'updater never registered update-downloaded').toBeTruthy()
  return call![1] as (info: { version: string }) => void
}

let idle = { listening: false, meetingCapturing: false }

beforeEach(() => {
  idle = { listening: false, meetingCapturing: false }
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

// updater.ts holds module state (started / pendingUpdate), so these run in order
// against ONE initialised updater — the same way the process does.
describe('initAutoUpdater', () => {
  it('ignores a non-Windows platform entirely', () => {
    initAutoUpdater(
      () => null,
      () => idle,
      'linux'
    )
    expect(autoUpdater.on).not.toHaveBeenCalled()
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled()
  })

  it('points at Mark private releases repo and NEVER at Omi official feed', () => {
    vi.stubEnv('MAIN_VITE_UPDATER_READ_TOKEN', TOKEN)
    vi.useFakeTimers()
    initAutoUpdater(
      () => null,
      () => idle,
      'win32'
    )

    expect(autoUpdater.setFeedURL).toHaveBeenCalledTimes(1)
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'mrichard33',
      repo: 'omi-desktop-releases',
      private: true,
      token: TOKEN
    })
    // The regression this whole change exists to prevent: any feed naming
    // BasedHardware would auto-replace this fork's build with Omi's stock app.
    const feedArg = JSON.stringify(autoUpdater.setFeedURL.mock.calls[0][0])
    expect(feedArg).not.toContain('BasedHardware')
    expect(feedArg).not.toContain('api.omi.me')
  })

  it('allows prereleases, because every published build is one', () => {
    // scripts/reece-version.mjs stamps `x.y.z-reece.N`. With allowPrerelease off,
    // electron-updater filters out every build Mark ships and reports up-to-date
    // forever, with nothing in the log to notice.
    expect(autoUpdater.allowPrerelease).toBe(true)
  })

  it('downloads in the background, not automatically, and stages install-on-quit', () => {
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
  })
})

describe('update checks (nothing staged yet)', () => {
  it('logs the required lines for a check that finds nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    autoUpdater.checkForUpdates.mockResolvedValueOnce({
      updateInfo: { version: '1.0.35-reece.41' }
    })

    await expect(checkForUpdatesNow()).resolves.toEqual({
      status: 'up-to-date',
      version: '1.0.35-reece.41'
    })
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines).toContain('[updater] checking')
    expect(lines).toContain('[updater] none')
    log.mockRestore()
  })

  it('reports a failed check as an error and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    autoUpdater.checkForUpdates.mockReset()
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('feed unreachable'))

    await expect(checkForUpdatesNow()).resolves.toEqual({
      status: 'error',
      message: 'feed unreachable'
    })
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain('[updater] error feed unreachable')
    warn.mockRestore()
  })

  it('reports not-staged when nothing has been downloaded', () => {
    autoUpdater.quitAndInstall.mockClear()
    expect(getPendingUpdate()).toBeNull()
    expect(installUpdateNow()).toBe('not-staged')
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })
})

// From here the module holds ONE staged update, exactly as the process would:
// nothing clears it but the install that takes the app down.
describe('a staged update', () => {
  it('logs available + downloaded, notifies once, and arms install-on-quit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const download = deferred<string[]>()
    const cancellationToken = { cancel: vi.fn() }
    autoUpdater.checkForUpdates.mockReset()
    autoUpdater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '1.0.35-reece.42' },
      cancellationToken
    })
    autoUpdater.downloadUpdate.mockReset()
    autoUpdater.downloadUpdate.mockReturnValueOnce(download.promise)
    showBestEffortNotification.mockClear()

    const checking = checkForUpdatesNow()
    await vi.waitFor(() =>
      expect(autoUpdater.downloadUpdate).toHaveBeenCalledWith(cancellationToken)
    )
    downloadedHandler()({ version: '1.0.35-reece.42' })
    download.resolve([])
    await checking

    expect(getPendingUpdate()).toEqual({ version: '1.0.35-reece.42' })
    // Install-on-quit is armed only once something is actually staged.
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines).toContain('[updater] available 1.0.35-reece.42')
    expect(lines).toContain('[updater] downloaded 1.0.35-reece.42')
    // One non-blocking notice, not one per check.
    expect(showBestEffortNotification).toHaveBeenCalledOnce()
    expect(showBestEffortNotification.mock.calls[0][0]).toMatch(/restart to apply/i)
    log.mockRestore()
  })

  it('NEVER restarts during an active listening session', () => {
    autoUpdater.quitAndInstall.mockClear()
    idle = { listening: true, meetingCapturing: false }

    expect(installUpdateNow()).toBe('busy')
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    // Still staged: the installer runs on the next quit instead.
    expect(getPendingUpdate()).toEqual({ version: '1.0.35-reece.42' })
  })

  it('NEVER restarts during a meeting capture', () => {
    autoUpdater.quitAndInstall.mockClear()
    idle = { listening: false, meetingCapturing: true }

    expect(installUpdateNow()).toBe('busy')
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('refuses the restart when the capture probe answers with nothing usable', () => {
    // Fail SAFE. An unreadable probe must not read as "idle" — that is the one
    // way this guard could still take the app down mid-recording.
    autoUpdater.quitAndInstall.mockClear()
    idle = null as unknown as { listening: boolean; meetingCapturing: boolean }

    expect(installUpdateNow()).toBe('busy')
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('installs and relaunches once capture stops', () => {
    autoUpdater.quitAndInstall.mockClear()
    idle = { listening: false, meetingCapturing: false }

    expect(installUpdateNow()).toBe('installing')
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})
