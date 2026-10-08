import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopLicense } from '@/global'

// The renderer's AI clients — one-off generation, speech playback — refuse
// before anything is sent while the AgentX license is read-only. (The backend
// refuses the same work regardless; this keeps a request from being made.)

const speakText = vi.fn()
const gatewayRequest = vi.fn()

vi.mock('@/hermes', () => ({ getApiRequestProfile: () => null, speakText: (...args: unknown[]) => speakText(...args) }))
vi.mock('@/store/gateway', async () => {
  const { atom } = await import('nanostores')

  return { $gateway: atom({ request: (...args: unknown[]) => gatewayRequest(...args) }) }
})

const { $license, LicenseRefusedError } = await import('@/store/license')
const { requestOneShot } = await import('./oneshot')
const { playSpeechText, startSpeechStream } = await import('./voice-playback')

const READ_ONLY: DesktopLicense = {
  access: 'read_only',
  contact: 'it@astralx.com.vn',
  days_left: null,
  enforced: true,
  last_day: '2026-12-31',
  notice: 'read_only',
  plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
  read_only_from: '2027-01-08',
  reminder: null,
  state: 'expired'
}

const original = window.agentxDesktop

beforeEach(() => {
  speakText.mockReset()
  gatewayRequest.mockReset()
  $license.set({ account: 'kien', available: true, checking: false, lastCheck: null, license: READ_ONLY, loaded: true })
})

afterEach(() => {
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
  $license.set({ account: null, available: false, checking: false, lastCheck: null, license: null, loaded: false })
})

describe('one-off generation', () => {
  it('is refused before the gateway is asked', async () => {
    await expect(requestOneShot({ template: 'commit_message' })).rejects.toBeInstanceOf(LicenseRefusedError)
    expect(gatewayRequest).not.toHaveBeenCalled()
  })

  it('runs while the license covers AI', async () => {
    $license.set({ ...$license.get(), license: { ...READ_ONLY, access: 'full', notice: null, state: 'active' } })
    gatewayRequest.mockResolvedValue({ text: ' feat: x ' })

    await expect(requestOneShot({ template: 'commit_message', sessionId: null })).resolves.toBe('feat: x')
  })
})

describe('speech playback', () => {
  it('reading aloud is refused before any audio is requested', async () => {
    const getConnection = vi.fn()

    Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: { getConnection } })

    await expect(playSpeechText('Xin chào', { source: 'read-aloud' })).rejects.toBeInstanceOf(LicenseRefusedError)
    expect(speakText).not.toHaveBeenCalled()
    expect(getConnection).not.toHaveBeenCalled()
  })

  it('live speech reports no stream, so the caller falls back and is refused there', async () => {
    const getConnection = vi.fn()

    Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: { getConnection } })

    await expect(startSpeechStream({ source: 'voice-conversation' })).resolves.toBeNull()
    expect(getConnection).not.toHaveBeenCalled()
  })
})
