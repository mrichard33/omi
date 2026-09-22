// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { AboutTab } from './AboutTab'
import { SettingsSearchProvider } from '../SettingsSearchProvider'

const getAppVersion = vi.fn()
const getPendingUpdate = vi.fn()
const onUpdateReady = vi.fn()
const checkForUpdates = vi.fn()
const whatsNewOpenNotes = vi.fn()
const quitApp = vi.fn()
const installUpdateNow = vi.fn()

const renderTab = (): void => {
  render(
    <SettingsSearchProvider>
      <AboutTab />
    </SettingsSearchProvider>
  )
}

beforeEach(() => {
  getAppVersion.mockReset().mockResolvedValue({ name: 'Omi', version: '1.2.3' })
  getPendingUpdate.mockReset().mockResolvedValue(null)
  onUpdateReady.mockReset().mockReturnValue(() => {})
  checkForUpdates.mockReset().mockResolvedValue({ status: 'up-to-date', version: '1.2.3' })
  whatsNewOpenNotes.mockReset()
  quitApp.mockReset()
  installUpdateNow.mockReset().mockResolvedValue('installing')
  ;(globalThis as unknown as { window: { omi: unknown } }).window.omi = {
    getAppVersion,
    getPendingUpdate,
    onUpdateReady,
    checkForUpdates,
    whatsNewOpenNotes,
    quitApp,
    installUpdateNow
  }
})
afterEach(cleanup)

describe('AboutTab', () => {
  it('shows the real app version', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Version 1.2.3')).toBeTruthy())
  })

  it('opens release notes via the existing IPC', async () => {
    renderTab()
    fireEvent.click(screen.getByText('Release notes'))
    expect(whatsNewOpenNotes).toHaveBeenCalled()
  })

  it('checks for updates and reports the result', async () => {
    renderTab()
    fireEvent.click(screen.getByText('Check for updates'))
    expect(checkForUpdates).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText(/latest version \(1\.2\.3\)/)).toBeTruthy())
  })

  it('surfaces a staged update with a restart affordance', async () => {
    getPendingUpdate.mockResolvedValue({ version: '2.0.0' })
    renderTab()
    await waitFor(() => expect(screen.getByText(/Version 2\.0\.0 is ready/)).toBeTruthy())
    fireEvent.click(screen.getByText('Restart to update'))
    // Installs + relaunches. A plain quit would just close the app with the
    // update never applied (#10509).
    await waitFor(() => expect(installUpdateNow).toHaveBeenCalled())
    expect(quitApp).not.toHaveBeenCalled()
  })

  // #10509: a merely *available* update is not a downloaded one. Promoting the
  // check result to "Update ready" gave users a restart button that quit the app
  // with nothing staged, so it reopened on the same version.
  it('does not claim an update is ready just because one is available', async () => {
    checkForUpdates.mockResolvedValue({ status: 'update-available', version: '2.0.0' })
    renderTab()
    fireEvent.click(screen.getByText('Check for updates'))
    await waitFor(() => expect(screen.getByText(/downloading in the background/)).toBeTruthy())
    expect(screen.queryByText('Restart to update')).toBeNull()
    expect(screen.queryByText(/is ready\. Restart Omi to apply it\./)).toBeNull()
  })

  it('keeps the app open when the staged update vanished', async () => {
    getPendingUpdate.mockResolvedValue({ version: '2.0.0' })
    installUpdateNow.mockResolvedValue('not-staged')
    renderTab()
    await waitFor(() => expect(screen.getByText(/Version 2\.0\.0 is ready/)).toBeTruthy())
    fireEvent.click(screen.getByText('Restart to update'))
    await waitFor(() => expect(screen.getByText(/no longer staged/)).toBeTruthy())
    expect(quitApp).not.toHaveBeenCalled()
    expect(screen.queryByText('Restart to update')).toBeNull()
  })

  // 'busy' is NOT 'not-staged': the update is still there and still installs on
  // the next quit, so the restart affordance must stay and the message must say
  // recording — not that the update vanished.
  it('keeps the update staged and says why when a recording is in progress', async () => {
    getPendingUpdate.mockResolvedValue({ version: '2.0.0' })
    installUpdateNow.mockResolvedValue('busy')
    renderTab()
    await waitFor(() => expect(screen.getByText(/Version 2\.0\.0 is ready/)).toBeTruthy())
    fireEvent.click(screen.getByText('Restart to update'))
    await waitFor(() => expect(screen.getByText(/recording right now/)).toBeTruthy())
    expect(quitApp).not.toHaveBeenCalled()
    expect(screen.getByText('Restart to update')).toBeTruthy()
  })
})
