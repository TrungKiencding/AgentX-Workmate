import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopLicense } from '@/global'
import { I18nProvider } from '@/i18n'
import { $license } from '@/store/license'

import { ComposerStatusStack } from './index'

// The stack measures itself into a surface var — jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub)

const READ_ONLY: DesktopLicense = {
  access: 'read_only',
  contact: '',
  enforced: true,
  notice: 'read_only',
  plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
  state: 'revoked'
}

function setLicense(license: DesktopLicense | null) {
  $license.set({ account: 'kien', available: true, checking: false, lastCheck: null, license, loaded: true })
}

function renderStack(sessionId: null | string) {
  return render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="en">
        <ComposerStatusStack queue={null} sessionId={sessionId} />
      </I18nProvider>
    </MemoryRouter>
  )
}

describe('ComposerStatusStack and the AgentX license', () => {
  beforeEach(() => setLicense(null))

  afterEach(() => {
    cleanup()
    setLicense(null)
  })

  it('stays empty while no license is known', () => {
    const view = renderStack('s1')

    expect(view.container.firstChild).toBeNull()
  })

  it('stays empty while the license covers AI', () => {
    setLicense({ ...READ_ONLY, access: 'full', notice: null, state: 'active' })

    const view = renderStack('s1')

    expect(view.container.firstChild).toBeNull()
  })

  it('explains a read-only license above a brand-new chat too', () => {
    // A new draft has no session yet; it is locked all the same.
    setLicense(READ_ONLY)

    renderStack(null)

    expect(screen.getByRole('status').textContent).toBe(
      'Your AgentX license has been revoked. Workmate is in read-only mode.'
    )
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('warns through the grace period', () => {
    setLicense({
      ...READ_ONLY,
      access: 'full',
      last_day: '2026-12-31',
      notice: 'grace',
      read_only_from: '2027-01-08',
      state: 'grace'
    })

    renderStack('s1')

    expect(screen.getByRole('status').textContent).toContain('Pilot 2026')
  })
})
