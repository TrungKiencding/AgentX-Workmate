import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getGlobalModelOptions } from '@/hermes'
import { $connection } from '@/store/session'

import {
  manualPickRemoved,
  modelOptionsQueryKey,
  replacementModelSelection,
  requestModelOptions
} from './model-options'

const globalOptions = { model: 'hermes-4', provider: 'nous', providers: [] }

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: vi.fn(() => Promise.resolve(globalOptions))
}))

describe('requestModelOptions', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses the connected gateway even before a session exists', async () => {
    const gatewayPayload = { model: 'BeastMode', provider: 'moa', providers: [] }

    const gateway = {
      request: vi.fn(() => Promise.resolve(gatewayPayload))
    }

    await expect(requestModelOptions({ gateway: gateway as never, sessionId: null })).resolves.toEqual(gatewayPayload)

    expect(gateway.request).toHaveBeenCalledWith('model.options', { explicit_only: true, refresh: true })
    expect(getGlobalModelOptions).not.toHaveBeenCalled()
  })

  it('passes the active session id and refresh flag through the gateway', async () => {
    const gateway = {
      request: vi.fn(() => Promise.resolve(globalOptions))
    }

    await requestModelOptions({ gateway: gateway as never, refresh: true, sessionId: 'session-1' })

    expect(gateway.request).toHaveBeenCalledWith('model.options', {
      explicit_only: true,
      refresh: true,
      session_id: 'session-1'
    })
  })

  it('falls back to REST when no gateway is connected', async () => {
    await requestModelOptions({ refresh: true })

    expect(getGlobalModelOptions).toHaveBeenCalledWith({ explicitOnly: true, refresh: true })
  })
})

describe('account model synchronization', () => {
  const originalBridge = window.agentxDesktop

  beforeEach(() => {
    window.agentxDesktop = {} as never
  })

  afterEach(() => {
    window.agentxDesktop = originalBridge
    $connection.set(null)
    vi.clearAllMocks()
  })

  it('joins local grant refreshes before reading either session catalog, without rotating the key', async () => {
    let complete!: () => void

    const provision = vi.fn(
      () =>
        new Promise<void>(resolve => {
          complete = resolve
        })
    )

    window.agentxDesktop.account = { provision } as never
    $connection.set({ mode: 'local', baseUrl: 'http://local', profile: 'default' } as never)
    const request = vi.fn().mockResolvedValue(globalOptions)
    const first = requestModelOptions({ gateway: { request } as never, sessionId: 'one' })
    const second = requestModelOptions({ gateway: { request } as never, sessionId: 'two' })

    expect(provision).toHaveBeenCalledExactlyOnceWith({ rotate: false })
    expect(request).not.toHaveBeenCalled()
    complete()
    await Promise.all([first, second])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each(['remote', 'cloud', 'ssh'])('never provisions the local account for a %s catalog', async mode => {
    const provision = vi.fn()
    window.agentxDesktop.account = { provision } as never
    $connection.set({ mode, baseUrl: 'http://remote' } as never)
    await requestModelOptions({})
    expect(provision).not.toHaveBeenCalled()
  })

  it('never provisions the primary account while another profile is becoming active', async () => {
    const provision = vi.fn()
    window.agentxDesktop.account = { provision } as never
    // The socket switches before its connection descriptor finishes loading.
    $connection.set({ mode: 'local', baseUrl: 'http://local', profile: 'default' } as never)
    await requestModelOptions({ profile: 'another' })
    expect(provision).not.toHaveBeenCalled()
  })

  it('preserves catalog reads when the account service is offline', async () => {
    window.agentxDesktop.account = { provision: vi.fn().mockRejectedValue(new Error('offline')) } as never
    $connection.set({ mode: 'local', baseUrl: 'http://offline', profile: 'default' } as never)
    await expect(requestModelOptions({})).resolves.toEqual(globalOptions)
  })

  it('retains an explicit cache-only read for callers that opt out of refresh', async () => {
    await requestModelOptions({ refresh: false })
    expect(getGlobalModelOptions).toHaveBeenCalledWith({ explicitOnly: true })
  })
})

describe('replacementModelSelection', () => {
  const options = {
    inference_provider: 'litellm',
    provider: 'litellm',
    model: 'retired',
    providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['new', 'still-granted'] }]
  }

  it('replaces a retired selection with an actually granted model, even when config is stale', () => {
    expect(replacementModelSelection(options, 'litellm', 'retired')).toEqual({ provider: 'litellm', model: 'new' })
    expect(replacementModelSelection({ ...options, model: 'still-granted' }, 'litellm', 'retired')).toEqual({
      provider: 'litellm',
      model: 'still-granted'
    })
  })

  it.each(['litellm', 'custom:litellm', 'custom'])('keeps a valid selection under provider identity %s', provider => {
    expect(replacementModelSelection(options, provider, 'still-granted')).toBeNull()
  })

  it('never guesses a replacement while discovery is unavailable or empty', () => {
    expect(replacementModelSelection(undefined, 'litellm', 'retired')).toBeNull()
    expect(replacementModelSelection({ ...options, providers: [] }, 'litellm', 'retired')).toBeNull()
    expect(
      replacementModelSelection(
        { ...options, providers: [{ ...options.providers[0], models: [] }] },
        'litellm',
        'retired'
      )
    ).toBeNull()
  })
})

describe('modelOptionsQueryKey', () => {
  it('isolates new-chat catalogs by active gateway profile', () => {
    expect(modelOptionsQueryKey('default')).toEqual(['model-options', 'default', 'global'])
    expect(modelOptionsQueryKey('compass')).toEqual(['model-options', 'compass', 'global'])
    expect(modelOptionsQueryKey('default')).not.toEqual(modelOptionsQueryKey('compass'))
  })

  it('keeps session catalogs inside the owning profile namespace', () => {
    expect(modelOptionsQueryKey(' compass ', 'session-1')).toEqual(['model-options', 'compass', 'session-1'])
  })
})

describe('manualPickRemoved', () => {
  const providers = [
    { name: 'OpenRouter', slug: 'openrouter', models: ['owl-alpha', 'gpt-5.5'] },
    { name: 'Nous', slug: 'nous', models: [] } // present but unconfigured / re-auth
  ]

  it('flags a pick whose model was dropped from a populated provider', () => {
    expect(manualPickRemoved(providers, 'openrouter', 'nemotron-removed')).toBe(true)
  })

  it('keeps a pick that is still in the catalog', () => {
    expect(manualPickRemoved(providers, 'openrouter', 'gpt-5.5')).toBe(false)
  })

  it('matches the provider by name as well as slug', () => {
    expect(manualPickRemoved(providers, 'OpenRouter', 'gpt-5.5')).toBe(false)
    expect(manualPickRemoved(providers, 'OpenRouter', 'gone')).toBe(true)
  })

  it('never clobbers when the provider is absent (ambiguous / deauth)', () => {
    expect(manualPickRemoved(providers, 'anthropic', 'claude-sonnet-4.6')).toBe(false)
  })

  it('never clobbers when the provider has an empty model list (re-auth)', () => {
    expect(manualPickRemoved(providers, 'nous', 'hermes-4')).toBe(false)
  })

  it('never clobbers on a not-yet-loaded or empty catalog', () => {
    expect(manualPickRemoved(undefined, 'openrouter', 'gpt-5.5')).toBe(false)
    expect(manualPickRemoved([], 'openrouter', 'gpt-5.5')).toBe(false)
  })

  it('never clobbers when there is no pick', () => {
    expect(manualPickRemoved(providers, '', '')).toBe(false)
  })
})

it('invalidates a manual pin to another provider once gateway models are available', () => {
  const gateway = [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['model'] }]
  expect(manualPickRemoved(gateway, 'anthropic', 'claude')).toBe(true)
  expect(manualPickRemoved(gateway, 'litellm', 'model')).toBe(false)
  expect(manualPickRemoved([{ ...gateway[0], models: [] }], 'anthropic', 'claude')).toBe(false)
})
