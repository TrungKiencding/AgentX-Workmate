import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopAccountProvisionResult } from '@/global'
import { $desktopOnboarding, type DesktopOnboardingState, type OnboardingContext } from '@/store/onboarding'
import type { OAuthProvider } from '@/types/hermes'

import { Picker } from '.'

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

function setProviders(providers: OAuthProvider[]) {
  $desktopOnboarding.set({
    configured: false,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false
  } satisfies DesktopOnboardingState)
}

// The desktop bridge's account half: present in the app, absent on the web
// dashboard. Its presence is what puts the AgentX AI Gateway card on the picker.
function installAccountBridge(provision: () => Promise<DesktopAccountProvisionResult> = async () => ({ ok: false })) {
  const provisionMock = vi.fn(provision)

  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    value: { account: { provision: provisionMock, status: vi.fn() } }
  })

  return provisionMock
}

const ctx: OnboardingContext = { requestGateway: async () => undefined as never }

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: undefined })

  try {
    window.localStorage.clear()
  } catch {
    // jsdom localStorage should always be present; ignore if not.
  }

  $desktopOnboarding.set({
    configured: null,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false
  })
})

describe('onboarding Picker', () => {
  it('features AgentX AI Gateway and hides the sign-in providers behind a disclosure', () => {
    installAccountBridge()
    setProviders([provider('anthropic', 'Anthropic Claude'), provider('openai-codex', 'OpenAI Codex / ChatGPT')])
    render(<Picker ctx={ctx} />)

    expect(screen.getByText('AgentX AI Gateway')).toBeTruthy()
    expect(screen.getByText('Recommended')).toBeTruthy()
    // Fireworks is the always-visible #2 slot (after the gateway card), even
    // while the sign-in alternatives stay collapsed behind the disclosure.
    expect(screen.getByText('Fireworks AI')).toBeTruthy()
    expect(screen.queryByText('Anthropic API Key')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Other providers' }))

    expect(screen.getByText('Anthropic API Key')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeTruthy()
  })

  it('never offers Nous Portal, even when the backend lists it', () => {
    installAccountBridge()
    setProviders([provider('nous', 'Nous Portal'), provider('minimax-oauth', 'MiniMax')])
    render(<Picker ctx={ctx} />)

    fireEvent.click(screen.getByRole('button', { name: 'Other providers' }))

    expect(screen.getByText('MiniMax')).toBeTruthy()
    expect(screen.queryByText('Nous Portal')).toBeNull()
    expect(screen.queryByText(/300\+ frontier models/)).toBeNull()
  })

  it('orders the gateway card, then Fireworks, then the sign-in providers', () => {
    installAccountBridge()
    setProviders([provider('minimax-oauth', 'MiniMax'), provider('openai-codex', 'OpenAI Codex / ChatGPT')])
    render(<Picker ctx={ctx} />)
    fireEvent.click(screen.getByRole('button', { name: 'Other providers' }))

    const labels = screen
      .getAllByRole('button')
      .map(el => el.textContent ?? '')
      .filter(text => /AgentX AI Gateway|Fireworks AI|ChatGPT or Codex|MiniMax|OpenRouter/.test(text))

    const indexOf = (needle: string) => labels.findIndex(text => text.includes(needle))
    expect(indexOf('AgentX AI Gateway')).toBe(0)
    expect(indexOf('Fireworks AI')).toBeGreaterThan(indexOf('AgentX AI Gateway'))
    expect(indexOf('ChatGPT or Codex')).toBeGreaterThan(indexOf('Fireworks AI'))
    expect(indexOf('MiniMax')).toBeGreaterThan(indexOf('ChatGPT or Codex'))
    expect(indexOf('OpenRouter')).toBeGreaterThan(indexOf('MiniMax'))
  })

  it('keeps the gateway card up when the backend lists no sign-in providers', () => {
    installAccountBridge()
    setProviders([])
    render(<Picker ctx={ctx} />)

    expect(screen.getByText('AgentX AI Gateway')).toBeTruthy()
    expect(screen.getByText('OpenRouter')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Other providers' })).toBeNull()
    expect(screen.queryByPlaceholderText('Paste API key')).toBeNull()
  })

  it('shows every sign-in provider directly without the desktop account bridge', () => {
    setProviders([provider('anthropic', 'Anthropic Claude'), provider('openai-codex', 'OpenAI Codex / ChatGPT')])
    render(<Picker ctx={ctx} />)

    expect(screen.getByText('Fireworks AI')).toBeTruthy()
    expect(screen.getByText('Anthropic API Key')).toBeTruthy()
    expect(screen.getByText('ChatGPT or Codex Subscription')).toBeTruthy()
    expect(screen.queryByText('Other sign-in options')).toBeNull()
    expect(screen.queryByText('AgentX AI Gateway')).toBeNull()
    expect(screen.queryByText('Recommended')).toBeNull()
  })

  it('asks the desktop for the account gateway key when the card is picked', async () => {
    const provision = installAccountBridge(async () => ({
      ok: false,
      litellm: {
        base_url: '',
        detail: 'accounts.second_brain.base_url is not set.',
        key_alias: '',
        masked_key: '',
        models: [],
        ok: false,
        provider: '',
        status: 'unconfigured'
      }
    }))

    setProviders([])
    render(<Picker ctx={ctx} />)

    fireEvent.click(screen.getByText('AgentX AI Gateway'))

    await waitFor(() => expect($desktopOnboarding.get().flow.status).toBe('error'))

    // No `rotate`: picking the card must never retire the key another of this
    // person's machines is using.
    expect(provision).toHaveBeenCalledTimes(1)
    expect(provision).toHaveBeenCalledWith()

    const { flow } = $desktopOnboarding.get()
    expect(flow.status === 'error' ? flow.message : '').toContain('not set up on this install')
  })

  it('offers "choose later" on first run and persists the skip', () => {
    installAccountBridge()
    setProviders([provider('openai-codex', 'OpenAI Codex / ChatGPT')])
    render(<Picker ctx={ctx} />)

    const skip = screen.getByRole('button', { name: "I'll choose a provider later" })

    fireEvent.click(skip)

    expect($desktopOnboarding.get().firstRunSkipped).toBe(true)
    expect(window.localStorage.getItem('agentx-onboarding-skipped-v1')).toBe('1')
  })

  it('hides "choose later" in manual (add-provider) mode', () => {
    installAccountBridge()
    setProviders([provider('openai-codex', 'OpenAI Codex / ChatGPT')])
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), manual: true })
    render(<Picker ctx={ctx} />)

    expect(screen.queryByRole('button', { name: "I'll choose a provider later" })).toBeNull()
  })
})
