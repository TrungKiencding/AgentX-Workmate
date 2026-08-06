import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $keycloakAccount, refreshKeycloakAccount } from './account'

// The account store answers "who is signed in" from the locally stored session,
// so it must resolve with no network and never leave the caller holding a
// half-populated shape.

const original = window.agentxDesktop

function stubDesktop(value: Record<string, unknown> | undefined) {
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value })
}

beforeEach(() => {
  $keycloakAccount.set({
    available: false,
    clientId: '',
    configured: false,
    displayName: '',
    email: '',
    issuer: '',
    loaded: false,
    signedIn: false,
    userId: ''
  })
})

afterEach(() => {
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
})

describe('refreshKeycloakAccount', () => {
  it('publishes the identity the bridge reports', async () => {
    stubDesktop({
      keycloak: {
        status: async () => ({
          clientId: 'agentx-workmate',
          configured: true,
          displayName: 'Le Trung Kien',
          email: 'kienlt1@astralx.com.vn',
          issuer: 'https://sso.example.com/realms/agent-hub',
          signedIn: true,
          userId: 'kc-sub-1'
        })
      }
    })

    const state = await refreshKeycloakAccount()

    expect(state.displayName).toBe('Le Trung Kien')
    expect(state.email).toBe('kienlt1@astralx.com.vn')
    expect(state.signedIn).toBe(true)
    expect(state.available).toBe(true)
    expect(state.loaded).toBe(true)
    expect($keycloakAccount.get()).toEqual(state)
  })

  it('reports not-configured when the bridge is absent', async () => {
    // An ungated install has no keycloak bridge at all — the panel must show
    // "no account here", not a spinner forever.
    stubDesktop({})

    const state = await refreshKeycloakAccount()

    expect(state.available).toBe(false)
    expect(state.configured).toBe(false)
    expect(state.loaded).toBe(true)
  })

  it('survives a throwing bridge without leaving loaded false', async () => {
    stubDesktop({
      keycloak: {
        status: async () => {
          throw new Error('main process is unhappy')
        }
      }
    })

    const state = await refreshKeycloakAccount()

    expect(state.loaded).toBe(true)
    expect(state.configured).toBe(false)
  })

  it('fills the gaps when the bridge answers with a partial status', async () => {
    // A session stored before the app carried identity claims has no
    // email/displayName; the store must still hand back a complete shape.
    stubDesktop({ keycloak: { status: async () => ({ configured: true, signedIn: true, userId: 'kc-sub-1' }) } })

    const state = await refreshKeycloakAccount()

    expect(state.email).toBe('')
    expect(state.displayName).toBe('')
    expect(state.userId).toBe('kc-sub-1')
  })
})
