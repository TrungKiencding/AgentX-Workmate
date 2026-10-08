import { act, cleanup, renderHook } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopLicense } from '@/global'
import { $license } from '@/store/license'
import { $autoSpeakReplies } from '@/store/voice-prefs'

import { useAutoSpeakReplies } from './use-auto-speak-replies'

// "Speak replies" reads nothing aloud while the AgentX license is read-only —
// and what arrived meanwhile is not read out later, once it covers AI again.

const playSpeechText = vi.fn(async (..._args: unknown[]) => true)

vi.mock('@/lib/voice-playback', () => ({ playSpeechText: (...args: unknown[]) => playSpeechText(...args) }))
vi.mock('@/store/ambient', () => ({ ownsAmbientCue: async () => true }))

const $messages = atom<unknown[]>([])

vi.mock('../scope', () => ({ useComposerScope: () => ({ $messages }) }))

interface Reply {
  id: string
  pending: boolean
  text: string
}

function renderAutoSpeak(reply: { current: null | Reply }) {
  const markSpoken = vi.fn(() => {
    reply.current = null
  })

  renderHook(() =>
    useAutoSpeakReplies({
      conversationActive: false,
      failureLabel: 'read aloud failed',
      markSpoken,
      pendingReply: () => reply.current,
      sessionId: 's1'
    })
  )

  return { markSpoken }
}

function useLicense(license: DesktopLicense | null) {
  $license.set({ account: 'kien', available: true, checking: false, lastCheck: null, license, loaded: true })
}

describe('useAutoSpeakReplies and a read-only license', () => {
  beforeEach(() => {
    playSpeechText.mockClear()
    $autoSpeakReplies.set(true)
  })

  afterEach(() => {
    cleanup()
    $autoSpeakReplies.set(false)
    useLicense(null)
  })

  it('a reply that lands is consumed, not spoken', async () => {
    useLicense({ access: 'read_only', enforced: true, notice: 'read_only', plan: null, state: 'revoked' })
    const reply: { current: null | Reply } = { current: null }
    const { markSpoken } = renderAutoSpeak(reply)

    reply.current = { id: 'a1', pending: false, text: 'hello' }
    await act(async () => $messages.set([{ id: 'a1' }]))

    expect(markSpoken).toHaveBeenCalled()
    expect(reply.current).toBeNull()
    expect(playSpeechText).not.toHaveBeenCalled()
  })

  it('speaks as before while the license covers AI', async () => {
    const reply: { current: null | Reply } = { current: null }

    renderAutoSpeak(reply)

    reply.current = { id: 'a2', pending: false, text: 'hello' }
    await act(async () => $messages.set([{ id: 'a2' }]))

    expect(playSpeechText).toHaveBeenCalledWith('hello', { messageId: 'a2', source: 'read-aloud' })
  })
})
