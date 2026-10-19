// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InsightPayload, MeetingToastPayload } from '../../../../shared/types'
import { InsightToast } from './InsightToast'

let onMeetingToast: ((payload: MeetingToastPayload) => void) | null = null
const meetingAction = vi.fn()
const insightDismiss = vi.fn()
const proactivityNotificationOpen = vi.fn()
const proactivityNotificationRendered = vi.fn()
const proactivityNotificationFeedback = vi.fn()
let frame: FrameRequestCallback | null = null
let onInsightShow: ((payload: InsightPayload) => void) | null = null

beforeEach(() => {
  frame = null
  proactivityNotificationRendered.mockReset()
  proactivityNotificationFeedback.mockReset()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { frame = null })
  onMeetingToast = null
  onInsightShow = null
  proactivityNotificationOpen.mockReset()
  meetingAction.mockReset()
  insightDismiss.mockReset()
  vi.stubGlobal('window', {
    omi: {
      onInsightShow: (cb: (payload: InsightPayload) => void) => {
        onInsightShow = cb
        return () => {}
      },
      proactivityNotificationOpen,
      proactivityNotificationRendered,
      proactivityNotificationFeedback,
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

it('opens a v2 card by opaque ID without accepting a renderer-supplied destination', () => {
  render(<InsightToast />)
  act(() => onInsightShow?.({ headline: 'Follow up', advice: 'Synthetic long body '.repeat(40),
    reasoning: '', category: 'other', sourceApp: 'Omi', confidence: 1, proactivityItemID: 'item-1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  expect(proactivityNotificationOpen).toHaveBeenCalledWith('item-1')
  expect(meetingAction).not.toHaveBeenCalled()
})

it('acknowledges a mounted frame, reports feedback, and sends explicit dismiss separately', () => {
  render(<InsightToast />)
  expect(proactivityNotificationRendered).not.toHaveBeenCalled()
  act(() => onInsightShow?.({ headline: 'Follow up', advice: 'Synthetic', reasoning: '',
    category: 'other', sourceApp: 'Omi', confidence: 1, proactivityItemID: 'item-2' }))
  expect(proactivityNotificationRendered).not.toHaveBeenCalled()
  act(() => frame?.(0))
  expect(proactivityNotificationRendered).toHaveBeenCalledWith('item-2')
  fireEvent.click(screen.getByRole('button', { name: 'Helpful' }))
  expect(proactivityNotificationFeedback).toHaveBeenCalledWith('item-2', 'thumbs_up')
  fireEvent.click(screen.getByRole('button', { name: 'Not helpful' }))
  expect(proactivityNotificationFeedback).toHaveBeenCalledWith('item-2', 'thumbs_down')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(insightDismiss).toHaveBeenCalledOnce()
})
