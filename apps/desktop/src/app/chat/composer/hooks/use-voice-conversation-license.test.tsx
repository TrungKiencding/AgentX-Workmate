import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MicRecording } from './use-mic-recorder'
import { useVoiceConversation } from './use-voice-conversation'

// A voice conversation whose transcription is refused for a read-only AgentX
// license says why once and ends — it does not re-listen and fail again on
// every utterance (its own controls are locked with the composer).

vi.mock('@/lib/voice-barge-in', () => ({ monitorSpeechDuringPlayback: () => vi.fn() }))
vi.mock('@/lib/voice-playback', () => ({
  markVoicePlaybackInterrupted: vi.fn(),
  playSpeechText: vi.fn(async () => true),
  startSpeechStream: vi.fn(async () => null),
  stopVoicePlayback: vi.fn()
}))
vi.mock('@/lib/thinking-sound', () => ({ startThinkingSound: vi.fn(), stopThinkingSound: vi.fn() }))

const micHandle = {
  cancel: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn<() => Promise<MicRecording | null>>(async () => null)
}

vi.mock('./use-mic-recorder', () => ({ useMicRecorder: () => ({ handle: micHandle, level: 0, recording: false }) }))
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      notifications: {
        voice: {
          configureSpeechToText: 'configure STT',
          couldNotStartSession: 'could not start',
          microphoneFailed: 'mic failed',
          playbackFailed: 'playback failed',
          transcriptionFailed: 'transcription failed',
          unavailable: 'unavailable'
        }
      }
    }
  })
}))

const notifyError = vi.fn()

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: (...args: unknown[]) => notifyError(...args) }))

const REFUSED = new Error('read-only')
const notifyLicenseRefusal = vi.fn((error: unknown, _title?: string) => error === REFUSED)

vi.mock('@/store/license', () => ({
  notifyAiError: vi.fn(),
  notifyLicenseRefusal: (error: unknown, title?: string) => notifyLicenseRefusal(error, title)
}))

function renderConversation(onTranscribeAudio: () => Promise<string>) {
  const onFatalError = vi.fn()

  const hook = renderHook(() =>
    useVoiceConversation({
      busy: false,
      consumePendingResponse: vi.fn(),
      enabled: true,
      onFatalError,
      onSubmit: vi.fn(async () => undefined),
      onTranscribeAudio,
      pendingResponse: () => null
    })
  )

  return { hook, onFatalError }
}

async function speakOnce(hook: ReturnType<typeof renderConversation>['hook']) {
  await act(async () => {
    await hook.result.current.start()
  })
  await waitFor(() => expect(hook.result.current.status).toBe('listening'))

  micHandle.stop.mockResolvedValueOnce({
    audio: new Blob(['q'], { type: 'audio/webm' }),
    durationMs: 900,
    heardSpeech: true
  })

  await act(async () => {
    hook.result.current.stopTurn()
  })
}

describe('useVoiceConversation and a read-only license', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    micHandle.start.mockResolvedValue(undefined)
    micHandle.stop.mockResolvedValue(null)
  })

  afterEach(cleanup)

  it('a refused transcription says why once and ends the conversation', async () => {
    const { hook, onFatalError } = renderConversation(async () => {
      throw REFUSED
    })

    await speakOnce(hook)

    await waitFor(() => expect(onFatalError).toHaveBeenCalledTimes(1))
    expect(notifyLicenseRefusal).toHaveBeenCalledWith(REFUSED, 'transcription failed')
    expect(notifyError).not.toHaveBeenCalled()
    expect(hook.result.current.status).toBe('idle')
    expect(micHandle.start).toHaveBeenCalledTimes(1)
  })

  it('any other transcription failure is reported and the loop listens again', async () => {
    const failure = new Error('provider timed out')

    const { hook, onFatalError } = renderConversation(async () => {
      throw failure
    })

    await speakOnce(hook)

    await waitFor(() => expect(notifyError).toHaveBeenCalledWith(failure, 'transcription failed'))
    expect(onFatalError).not.toHaveBeenCalled()
  })
})
