import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopAgentxKeyGate } from '@/global'
import { en } from '@/i18n/en'
import { $agentxKeyGate, OPEN_AGENTX_KEY_GATE, startAgentxKeyGateSync } from '@/store/agentx-key'

import { AgentxKeyGate } from './agentx-key-gate'

// The gate is what a signed-in person sees while the main process holds the
// boot for their AgentX key. These pin that it never offers a way around the
// key, that it always ends in whom to contact, and that its two actions reach
// the main process.

const REFUSED: DesktopAgentxKeyGate = {
  account: { displayName: 'Lê Trung Kiên', email: 'kien@astralx.com.vn' },
  attempts: 1,
  failure: {
    code: 'no_grantable_models',
    detail:
      'the second brain could not issue a key: the second brain returned HTTP 424: None of the models chosen in the SSO console is served by the model proxy right now.',
    license: null,
    status: 'error'
  },
  phase: 'blocked',
  required: true
}

function stubDesktop(value: Record<string, unknown>) {
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value })
}

afterEach(() => {
  cleanup()
  $agentxKeyGate.set(OPEN_AGENTX_KEY_GATE)
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: undefined })
  vi.restoreAllMocks()
})

describe('AgentxKeyGate', () => {
  it('stays out of the way while the gate is open or not required', () => {
    $agentxKeyGate.set({ ...OPEN_AGENTX_KEY_GATE, required: true })
    const { container, rerender } = render(<AgentxKeyGate />)

    expect(container.innerHTML).toBe('')

    $agentxKeyGate.set({ ...REFUSED, required: false })
    rerender(<AgentxKeyGate />)

    expect(container.innerHTML).toBe('')
  })

  it('says why, whom to contact, and offers no way around the key', () => {
    $agentxKeyGate.set(REFUSED)
    render(<AgentxKeyGate />)

    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByText(en.agentxKey.title)).toBeTruthy()
    expect(screen.getByText(en.agentxKey.reasons.noModels)).toBeTruthy()
    expect(screen.getByText(en.agentxKey.contactSupport)).toBeTruthy()
    expect(screen.getByText(en.agentxKey.account('kien@astralx.com.vn'))).toBeTruthy()

    // Exactly two ways forward: try again, or sign out.
    expect(screen.getByRole('button', { name: en.agentxKey.retry })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.agentxKey.signOut })).toBeTruthy()
    expect(screen.queryByText(en.onboarding.pickDifferentProvider)).toBeNull()
    expect(screen.queryByText(en.onboarding.chooseLater)).toBeNull()
    expect(screen.queryByText(en.onboarding.haveApiKey)).toBeNull()
    expect(screen.queryByRole('button', { name: en.common.close })).toBeNull()
  })

  it('shows progress, not an error, while the first key request is out', () => {
    $agentxKeyGate.set({ ...REFUSED, failure: null, phase: 'provisioning' })
    render(<AgentxKeyGate />)

    expect(screen.getByText(en.agentxKey.provisioning)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: en.agentxKey.retry })).toBeNull()
  })

  it('Try again goes to the main process and shows its answer', async () => {
    const retry = vi.fn(async () => ({ ...REFUSED, attempts: 2, phase: 'open', required: true }))

    stubDesktop({ account: { keyGate: { get: vi.fn(), onChanged: vi.fn(() => () => undefined), retry } } })
    $agentxKeyGate.set(REFUSED)
    render(<AgentxKeyGate />)

    fireEvent.click(screen.getByRole('button', { name: en.agentxKey.retry }))

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('Sign out ends the session and reloads into the sign-in gate', async () => {
    const signOut = vi.fn(async () => ({ ok: true }))
    const resetBootstrap = vi.fn(async () => ({ ok: true }))
    const reload = vi.fn()

    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location)
    stubDesktop({ keycloak: { signOut }, resetBootstrap })
    $agentxKeyGate.set(REFUSED)
    render(<AgentxKeyGate />)

    fireEvent.click(screen.getByRole('button', { name: en.agentxKey.signOut }))

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(resetBootstrap).toHaveBeenCalledTimes(1)
  })
})

describe('startAgentxKeyGateSync', () => {
  it('mirrors the main process, ignoring anything not shaped like a gate', async () => {
    let push: (state: unknown) => void = () => undefined

    stubDesktop({
      account: {
        keyGate: {
          get: vi.fn(async () => REFUSED),
          onChanged: vi.fn(callback => {
            push = callback

            return () => undefined
          }),
          retry: vi.fn()
        }
      }
    })

    const stop = startAgentxKeyGateSync()

    await waitFor(() => expect($agentxKeyGate.get()).toEqual(REFUSED))

    push({ phase: 'bogus', required: true })
    expect($agentxKeyGate.get()).toEqual(REFUSED)

    push({ ...REFUSED, phase: 'open' })
    expect($agentxKeyGate.get().phase).toBe('open')

    stop()
  })

  it('does nothing without the bridge (web dashboard, older shell)', () => {
    expect(() => startAgentxKeyGateSync()()).not.toThrow()
    expect($agentxKeyGate.get()).toEqual(OPEN_AGENTX_KEY_GATE)
  })
})
