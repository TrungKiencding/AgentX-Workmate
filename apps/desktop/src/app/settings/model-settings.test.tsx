import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Radix Select calls scrollIntoView on its items when the content opens; jsdom
// doesn't implement it (nor hasPointerCapture / releasePointerCapture), so stub
// them to let the dropdown open in tests.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const getGlobalModelInfo = vi.fn()
const getGlobalModelOptions = vi.fn()
const getAuxiliaryModels = vi.fn()
const getMoaModels = vi.fn()
const setModelAssignment = vi.fn()
const getRecommendedDefaultModel = vi.fn()
const saveMoaModels = vi.fn()
const setEnvVar = vi.fn()
const getHermesConfigRecord = vi.fn()
const saveHermesConfig = vi.fn()
const startManualOnboarding = vi.fn()
let profileSwitchHandler: (() => void) | null = null

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: () => getGlobalModelInfo(),
  getGlobalModelOptions: () => getGlobalModelOptions(),
  getAuxiliaryModels: () => getAuxiliaryModels(),
  getApiRequestProfile: () => 'default',
  getMoaModels: () => getMoaModels(),
  setModelAssignment: (body: unknown) => setModelAssignment(body),
  getRecommendedDefaultModel: (slug: string) => getRecommendedDefaultModel(slug),
  saveMoaModels: (body: unknown) => saveMoaModels(body),
  setEnvVar: (key: string, value: string) => setEnvVar(key, value),
  getHermesConfigRecord: () => getHermesConfigRecord(),
  saveHermesConfig: (config: unknown) => saveHermesConfig(config),
  setApiRequestProfile: () => {}
}))

vi.mock('@/store/onboarding', () => ({
  startManualOnboarding: () => startManualOnboarding(),
  AGENTX_GATEWAY_LABEL: 'AgentX AI Gateway'
}))

vi.mock('../hooks/use-on-profile-switch', () => ({
  useOnProfileSwitch: (handler: () => void) => {
    profileSwitchHandler = handler
  }
}))

beforeEach(() => {
  getGlobalModelInfo.mockResolvedValue({ provider: 'litellm', model: 'hermes-4' })
  getGlobalModelOptions.mockResolvedValue({
    providers: [
      {
        name: 'AgentX AI Gateway',
        slug: 'litellm',
        models: ['hermes-4', 'hermes-4-mini'],
        authenticated: true,
        capabilities: { 'hermes-4': { reasoning: true, fast: true } }
      }
    ]
  })
  getAuxiliaryModels.mockResolvedValue({
    main: { provider: 'litellm', model: 'hermes-4' },
    tasks: [{ task: 'vision', provider: 'auto', model: '', base_url: '' }]
  })
  getMoaModels.mockResolvedValue(null)
  setModelAssignment.mockResolvedValue({ ok: true, provider: 'litellm', model: 'hermes-4', gateway_tools: [] })
  getRecommendedDefaultModel.mockResolvedValue({ provider: 'litellm', model: 'hermes-4', free_tier: null })
  setEnvVar.mockResolvedValue({ ok: true })
  getHermesConfigRecord.mockResolvedValue({ agent: { reasoning_effort: 'medium', service_tier: 'normal' } })
  saveHermesConfig.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  profileSwitchHandler = null
})

async function renderModelSettings() {
  const { ModelSettings } = await import('./model-settings')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    // The aux-task deep-link highlight reads useSearchParams, so the page
    // needs a router context in tests (the app provides HashRouter at root).
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ModelSettings />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('ModelSettings', () => {
  it('has no provider selector or API key form and applies only a gateway model', async () => {
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        { name: 'AgentX AI Gateway', slug: 'litellm', models: ['hermes-4'], api_url: 'https://gateway.test/v1' },
        { name: 'Anthropic', slug: 'anthropic', models: ['claude'], authenticated: true }
      ]
    })
    await renderModelSettings()
    const selects = await screen.findAllByRole('combobox')
    fireEvent.click(selects[0])
    expect(await screen.findByRole('option', { name: 'hermes-4' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Anthropic' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'claude' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'hermes-4' }))
    expect(screen.queryByPlaceholderText(/Paste/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        scope: 'main',
        provider: 'litellm',
        model: 'hermes-4',
        base_url: 'https://gateway.test/v1'
      })
    )
  })

  it.each(['anthropic', 'custom', 'local', 'retired-provider'])(
    'offers gateway retry instead of setting up legacy provider %s',
    async provider => {
      getGlobalModelInfo.mockResolvedValueOnce({ provider, model: 'old-model' })
      getGlobalModelOptions.mockResolvedValueOnce({ providers: [] })
      await renderModelSettings()
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
      expect(startManualOnboarding).toHaveBeenCalledOnce()
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    }
  )

  it('replaces model selection when the account profile changes', async () => {
    getGlobalModelInfo
      .mockResolvedValueOnce({ provider: 'litellm', model: 'account-a-model' })
      .mockResolvedValueOnce({ provider: 'litellm', model: 'account-b-model' })
    getGlobalModelOptions
      .mockResolvedValueOnce({
        providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['account-a-model'] }]
      })
      .mockResolvedValueOnce({
        providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['account-b-model'] }]
      })
    await renderModelSettings()
    expect((await screen.findAllByRole('combobox'))[0].textContent).toContain('account-a-model')
    await act(async () => {
      profileSwitchHandler?.()
    })
    await waitFor(() => expect(screen.getAllByRole('combobox')[0].textContent).toContain('account-b-model'))
  })

  it('writes the profile default speed (service_tier) when the fast switch is toggled', async () => {
    await renderModelSettings()
    await waitFor(() => expect(getHermesConfigRecord).toHaveBeenCalled())

    const fastSwitch = await screen.findByRole('switch')
    fireEvent.click(fastSwitch)

    await waitFor(() =>
      expect(saveHermesConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agent: expect.objectContaining({ service_tier: 'fast' }) })
      )
    )
  })

  it('hides the reasoning/speed defaults when the main model reports no capabilities', async () => {
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        {
          name: 'AgentX AI Gateway',
          slug: 'litellm',
          models: ['hermes-4'],
          authenticated: true,
          capabilities: { 'hermes-4': { reasoning: false, fast: false } }
        }
      ]
    })

    await renderModelSettings()
    await waitFor(() => expect(getHermesConfigRecord).toHaveBeenCalled())

    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('renders the auxiliary task rows', async () => {
    await renderModelSettings()

    expect(await screen.findByText('Vision')).toBeTruthy()
    expect(screen.getAllByText('auto · use main model').length).toBeGreaterThan(0)
  })

  it('assigns an auxiliary task to the main model via setModelAssignment', async () => {
    await renderModelSettings()

    // One "Set to main" button per task slot; the first is Vision.
    const setToMainButtons = await screen.findAllByRole('button', { name: 'Set to main' })
    fireEvent.click(setToMainButtons[0])

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        model: 'hermes-4',
        provider: 'litellm',
        scope: 'auxiliary',
        task: 'vision'
      })
    )
  })

  it('carries the user-defined endpoint when an aux slot is set to a gateway main model', async () => {
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [
        {
          name: 'AgentX AI Gateway',
          slug: 'litellm',
          models: ['qwen3:latest'],
          authenticated: true,
          is_user_defined: true,
          api_url: 'https://gateway.test/v1'
        }
      ]
    })
    getGlobalModelInfo.mockResolvedValueOnce({ provider: 'litellm', model: 'qwen3:latest' })
    getAuxiliaryModels.mockResolvedValueOnce({
      main: { provider: 'litellm', model: 'qwen3:latest' },
      tasks: [{ task: 'vision', provider: 'auto', model: '', base_url: '' }]
    })

    await renderModelSettings()

    const setToMainButtons = await screen.findAllByRole('button', { name: 'Set to main' })
    fireEvent.click(setToMainButtons[0])

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        model: 'qwen3:latest',
        provider: 'litellm',
        scope: 'auxiliary',
        task: 'vision',
        base_url: 'https://gateway.test/v1'
      })
    )
  })

  it('warns when a main switch leaves auxiliary tasks pinned to another provider', async () => {
    setModelAssignment.mockResolvedValueOnce({
      ok: true,
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4.7',
      gateway_tools: [],
      stale_aux: [{ task: 'compression', provider: 'litellm', model: 'hermes-4' }]
    })

    await renderModelSettings()
    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalled())

    const applyButton = await screen.findByRole('button', { name: 'Apply' })
    fireEvent.click(applyButton)

    // The switch-time notice names the pinned provider and offers a reset.
    expect(await screen.findByText(/remain configured for/)).toBeTruthy()
    expect(screen.getByText('litellm')).toBeTruthy()
  })

  it('shows a persistent banner when a loaded aux slot mismatches the main provider', async () => {
    getAuxiliaryModels.mockResolvedValueOnce({
      main: { provider: 'litellm', model: 'hermes-4' },
      tasks: [{ task: 'curator', provider: 'openrouter', model: 'anthropic/claude-opus-4.7', base_url: '' }]
    })

    await renderModelSettings()

    // Banner present on load, no switch required.
    expect(await screen.findByText(/remain configured for/)).toBeTruthy()
  })
})

describe('ModelSettings MoA preset editor', () => {
  const moaConfig = () => ({
    default_preset: 'default',
    active_preset: '',
    presets: {
      default: {
        reference_models: [
          { provider: 'litellm', model: 'hermes-4' },
          { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' }
        ],
        aggregator: { provider: 'openrouter', model: 'anthropic/claude-opus-4.8' },
        reference_temperature: 0,
        aggregator_temperature: 0,
        max_tokens: 4096,
        enabled: true
      }
    },
    reference_models: [
      { provider: 'litellm', model: 'hermes-4' },
      { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' }
    ],
    aggregator: { provider: 'openrouter', model: 'anthropic/claude-opus-4.8' },
    reference_temperature: 0,
    aggregator_temperature: 0,
    max_tokens: 4096,
    enabled: true
  })

  beforeEach(() => {
    getGlobalModelOptions.mockResolvedValue({
      providers: [
        {
          name: 'AgentX AI Gateway',
          slug: 'litellm',
          models: ['hermes-4', 'hermes-4-mini'],
          authenticated: true,
          capabilities: { 'hermes-4': { reasoning: true, fast: true } }
        },
        {
          name: 'OpenRouter',
          slug: 'openrouter',
          models: ['deepseek/deepseek-v4-pro', 'anthropic/claude-opus-4.8'],
          authenticated: true
        }
      ]
    })
    getMoaModels.mockResolvedValue(moaConfig())
    saveMoaModels.mockImplementation((body: unknown) => Promise.resolve(body))
  })

  async function openReferenceEditor() {
    await renderModelSettings()
    expect(await screen.findByText('Reference 1')).toBeTruthy()
  }

  it('offers model edits without provider selection and autosaves through the gateway', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()
      const all = screen.getAllByRole('combobox')
      fireEvent.click(all.at(-3)!)
      expect(screen.queryByRole('option', { name: 'OpenRouter' })).toBeNull()
      fireEvent.click(await screen.findByRole('option', { name: 'hermes-4-mini' }))
      await vi.advanceTimersByTimeAsync(700)
      expect(saveMoaModels).toHaveBeenCalledTimes(1)
      const sent = saveMoaModels.mock.calls[0][0] as ReturnType<typeof moaConfig>
      expect(sent.presets.default.reference_models[0]).toEqual({ provider: 'litellm', model: 'hermes-4-mini' })
      expect(sent.presets.default.reference_models.every(slot => slot.provider === 'litellm')).toBe(true)
      expect(sent.presets.default.aggregator.provider).toBe('litellm')
    } finally {
      vi.useRealTimers()
    }
  })

  it('autosaves the selected preset when its enabled switch is toggled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
      await vi.advanceTimersByTimeAsync(700)

      expect(saveMoaModels).toHaveBeenCalledWith(
        expect.objectContaining({
          presets: expect.objectContaining({
            default: expect.objectContaining({ enabled: false })
          })
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('saves a disabled reference model without removing it (per-slot enabled toggle)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(screen.getByRole('switch', { name: 'Disable reference 1' }))
      await vi.advanceTimersByTimeAsync(700)

      expect(saveMoaModels).toHaveBeenCalledWith(
        expect.objectContaining({
          presets: expect.objectContaining({
            default: expect.objectContaining({
              reference_models: [
                expect.objectContaining({ provider: 'litellm', model: 'hermes-4', enabled: false }),
                expect.objectContaining({ provider: 'litellm', model: 'hermes-4' })
              ]
            })
          })
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
