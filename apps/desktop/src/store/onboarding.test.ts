import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopAccountLiteLlm, DesktopAccountProvisionResult } from '@/global'
import * as notifications from '@/store/notifications'
import type { OAuthProvider } from '@/types/hermes'

import {
  $desktopOnboarding,
  advanceFromModelConfirm,
  cancelOnboardingFlow,
  completeBrowserStep,
  connectAgentxGateway,
  type DesktopOnboardingState,
  type OnboardingContext,
  refreshOnboarding,
  requestDesktopOnboarding,
  saveOnboardingLocalEndpoint,
  submitOnboardingCode
} from './onboarding'

function provider(id: string, name = id): OAuthProvider {
  return {
    cli_command: `agentx login ${id}`,
    docs_url: `https://example.com/${id}`,
    flow: 'pkce',
    id,
    name,
    status: { logged_in: false }
  }
}

function baseState(overrides: Partial<DesktopOnboardingState> = {}): DesktopOnboardingState {
  return {
    configured: false,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false,
    ...overrides
  }
}

function installApiMock(api: (request: { path: string }) => Promise<unknown>) {
  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    value: { api }
  })
}

function emptyOpenRouterGateway(): OnboardingContext['requestGateway'] {
  return async method => {
    if (method === 'setup.status') {
      return { provider_configured: true } as never
    }

    if (method === 'setup.runtime_check') {
      return { error: 'No usable credentials found for openrouter.', ok: false, provider: 'openrouter' } as never
    }

    throw new Error(`unexpected gateway method: ${method}`)
  }
}

function keylessCustomGateway(): OnboardingContext['requestGateway'] {
  return async method => {
    if (method === 'setup.status') {
      return { provider_configured: true } as never
    }

    if (method === 'setup.runtime_check') {
      return { ok: true, provider: 'custom' } as never
    }

    throw new Error(`unexpected gateway method: ${method}`)
  }
}

function onboardingContext(requestGateway: OnboardingContext['requestGateway']): OnboardingContext {
  return { requestGateway }
}

function fallbackTimeoutGateway(): OnboardingContext['requestGateway'] {
  return async method => {
    if (method === 'setup.status' || method === 'setup.runtime_check') {
      throw new Error(`request timed out: ${method}`)
    }

    throw new Error(`unexpected gateway method: ${method}`)
  }
}

describe('refreshOnboarding', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  it('refreshes OAuth providers again when onboarding was explicitly requested', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [provider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ providers: [provider('cached')] }))
    requestDesktopOnboarding('Need provider setup')

    const ready = await refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    expect(ready).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
    expect($desktopOnboarding.get().providers?.map(p => p.id)).toEqual(['fresh'])
    expect($desktopOnboarding.get().reason).toContain('No usable credentials found for openrouter.')
    expect($desktopOnboarding.get().reason).toContain('setup.status reports configured credentials')
  })

  it('keeps cached providers when onboarding was not re-requested', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [provider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ providers: [provider('cached')] }))

    const ready = await refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    expect(ready).toBe(false)
    expect(api).not.toHaveBeenCalled()
    expect($desktopOnboarding.get().providers?.map(p => p.id)).toEqual(['cached'])
  })

  it('does not downgrade configured=true on fallback-only readiness failures', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [provider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    // Simulate a returning user: cache is set and store is configured.
    window.localStorage.setItem('agentx-desktop-onboarded-v1', '1')
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [provider('cached')],
        reason: null,
        requested: false
      })
    )

    const ready = await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(ready).toBe(false)
    expect(api).not.toHaveBeenCalled()
    expect($desktopOnboarding.get().configured).toBe(true)
    expect($desktopOnboarding.get().reason).toBeNull()
    // The cache must survive the refresh — proving we didn't downgrade.
    expect(window.localStorage.getItem('agentx-desktop-onboarded-v1')).toBe('1')
  })

  it('shows a non-blocking notification when preserving configured on fallback', async () => {
    const notifySpy = vi.spyOn(notifications, 'notify')

    installApiMock(vi.fn())
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [provider('cached')],
        reason: null,
        requested: false
      })
    )

    await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'runtime-not-ready',
        kind: 'error'
      })
    )
    expect($desktopOnboarding.get().configured).toBe(true)
  })

  it('enters setup when the selected OpenRouter credential is genuinely empty', async () => {
    installApiMock(vi.fn())
    window.localStorage.setItem('agentx-desktop-onboarded-v1', '1')
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [provider('cached')],
        reason: null,
        requested: false
      })
    )

    const ready = await refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    expect(ready).toBe(false)
    expect($desktopOnboarding.get().configured).toBe(false)
    expect($desktopOnboarding.get().reason).toContain('No usable credentials found for openrouter.')
    expect(window.localStorage.getItem('agentx-desktop-onboarded-v1')).toBeNull()
  })

  it('keeps a keyless custom runtime out of setup', async () => {
    const api = vi.fn()

    installApiMock(api)
    $desktopOnboarding.set(baseState({ configured: false, reason: 'stale setup error', requested: true }))

    const ready = await refreshOnboarding(onboardingContext(keylessCustomGateway()))

    expect(ready).toBe(true)
    expect(api).not.toHaveBeenCalled()
    expect($desktopOnboarding.get()).toMatchObject({
      configured: true,
      reason: null,
      requested: false
    })
  })

  it('does not preserve configured when onboarding was explicitly requested', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [provider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [provider('cached')],
        reason: null,
        requested: true
      })
    )

    const ready = await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(ready).toBe(false)
    // requested overrides preservation — should downgrade.
    expect($desktopOnboarding.get().configured).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('still surfaces onboarding when fallback failure happens before configured state', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [provider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ configured: false, providers: null, requested: true }))

    const ready = await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(ready).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
    expect($desktopOnboarding.get().configured).toBe(false)
    expect($desktopOnboarding.get().reason).toContain('request timed out')
  })

  it('deduplicates concurrent provider refresh calls', async () => {
    let resolveProviders!: (value: { providers: OAuthProvider[] }) => void

    const providersPromise = new Promise<{ providers: OAuthProvider[] }>(resolve => {
      resolveProviders = value => {
        resolve(value)
      }
    })

    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return providersPromise
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ requested: true }))

    const first = refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))
    const second = refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1))

    resolveProviders({ providers: [provider('shared')] })
    await Promise.all([first, second])

    expect($desktopOnboarding.get().providers?.map(p => p.id)).toEqual(['shared'])
  })
})

describe('OAuth onboarding', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  it('clears stale readiness errors after OAuth succeeds and model confirmation is shown', async () => {
    const model = 'anthropic/claude-opus-4.8'
    const calls: { body?: unknown; path: string }[] = []

    installApiMock(async ({ body, path }: { body?: unknown; path: string }) => {
      calls.push({ body, path })

      if (path === '/api/providers/oauth/nous/submit') {
        return { ok: true, status: 'approved' }
      }

      if (path.startsWith('/api/model/options')) {
        return {
          providers: [
            {
              name: 'Nous Portal',
              slug: 'nous',
              models: [model]
            }
          ]
        }
      }

      if (path.startsWith('/api/model/recommended-default?')) {
        return { provider: 'nous', model, free_tier: false }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'nous', model, gateway_tools: [] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const requestGateway: OnboardingContext['requestGateway'] = async (method, params) => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: true } as never
      }

      if (method === 'setup.runtime_check') {
        expect(params).toEqual({ provider: 'nous' })

        return { ok: true } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }

    $desktopOnboarding.set(
      baseState({
        flow: {
          status: 'awaiting_user',
          provider: provider('nous', 'Nous Portal'),
          start: {
            auth_url: 'https://portal.example/auth',
            expires_in: 600,
            flow: 'pkce',
            session_id: 'portal-session'
          },
          code: 'fresh-code'
        },
        reason:
          'No access token found for Nous Portal login. setup.status reports configured credentials, but runtime resolution still failed.',
        requested: true
      })
    )

    await submitOnboardingCode(onboardingContext(requestGateway))

    const state = $desktopOnboarding.get()
    expect(state.reason).toBeNull()
    expect(state.flow.status).toBe('confirming_model')

    if (state.flow.status === 'confirming_model') {
      expect(state.flow.label).toBe('Nous Portal')
      expect(state.flow.currentModel).toBe(model)
    }

    expect(calls.some(c => c.path === '/api/model/set')).toBe(true)

    const optionsIndex = calls.findIndex(c => c.path.startsWith('/api/model/options'))
    const recommendedIndex = calls.findIndex(c => c.path.startsWith('/api/model/recommended-default'))
    const setIndex = calls.findIndex(c => c.path === '/api/model/set')

    expect(optionsIndex).toBeGreaterThanOrEqual(0)
    expect(recommendedIndex).toBeGreaterThan(optionsIndex)
    expect(setIndex).toBeGreaterThan(recommendedIndex)
  })

  it('does not advance when the default model assignment is not persisted', async () => {
    const model = 'openai/gpt-5.5-pro'
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth/nous/submit') {
        return { ok: true, status: 'approved' }
      }

      if (path.startsWith('/api/model/options')) {
        return { providers: [{ name: 'Nous Portal', slug: 'nous', models: [model] }] }
      }

      if (path.startsWith('/api/model/recommended-default?')) {
        return { provider: 'nous', model, free_tier: false }
      }

      if (path === '/api/model/set') {
        return {
          ok: false,
          provider: 'nous',
          model,
          confirm_required: true,
          confirm_message: 'Confirm this expensive model.'
        }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const requestGatewayMock = vi.fn(async (method: string) => {
      if (method === 'reload.env') {
        return {}
      }

      throw new Error(`unexpected gateway method: ${method}`)
    })

    const requestGateway = requestGatewayMock as OnboardingContext['requestGateway']
    $desktopOnboarding.set(
      baseState({
        flow: {
          status: 'awaiting_user',
          provider: provider('nous', 'Nous Portal'),
          start: {
            auth_url: 'https://portal.example/auth',
            expires_in: 600,
            flow: 'pkce',
            session_id: 'portal-session'
          },
          code: 'fresh-code'
        },
        requested: true
      })
    )

    await submitOnboardingCode(onboardingContext(requestGateway))

    const state = $desktopOnboarding.get()
    expect(state.flow.status).toBe('error')
    expect(state.flow.status === 'error' ? state.flow.message : '').toContain('Confirm this expensive model.')
    expect(requestGatewayMock).not.toHaveBeenCalledWith('setup.runtime_check', expect.anything())
  })
})

describe('saveOnboardingLocalEndpoint', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  function readyGateway(): OnboardingContext['requestGateway'] {
    return async method => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: true } as never
      }

      if (method === 'setup.runtime_check') {
        return { ok: true } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }
  }

  it('errors when the endpoint advertises no models (nothing to route to)', async () => {
    const calls: string[] = []
    installApiMock(async ({ path }: { path: string }) => {
      calls.push(path)

      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: [] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:8000/v1', '', {
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('no models')
    // Must not attempt to persist an assignment without a model.
    expect(calls).not.toContain('/api/model/set')
  })

  it('auto-discovers the model and persists provider=custom + base_url, then finishes', async () => {
    const calls: { body?: unknown; path: string }[] = []

    const api = vi.fn(async ({ body, path }: { body?: unknown; path: string }) => {
      calls.push({ body, path })

      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: ['llama-3.1-8b', 'qwen2.5-7b'] }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'custom', model: 'llama-3.1-8b', base_url: 'http://127.0.0.1:8000/v1' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    const onCompleted = vi.fn()

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:8000/v1', '', {
      onCompleted,
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(true)

    const assign = calls.find(c => c.path === '/api/model/set')
    expect(assign?.body).toMatchObject({
      scope: 'main',
      provider: 'custom',
      model: 'llama-3.1-8b',
      base_url: 'http://127.0.0.1:8000/v1'
    })

    expect(onCompleted).toHaveBeenCalledTimes(1)
    expect($desktopOnboarding.get().configured).toBe(true)
  })

  it('forwards the API key to the probe and persists it for auth-gated endpoints', async () => {
    const calls: { body?: unknown; path: string }[] = []

    const api = vi.fn(async ({ body, path }: { body?: unknown; path: string }) => {
      calls.push({ body, path })

      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: ['gpt-oss-120b'] }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'custom', model: 'gpt-oss-120b', base_url: 'https://text.example.com/v1' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)

    const result = await saveOnboardingLocalEndpoint('https://text.example.com/v1', 'sk-secret', {
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(true)

    // The probe must receive the key so an auth-gated /v1/models enumerates.
    const probe = calls.find(c => c.path === '/api/providers/validate')
    expect(probe?.body).toMatchObject({
      key: 'OPENAI_BASE_URL',
      value: 'https://text.example.com/v1',
      api_key: 'sk-secret'
    })

    // And the key must be persisted alongside the endpoint for runtime auth.
    const assign = calls.find(c => c.path === '/api/model/set')
    expect(assign?.body).toMatchObject({
      scope: 'main',
      provider: 'custom',
      model: 'gpt-oss-120b',
      base_url: 'https://text.example.com/v1',
      api_key: 'sk-secret'
    })
  })

  it('reports the runtime reason when resolution still fails after saving', async () => {
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: ['llama-3.1-8b'] }
      }

      if (path === '/api/model/set') {
        return { ok: true }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const failingGateway: OnboardingContext['requestGateway'] = async method => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: false } as never
      }

      if (method === 'setup.runtime_check') {
        return { ok: false, error: 'No provider can serve the selected model.' } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:8000/v1', '', {
      requestGateway: failingGateway
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('No provider can serve the selected model.')
    expect($desktopOnboarding.get().configured).not.toBe(true)
  })
})

describe('the browser step after the model card', () => {
  const confirming = (): DesktopOnboardingState =>
    baseState({
      flow: { status: 'confirming_model', providerSlug: 'nous', currentModel: 'm', label: 'Nous', saving: false }
    })

  function installWebmateBridge(overrides: Record<string, unknown> = {}) {
    const setPrefs = vi.fn(async (patch: Record<string, unknown>) => ({ ...patch }))

    Object.defineProperty(window, 'agentxDesktop', {
      configurable: true,
      value: {
        api: vi.fn(async () => ({})),
        webmate: {
          status: vi.fn(async () => ({ connected: false, installType: null, prefs: { prompt: null } })),
          getPrefs: vi.fn(async () => ({ prompt: null })),
          setPrefs,
          scan: vi.fn(async () => []),
          ...overrides
        }
      }
    })

    return { setPrefs }
  }

  it('moves to connecting_browser when the desktop can offer it', async () => {
    installWebmateBridge()
    $desktopOnboarding.set(confirming())

    expect(await advanceFromModelConfirm()).toBe('browser')
    expect($desktopOnboarding.get().flow.status).toBe('connecting_browser')
  })

  it('finishes straight away without a desktop bridge, after "never", when already connected, or in manual mode', async () => {
    Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: undefined })
    $desktopOnboarding.set(confirming())
    expect(await advanceFromModelConfirm()).toBe('done')
    expect($desktopOnboarding.get().flow).toMatchObject({ status: 'confirming_model', saving: false })

    installWebmateBridge({ getPrefs: vi.fn(async () => ({ prompt: 'never' })) })
    $desktopOnboarding.set(confirming())
    expect(await advanceFromModelConfirm()).toBe('done')

    installWebmateBridge({ status: vi.fn(async () => ({ connected: true, installType: 'workmate', prefs: { prompt: null } })) })
    $desktopOnboarding.set(confirming())
    expect(await advanceFromModelConfirm()).toBe('done')

    installWebmateBridge()
    $desktopOnboarding.set({ ...confirming(), manual: true })
    expect(await advanceFromModelConfirm()).toBe('done')
  })

  it('completeBrowserStep records the choice and completes onboarding', () => {
    const { setPrefs } = installWebmateBridge()
    const onCompleted = vi.fn()
    const ctx: OnboardingContext = { requestGateway: async () => undefined as never, onCompleted }

    $desktopOnboarding.set(baseState({ flow: { status: 'connecting_browser' } }))
    completeBrowserStep(ctx, 'later')
    expect(setPrefs).toHaveBeenLastCalledWith({ prompt: 'later' })
    expect($desktopOnboarding.get().configured).toBe(true)
    expect(onCompleted).toHaveBeenCalledTimes(1)

    $desktopOnboarding.set(baseState({ flow: { status: 'connecting_browser' } }))
    completeBrowserStep(ctx, 'connected')
    expect(setPrefs).toHaveBeenLastCalledWith({ prompt: null, mode: 'browser' })

    // Not on this step → no-op.
    $desktopOnboarding.set(confirming())
    completeBrowserStep(ctx, 'never')
    expect(onCompleted).toHaveBeenCalledTimes(2)
  })
})

describe('AgentX AI Gateway onboarding', () => {
  const grantedKey = (patch: Partial<DesktopAccountLiteLlm> = {}): DesktopAccountLiteLlm => ({
    base_url: 'https://gateway.example',
    detail: 'the key already on this account is still valid.',
    key_alias: 'second-brain-someone',
    masked_key: 'sk-…abcd',
    // Chat-first, the order the service grants in.
    models: ['Qwen/Qwen3.6-35B', 'MiniMax/MiniMax-M3'],
    ok: true,
    provider: 'litellm',
    status: 'reused',
    ...patch
  })

  function installGatewayBridge(
    provision: () => Promise<DesktopAccountProvisionResult>,
    api: (request: { body?: unknown; path: string }) => Promise<unknown> = async ({ path }) => {
      throw new Error(`unexpected api path: ${path}`)
    }
  ) {
    const provisionMock = vi.fn(provision)

    Object.defineProperty(window, 'agentxDesktop', {
      configurable: true,
      value: { account: { provision: provisionMock, status: vi.fn() }, api }
    })

    return provisionMock
  }

  function gatewayReadyRuntime(): OnboardingContext['requestGateway'] {
    return async (method, params) => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: true } as never
      }

      if (method === 'setup.runtime_check') {
        // The bare `providers:` key — what model.provider holds once assigned.
        expect(params).toEqual({ provider: 'litellm' })

        return { ok: true } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }
  }

  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: undefined })
    vi.restoreAllMocks()
  })

  it('moves the main model onto the gateway key and shows the model card', async () => {
    const calls: { body?: unknown; path: string }[] = []

    const provision = installGatewayBridge(
      async () => ({ ok: true, litellm: grantedKey() }),
      async ({ body, path }) => {
        calls.push({ body, path })

        if (path.startsWith('/api/model/options')) {
          // The person was on another provider, and the gateway row lists its
          // models in another order: the key's chat-first order decides.
          return {
            provider: 'nous',
            model: 'Hermes-4-405B',
            providers: [
              { name: 'Nous Portal', slug: 'nous', models: ['Hermes-4-405B'] },
              { name: 'AgentX AI Gateway', slug: 'litellm', models: ['MiniMax/MiniMax-M3', 'Qwen/Qwen3.6-35B'] }
            ]
          }
        }

        if (path === '/api/model/set') {
          return { ok: true, provider: 'litellm', model: 'Qwen/Qwen3.6-35B' }
        }

        throw new Error(`unexpected api path: ${path}`)
      }
    )

    await connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))

    // No `rotate`: picking the card must never retire the key another of this
    // person's machines holds.
    expect(provision).toHaveBeenCalledWith()
    expect(calls.find(c => c.path === '/api/model/set')?.body).toMatchObject({
      scope: 'main',
      provider: 'litellm',
      model: 'Qwen/Qwen3.6-35B'
    })
    expect(calls.some(c => c.path.startsWith('/api/model/recommended-default'))).toBe(false)
    expect($desktopOnboarding.get().flow).toMatchObject({
      status: 'confirming_model',
      label: 'AgentX AI Gateway',
      providerSlug: 'litellm',
      currentModel: 'Qwen/Qwen3.6-35B'
    })
  })

  it('keeps a main model the account already runs on the gateway', async () => {
    const calls: { body?: unknown; path: string }[] = []

    installGatewayBridge(
      async () => ({ ok: true, litellm: grantedKey() }),
      async ({ body, path }) => {
        calls.push({ body, path })

        if (path.startsWith('/api/model/options')) {
          return {
            provider: 'litellm',
            model: 'MiniMax/MiniMax-M3',
            providers: [
              { name: 'AgentX AI Gateway', slug: 'litellm', models: ['Qwen/Qwen3.6-35B', 'MiniMax/MiniMax-M3'] }
            ]
          }
        }

        if (path === '/api/model/set') {
          return { ok: true, provider: 'litellm', model: 'MiniMax/MiniMax-M3' }
        }

        throw new Error(`unexpected api path: ${path}`)
      }
    )

    await connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))

    expect(calls.find(c => c.path === '/api/model/set')?.body).toMatchObject({ model: 'MiniMax/MiniMax-M3' })
    expect($desktopOnboarding.get().flow).toMatchObject({
      status: 'confirming_model',
      currentModel: 'MiniMax/MiniMax-M3'
    })
  })

  it('never lands on another provider when the gateway row is missing', async () => {
    const calls: string[] = []

    installGatewayBridge(
      async () => ({ ok: true, litellm: grantedKey() }),
      async ({ path }) => {
        calls.push(path)

        if (path.startsWith('/api/model/options')) {
          return { providers: [{ name: 'Nous Portal', slug: 'nous', models: ['Hermes-4-405B'] }] }
        }

        throw new Error(`unexpected api path: ${path}`)
      }
    )

    const requestGateway: OnboardingContext['requestGateway'] = async method => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: true } as never
      }

      if (method === 'setup.runtime_check') {
        return { ok: false, error: 'No usable credentials found for nous.' } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }

    await connectAgentxGateway(onboardingContext(requestGateway))

    expect(calls).not.toContain('/api/model/set')

    const { flow } = $desktopOnboarding.get()
    expect(flow.status).toBe('error')
    expect(flow.status === 'error' ? flow.message : '').toContain('No usable credentials found for nous.')
  })

  it.each([
    ['offline', 'Could not reach AgentX AI Gateway'],
    ['unconfigured', 'not set up on this install'],
    ['disabled', 'not set up on this install'],
    ['revoked', 'This device has been revoked'],
    ['error', 'could not issue a model key: the service rejected the sign-in']
  ])('explains a %s key and leaves the model alone', async (status, sentence) => {
    const api = vi.fn(async () => ({}))

    installGatewayBridge(
      async () => ({
        ok: false,
        litellm: grantedKey({ detail: 'the service rejected the sign-in', models: [], ok: false, status })
      }),
      api
    )

    await connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))

    expect(api).not.toHaveBeenCalled()

    const { flow } = $desktopOnboarding.get()
    expect(flow.status).toBe('error')
    expect(flow.status === 'error' ? flow.message : '').toContain(sentence)
  })

  it('asks the person to check their sign-in when the desktop gets no answer', async () => {
    installGatewayBridge(async () => ({ ok: false, error: 'Sign in first — there is no account to provision.' }))

    await connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))

    const { flow } = $desktopOnboarding.get()
    expect(flow.status).toBe('error')
    expect(flow.status === 'error' ? flow.message : '').toContain('signed in to AgentX')
  })

  it('leaves a cancelled flow alone when the key arrives late', async () => {
    let deliver!: (result: DesktopAccountProvisionResult) => void
    const api = vi.fn(async () => ({}))

    installGatewayBridge(
      () =>
        new Promise(resolve => {
          deliver = resolve
        }),
      api
    )

    const pending = connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))

    expect($desktopOnboarding.get().flow.status).toBe('connecting_gateway')

    cancelOnboardingFlow()
    deliver({ ok: true, litellm: grantedKey() })
    await pending

    expect($desktopOnboarding.get().flow.status).toBe('idle')
    expect(api).not.toHaveBeenCalled()
  })

  it('keeps the picker, not the key form, when only the gateway is on offer', async () => {
    installGatewayBridge(
      async () => ({ ok: false }),
      async ({ path }) => {
        if (path === '/api/providers/oauth') {
          return { providers: [] }
        }

        throw new Error(`unexpected api path: ${path}`)
      }
    )

    $desktopOnboarding.set(baseState({ requested: true }))

    await refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    expect($desktopOnboarding.get()).toMatchObject({ mode: 'oauth', providers: [] })
  })
})
