// Pure decision: may we install a staged update RIGHT NOW by restarting?
//
// Auto-update is silent by design — it stages the installer and lets it run on
// the next quit the user asked for. The one path that restarts the app on the
// updater's schedule is "Restart to update", and taking that while the mic is
// streaming would cut a recording in half and lose whatever the backend had not
// yet finalized. So the restart is refused while capture is live, and the user
// is told why instead of the app going down under them.
//
// Install-on-quit is deliberately NOT guarded: the user asked to quit, which
// ends the session anyway.
//
// Lives in shared/ (not main/) for the same reason transcriptionStop.ts does:
// main decides, the renderer renders the outcome, and neither may describe the
// same result differently. Dependency-free, so it unit-tests without a runtime.

export type UpdateInstallResult =
  /** The installer is running; the app is going down and will come back up. */
  | 'installing'
  /** Nothing is staged (never downloaded, or cleared). Not an error. */
  | 'not-staged'
  /** Staged, but capture is live — ask again when it stops. */
  | 'busy'

export type CaptureActivity = {
  /** A /v4/listen socket is open and streaming audio. */
  listening: boolean
  /** A meeting is being captured. */
  meetingCapturing: boolean
}

/**
 * `'installing'` only when something is staged AND nothing is being captured.
 * Both activity flags are read as booleans: an accessor that threw or returned
 * undefined must never read as "idle" and let a restart through, so callers
 * pass explicit booleans and the fail-safe is at the call site.
 */
export function resolveUpdateInstall(
  staged: boolean,
  activity: CaptureActivity
): UpdateInstallResult {
  if (!staged) return 'not-staged'
  if (activity.listening || activity.meetingCapturing) return 'busy'
  return 'installing'
}

/** One sentence for the UI, so main and the renderer cannot describe the same
 *  outcome differently. */
export function describeUpdateInstall(result: UpdateInstallResult): string | null {
  switch (result) {
    case 'installing':
      return null
    case 'busy':
      return 'Omi is recording right now — the update will install when you next quit, or restart once recording stops.'
    case 'not-staged':
      return 'That update is no longer staged. Omi will offer to restart once it downloads again.'
  }
}
