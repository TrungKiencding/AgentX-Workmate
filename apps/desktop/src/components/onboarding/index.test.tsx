import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { $desktopOnboarding, type DesktopOnboardingState, type OnboardingContext } from '@/store/onboarding'

import { FlowPanel } from './flow'

import { DesktopOnboardingOverlay, Picker } from '.'

const ctx: OnboardingContext = { requestGateway: async () => ({ ok: false }) as never }

const initial: DesktopOnboardingState = {
  configured: false,
  flow: { status: 'idle' },
  reason: null,
  requested: false,
  firstRunSkipped: false,
  manual: false
}

afterEach(() => {
  cleanup()
  $desktopOnboarding.set(initial)
  window.localStorage.clear()
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: undefined })
})

function bridge(status: string) {
  const provision = vi.fn(async () => ({ ok: false, litellm: { ok: false, status, detail: '', code: '' } }))
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: { account: { provision } } })

  return provision
}

describe('gateway-only onboarding', () => {
  it.each([false, true])('offers only gateway setup and skip (manual=%s)', manual => {
    $desktopOnboarding.set({ ...initial, manual })
    bridge('disabled')
    render(<Picker ctx={ctx} />)
    expect(screen.getByText('AgentX AI Gateway')).toBeTruthy()
    expect(screen.queryByText('Other providers')).toBeNull()
    expect(screen.queryByText('Fireworks AI')).toBeNull()
    expect(screen.queryByText('OpenRouter')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: en.common.skip }) !== null).toBe(!manual)
  })

  it('offers no alternate providers even without a provisioning bridge', () => {
    $desktopOnboarding.set(initial)
    render(<Picker ctx={ctx} />)
    expect(screen.getByText('AgentX AI Gateway')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it.each(['disabled', 'unconfigured', 'offline', 'error', 'no-answer'])(
    'allows skipping %s gateway errors',
    async status => {
      $desktopOnboarding.set(initial)
      bridge(status)
      const view = render(<Picker ctx={ctx} />)
      fireEvent.click(screen.getByRole('button', { name: /AgentX AI Gateway/ }))
      await waitFor(() => expect($desktopOnboarding.get().flow.status).toBe('error'))
      view.unmount()
      render(<FlowPanel ctx={ctx} flow={$desktopOnboarding.get().flow} leaving={false} onBegin={() => {}} />)
      expect(screen.queryByRole('button', { name: en.onboarding.pickDifferentProvider })).toBeNull()
      expect(screen.getByRole('button', { name: en.agentxKey.retry })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: en.common.skip }))
      expect($desktopOnboarding.get()).toMatchObject({
        firstRunSkipped: true,
        configured: false,
        flow: { status: 'idle' }
      })
      expect(window.localStorage.getItem('agentx-desktop-onboarded-v1')).toBeNull()
    }
  )

  it('keeps a skipped setup dismissed on subsequent runtime checks', async () => {
    $desktopOnboarding.set({ ...initial, firstRunSkipped: true })
    render(<DesktopOnboardingOverlay enabled profile="default" requestGateway={ctx.requestGateway} />)
    await waitFor(() => expect(screen.queryByText(en.onboarding.headerTitle)).toBeNull())
  })
})
