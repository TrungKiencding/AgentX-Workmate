import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopAccountLiteLlm, DesktopAccountProvisionResult } from '@/global'
import { en } from '@/i18n/en'
import { $agentxKeyGate, OPEN_AGENTX_KEY_GATE } from '@/store/agentx-key'

import {
  $desktopOnboarding,
  advanceFromModelConfirm,
  cancelOnboardingFlow,
  completeBrowserStep,
  connectAgentxGateway,
  type DesktopOnboardingState,
  dismissFirstRunOnboarding,
  type OnboardingContext,
  refreshOnboarding,
  setOnboardingModel
} from './onboarding'

function baseState(overrides: Partial<DesktopOnboardingState> = {}): DesktopOnboardingState {
  return {
    configured: false,
    flow: { status: 'idle' },
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    ...overrides
  }
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

function onboardingContext(requestGateway: OnboardingContext['requestGateway']): OnboardingContext {
  return { requestGateway }
}

describe('the browser step after the model card', () => {
  const confirming = (): DesktopOnboardingState =>
    baseState({
      flow: {
        status: 'confirming_model',
        providerSlug: 'litellm',
        currentModel: 'm',
        label: 'AgentX AI Gateway',
        saving: false
      }
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

    installWebmateBridge({
      status: vi.fn(async () => ({ connected: true, installType: 'workmate', prefs: { prompt: null } }))
    })
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
    key_alias: 'agentx-someone',
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
    ['offline', en.agentxKey.reasons.offline],
    ['revoked', en.agentxKey.reasons.revoked],
    ['error', en.agentxKey.reasons.failed]
  ])('explains a %s key, says whom to contact, and leaves the model alone', async (status, sentence) => {
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
    expect(flow.status === 'error' ? flow.message : '').toBe(`${sentence} ${en.agentxKey.contactSupport}`)
    // The operator prose stays out of the sentence and goes to support as details.
    expect(flow.status === 'error' ? flow.gateway?.failure : null).toMatchObject({
      detail: 'the service rejected the sign-in',
      status
    })
  })

  it('turns the HTTP 424 from the SSO console into a reason and a support contact', async () => {
    const detail =
      'the keys service could not issue a key: the keys service returned HTTP 424: None of the models chosen in the SSO console is served by the model proxy right now.'

    installGatewayBridge(async () => ({
      ok: false,
      litellm: grantedKey({ code: 'no_grantable_models', detail, models: [], ok: false, status: 'error' })
    }))

    await connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))

    const { flow } = $desktopOnboarding.get()
    expect(flow.status === 'error' ? flow.message : '').toBe(
      `${en.agentxKey.reasons.noModels} ${en.agentxKey.contactSupport}`
    )
    expect(flow.status === 'error' ? flow.gateway?.failure : null).toMatchObject({
      code: 'no_grantable_models',
      detail,
      status: 'error'
    })
  })

  it.each(['unconfigured', 'disabled'])('keeps gateway failures recoverable when the service is %s', async status => {
    installGatewayBridge(async () => ({
      ok: false,
      litellm: grantedKey({ detail: 'accounts.keys.base_url is not set.', models: [], ok: false, status })
    }))

    await connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))

    const { flow } = $desktopOnboarding.get()
    expect(flow.status === 'error' ? flow.message : '').toContain('not set up on this install')
    expect(flow.status === 'error' ? flow.gateway?.failure?.status : '').toBe(status)
  })

  it('explains a key refused for the AgentX license the way the license is said everywhere', async () => {
    const api = vi.fn(async () => ({}))

    installGatewayBridge(
      async () => ({
        ok: false,
        litellm: grantedKey({
          code: 'license_revoked',
          detail: "this account's AgentX license does not cover AI right now (HTTP 403)",
          license: {
            access: 'read_only',
            contact: 'it@astralx.com.vn',
            enforced: true,
            notice: 'read_only',
            plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
            state: 'revoked'
          },
          models: [],
          ok: false,
          status: 'license_inactive'
        })
      }),
      api
    )

    await connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))

    expect(api).not.toHaveBeenCalled()

    const { flow } = $desktopOnboarding.get()
    expect(flow.status).toBe('error')
    // Never the operator prose in `detail`.
    expect(flow.status === 'error' ? flow.message : '').toBe(
      'Your AgentX license has been revoked. Workmate is in read-only mode. ' +
        'Contact it@astralx.com.vn to get a license or renew it.'
    )
  })

  it('says the license does not cover AI when the refusal carries no license to name', async () => {
    installGatewayBridge(async () => ({
      ok: false,
      litellm: grantedKey({ detail: 'HTTP 403', models: [], ok: false, status: 'license_inactive' })
    }))

    await connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))

    const { flow } = $desktopOnboarding.get()
    // No license to name a contact: whom to ask comes from the key gate's line.
    expect(flow.status === 'error' ? flow.message : '').toBe(
      `Your AgentX license doesn't cover AI right now. Workmate is in read-only mode. ${en.agentxKey.contactSupport}`
    )
  })

  it('asks the person to check their connection when the desktop gets no answer', async () => {
    installGatewayBridge(async () => ({ ok: false, error: 'Sign in first — there is no account to provision.' }))

    await connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))

    const { flow } = $desktopOnboarding.get()
    expect(flow.status).toBe('error')
    expect(flow.status === 'error' ? flow.message : '').toBe(
      `${en.agentxKey.reasons.noAnswer} ${en.agentxKey.contactSupport}`
    )
    expect(flow.status === 'error' ? flow.gateway?.failure?.status : '').toBe('no-answer')
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

  it('does not save a model when setup is skipped during catalog loading', async () => {
    let deliver!: (result: unknown) => void

    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path.startsWith('/api/model/options')) {
        return new Promise(resolve => {
          deliver = resolve
        })
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installGatewayBridge(async () => ({ ok: true, litellm: grantedKey() }), api)
    const pending = connectAgentxGateway(onboardingContext(gatewayReadyRuntime()))
    await vi.waitFor(() => expect(deliver).toBeTypeOf('function'))
    dismissFirstRunOnboarding()
    deliver({ providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['m'] }] })
    await pending
    expect(api.mock.calls.some(([request]) => request.path === '/api/model/set')).toBe(false)
    expect($desktopOnboarding.get()).toMatchObject({ firstRunSkipped: true, flow: { status: 'idle' } })
  })

  it('ignores an older key result after a new gateway attempt begins', async () => {
    const deliveries: ((result: DesktopAccountProvisionResult) => void)[] = []
    const api = vi.fn(async () => ({}))
    installGatewayBridge(
      () =>
        new Promise(resolve => {
          deliveries.push(resolve)
        }),
      api
    )
    const ctx = onboardingContext(gatewayReadyRuntime())
    const first = connectAgentxGateway(ctx)
    cancelOnboardingFlow()
    const second = connectAgentxGateway(ctx)
    deliveries[0]({ ok: true, litellm: grantedKey() })
    await first
    expect($desktopOnboarding.get().flow.status).toBe('connecting_gateway')
    expect(api).not.toHaveBeenCalled()
    deliveries[1]({ ok: false, litellm: grantedKey({ ok: false, status: 'offline' }) })
    await second
    expect($desktopOnboarding.get().flow).toMatchObject({
      status: 'error',
      gateway: { failure: { status: 'offline' } }
    })
  })

  it.each([false, true])('does not restore a dismissed model card after a save (failure=%s)', async fail => {
    let resolveSave!: (result: unknown) => void
    let rejectSave!: (error: Error) => void
    installGatewayBridge(
      async () => ({ ok: true }),
      () =>
        new Promise((resolve, reject) => {
          resolveSave = resolve
          rejectSave = reject
        })
    )
    $desktopOnboarding.set(
      baseState({
        flow: {
          status: 'confirming_model',
          providerSlug: 'litellm',
          currentModel: 'm',
          label: 'AgentX AI Gateway',
          saving: false
        }
      })
    )
    const pending = setOnboardingModel('new-model')
    await vi.waitFor(() => expect(resolveSave).toBeTypeOf('function'))
    dismissFirstRunOnboarding()

    if (fail) {
      rejectSave(new Error('offline'))
    } else {
      resolveSave({})
    }

    await pending
    expect($desktopOnboarding.get()).toMatchObject({ firstRunSkipped: true, flow: { status: 'idle' } })
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

    expect($desktopOnboarding.get()).toMatchObject({ configured: false, flow: { status: 'idle' } })
  })
})

describe('skipping gateway setup', () => {
  it('does not mark AI ready, including when the account key is required', () => {
    $agentxKeyGate.set({ ...OPEN_AGENTX_KEY_GATE, required: true })
    $desktopOnboarding.set(baseState())
    dismissFirstRunOnboarding()
    expect($desktopOnboarding.get()).toMatchObject({ configured: false, firstRunSkipped: true })
    expect(window.localStorage.getItem('agentx-desktop-onboarded-v1')).toBeNull()
    $agentxKeyGate.set(OPEN_AGENTX_KEY_GATE)
  })
})
