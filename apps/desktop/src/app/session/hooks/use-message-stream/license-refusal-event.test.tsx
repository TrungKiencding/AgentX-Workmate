import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import type { DesktopLicense } from '@/global'
import { createClientSessionState } from '@/lib/chat-runtime'
import { setTimeFormatLocale } from '@/lib/time'
import { $license, $licenseReadOnly } from '@/store/license'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

// A turn the AgentX license refused arrives as a terminal error frame with
// `failure_reason: "license_read_only"` and the license itself. The bubble must
// say it in the app's own words — not the backend's text — and every composer
// must lock at once rather than at the next license check.

const SID = 'session-1'

let handleEvent: ((event: RpcEvent) => void) | null = null
let sessionStates: Map<string, ClientSessionState>

const EXPIRED: DesktopLicense = {
  access: 'read_only',
  contact: 'it@astralx.com.vn',
  enforced: true,
  last_day: '2026-12-31',
  notice: 'read_only',
  plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
  state: 'expired'
}

function Harness() {
  const activeSessionIdRef = useRef<string | null>(SID)
  const sessionStateByRuntimeIdRef = useRef(new Map<string, ClientSessionState>())
  const queryClientRef = useRef(new QueryClient())

  const stream = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession: vi.fn(async () => undefined),
    queryClient: queryClientRef.current,
    refreshHermesConfig: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    sessionStateByRuntimeIdRef,
    updateSessionState: (sessionId, updater) => {
      const current = sessionStateByRuntimeIdRef.current.get(sessionId) ?? createClientSessionState()
      const next = updater(current)
      sessionStateByRuntimeIdRef.current.set(sessionId, next)
      sessionStates.set(sessionId, next)

      return next
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent
  }, [stream.handleGatewayEvent])

  return null
}

const original = window.agentxDesktop

function lastAssistant() {
  const state = sessionStates.get(SID) ?? createClientSessionState()

  return [...state.messages].reverse().find(m => m.role === 'assistant' && !m.hidden)
}

async function refuse(payload: Record<string, unknown>) {
  sessionStates = new Map()
  render(<Harness />)
  await waitFor(() => expect(handleEvent).not.toBeNull())
  await act(() => handleEvent!({ payload: {}, session_id: SID, type: 'message.start' }))
  await act(() =>
    handleEvent!({
      payload: { recoverable: true, status: 'error', ...payload },
      session_id: SID,
      type: 'message.complete'
    })
  )
}

describe('a turn refused by the AgentX license', () => {
  const get = vi.fn()

  beforeEach(() => {
    handleEvent = null
    setTimeFormatLocale('en')
    $license.set({ account: null, available: true, checking: false, lastCheck: null, license: null, loaded: true })
    get.mockReset()
    get.mockResolvedValue({ account: 'kien', detail: '', license: EXPIRED, status: 'cached' })
    Object.defineProperty(window, 'agentxDesktop', {
      configurable: true,
      value: { license: { get, onChanged: () => () => undefined, refresh: vi.fn() } }
    })
  })

  afterEach(() => {
    cleanup()
    setTimeFormatLocale(undefined)
    Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
  })

  it('explains the refusal in the app’s words and locks the composer', async () => {
    await refuse({
      error: 'Gói Pilot 2026 đã hết hạn ngày 31/12/2026. Workmate đang ở chế độ chỉ xem.',
      failure_reason: 'license_read_only',
      license: EXPIRED,
      text: 'Gói Pilot 2026 đã hết hạn ngày 31/12/2026. Workmate đang ở chế độ chỉ xem.'
    })

    expect(lastAssistant()?.error).toBe(
      'Your Pilot 2026 plan expired on Dec 31, 2026. Workmate is in read-only mode. ' +
        'Contact it@astralx.com.vn to get a license or renew it.'
    )
    expect($licenseReadOnly.get()).toBe(true)
    // …and asks the main process, which tells every other window.
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  })

  it('keeps the backend sentence when the license that came with it is unreadable', async () => {
    await refuse({
      error: 'Your AgentX license does not cover AI right now.',
      failure_reason: 'license_read_only',
      license: 'garbled',
      text: 'Your AgentX license does not cover AI right now.'
    })

    expect(lastAssistant()?.error).toBe('Your AgentX license does not cover AI right now.')
    await waitFor(() => expect($licenseReadOnly.get()).toBe(true))
  })

  it('leaves every other failure alone', async () => {
    await refuse({ error: 'HTTP 401: invalid api key', text: 'HTTP 401: invalid api key' })

    expect(lastAssistant()?.error).toBe('HTTP 401: invalid api key')
    expect($licenseReadOnly.get()).toBe(false)
    expect(get).not.toHaveBeenCalled()
  })
})
