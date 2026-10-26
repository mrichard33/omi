// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingToastPayload } from '../../../../shared/types'
import { InsightToast } from './InsightToast'

let onMeetingToast: ((payload: MeetingToastPayload) => void) | null = null
const meetingAction = vi.fn()
const insightDismiss = vi.fn()

beforeEach(() => {
  onMeetingToast = null
  meetingAction.mockReset()
  insightDismiss.mockReset()
  vi.stubGlobal('window', {
    omi: {
      onInsightShow: () => () => {},
      onMeetingToast: (cb: (payload: MeetingToastPayload) => void) => {
        onMeetingToast = cb
        return () => {}
      },
      onWhatsNewToast: () => () => {},
      meetingGetToast: async () => null,
      whatsNewGetPending: async () => null,
      meetingAction,
      insightHoverStart: vi.fn(),
      insightHoverEnd: vi.fn(),
      insightDismiss
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function show(kind: MeetingToastPayload['kind']): void {
  act(() => {
    onMeetingToast?.({ meetingId: 'meeting-1', appName: 'Google Meet', kind })
  })
}

function showError(
  errorKind: NonNullable<MeetingToastPayload['errorKind']>,
  errorReason?: MeetingToastPayload['errorReason']
): void {
  act(() => {
    onMeetingToast?.({
      meetingId: 'meeting-1',
      appName: 'Google Meet',
      kind: 'error',
      errorKind,
      ...(errorReason ? { errorReason } : {})
    })
  })
}

describe('meeting capture status toast', () => {
  it('shows startup progress without claiming capture is live', () => {
    render(<InsightToast />)
    show('starting')

    expect(screen.getByText('Starting capture — Google Meet')).toBeTruthy()
    expect(screen.queryByText(/Omi is capturing/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('shows a retry action after startup fails', () => {
    render(<InsightToast />)
    show('error')

    expect(screen.getByText("Capture didn't start — Google Meet")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(meetingAction).toHaveBeenCalledWith('meeting-1', 'start')
  })

  it('does not offer Retry for a save failure', () => {
    render(<InsightToast />)
    showError('save')

    expect(screen.getByText("Capture couldn't be saved — Google Meet")).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(screen.getByText('Dismiss', { selector: '.meeting-btn' }))
    expect(meetingAction).toHaveBeenCalledWith('meeting-1', 'dismiss')
  })

  it('names a spent daily limit instead of blaming sign-in/mic, and offers no Retry', () => {
    // Live bug: a daily-budget stop showed "Check your sign-in, internet connection,
    // and Windows microphone access, then retry." — none of which could fix it.
    render(<InsightToast />)
    showError('runtime', 'daily_limit')

    expect(screen.getByText('Capture stopped — Google Meet')).toBeTruthy()
    expect(screen.getByText(/daily voice transcription limit is used up/)).toBeTruthy()
    expect(screen.queryByText(/microphone access/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByText('Dismiss', { selector: '.meeting-btn' })).toBeTruthy()
  })

  it('names a used-up free quota as the reason capture stopped', () => {
    render(<InsightToast />)
    showError('runtime', 'quota')

    expect(screen.getByText(/free Omi transcription is used up/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('keeps the generic advice and Retry for an ordinary runtime drop', () => {
    render(<InsightToast />)
    showError('runtime')

    expect(screen.getByText(/Check your sign-in/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
