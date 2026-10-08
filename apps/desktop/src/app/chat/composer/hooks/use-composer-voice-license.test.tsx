import { act, cleanup, renderHook } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopLicense } from '@/global'
import { requestVoiceConversationStart } from '@/store/composer'
import { $license } from '@/store/license'

import { useComposerVoice } from './use-composer-voice'

// The composer's voice while the AgentX license turns read-only: a running
// voice conversation ends (its controls are locked with the composer), and a
// wake word's request to start one is dropped — not left to fire, unprompted,
// once the license covers AI again.

const conversation = {
  end: vi.fn(async () => undefined),
  level: 0,
  muted: false,
  status: 'idle',
  stopTurn: vi.fn(),
  toggleMute: vi.fn()
}

vi.mock('./use-voice-conversation', () => ({ useVoiceConversation: () => conversation }))
vi.mock('./use-voice-recorder', () => ({
  useVoiceRecorder: () => ({ dictate: vi.fn(), voiceActivityState: 'idle', voiceStatus: 'idle' })
}))
vi.mock('./use-auto-speak-replies', () => ({ useAutoSpeakReplies: vi.fn() }))
vi.mock('../scope', () => ({ useComposerScope: () => ({ $messages: atom([]) }) }))
vi.mock('@/store/wake-word', () => ({ resumeWakeAfterVoice: vi.fn(async () => undefined) }))
vi.mock('@/lib/wake-indicator', () => ({ clearWakeIndicator: vi.fn(), syncWakeIndicatorWithVoice: () => false }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({
    t: {
      assistant: { thread: { readAloudFailed: 'read aloud failed' } },
      notifications: { voice: { sayStopToEnd: (phrase: string) => `say ${phrase}` } },
      settings: { config: { autosaveFailed: 'autosave failed' } }
    }
  })
}))

const READ_ONLY: DesktopLicense = {
  access: 'read_only',
  contact: 'it@astralx.com.vn',
  enforced: true,
  notice: 'read_only',
  plan: null,
  state: 'revoked'
}

function useLicense(license: DesktopLicense | null) {
  $license.set({ account: 'kien', available: true, checking: false, lastCheck: null, license, loaded: true })
}

function renderVoice() {
  return renderHook(
    ({ disabled }: { disabled: boolean }) =>
      useComposerVoice({
        busy: false,
        clearDraft: vi.fn(),
        disabled,
        focusInput: vi.fn(),
        insertText: vi.fn(),
        maxRecordingSeconds: 120,
        onSubmit: vi.fn(async () => true),
        onTranscribeAudio: vi.fn(async () => ''),
        sessionId: 's1',
        target: 'main'
      }),
    { initialProps: { disabled: false } }
  )
}

describe('useComposerVoice and a read-only license', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLicense(null)
  })

  afterEach(() => {
    cleanup()
    useLicense(null)
  })

  it('a running voice conversation ends when the license turns read-only', () => {
    const hook = renderVoice()

    act(() => hook.result.current.startConversation())
    expect(hook.result.current.voiceConversationActive).toBe(true)

    act(() => useLicense(READ_ONLY))
    // The composer locks with the license.
    hook.rerender({ disabled: true })

    expect(hook.result.current.voiceConversationActive).toBe(false)
    expect(conversation.end).toHaveBeenCalled()
  })

  it("a wake word's start request is dropped, not kept for after the renewal", () => {
    useLicense(READ_ONLY)
    const hook = renderVoice()

    hook.rerender({ disabled: true })
    act(() => requestVoiceConversationStart())

    act(() => useLicense({ ...READ_ONLY, access: 'full', notice: null, state: 'active' }))
    hook.rerender({ disabled: false })

    expect(hook.result.current.voiceConversationActive).toBe(false)
  })

  it('without a license in the way, a wake request starts the conversation as before', () => {
    const hook = renderVoice()

    act(() => requestVoiceConversationStart())

    expect(hook.result.current.voiceConversationActive).toBe(true)
  })
})
