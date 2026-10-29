import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $keycloakAccount } from '@/store/account'
import { $gatewayState } from '@/store/session'

import { useKeycloakAccount } from './use-keycloak-account'

const initial = $keycloakAccount.get()
const status = vi.fn()

beforeEach(() => {
  status.mockReset()
  vi.stubGlobal('agentxDesktop', { keycloak: { status } })
  $keycloakAccount.set(initial)
  $gatewayState.set('idle')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  $keycloakAccount.set(initial)
  $gatewayState.set('idle')
})

// At launch the main process may not know the realm yet; the name has to
// appear once the backend is up, without anyone opening Settings.
describe('useKeycloakAccount', () => {
  it('re-reads the sign-in once the gateway opens, so the name shows on its own', async () => {
    status.mockResolvedValueOnce({ configured: false, signedIn: false })
    status.mockResolvedValueOnce({ configured: true, displayName: 'Lê Trung Kiên', signedIn: true })

    const { result } = renderHook(() => useKeycloakAccount())

    await act(async () => {})
    expect(result.current.signedIn).toBe(false)

    await act(async () => {
      $gatewayState.set('open')
    })

    expect(status).toHaveBeenCalledTimes(2)
    expect(result.current.displayName).toBe('Lê Trung Kiên')
  })

  it('stops re-reading once someone is signed in', async () => {
    status.mockResolvedValue({ configured: true, displayName: 'An', signedIn: true })

    renderHook(() => useKeycloakAccount())

    // The launch read settles first: someone is already signed in.
    await act(async () => {})
    await act(async () => {
      $gatewayState.set('open')
    })
    await act(async () => {
      $gatewayState.set('connecting')
    })
    await act(async () => {
      $gatewayState.set('open')
    })

    expect(status).toHaveBeenCalledTimes(1)
  })
})
