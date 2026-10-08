import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopLicense } from '@/global'
import { setTimeFormatLocale } from '@/lib/time'
import { $license } from '@/store/license'

import { LicenseBanner } from './license-banner'

const original = window.agentxDesktop

function license(overrides: Partial<DesktopLicense> = {}): DesktopLicense {
  return {
    access: 'full',
    contact: 'it@astralx.com.vn',
    days_left: 120,
    enforced: true,
    last_day: '2026-12-31',
    notice: null,
    plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
    read_only_from: '2027-01-08',
    reminder: null,
    starts_on: '2026-10-15',
    state: 'active',
    ...overrides
  }
}

function show(value: DesktopLicense | null, checking = false, lastCheck: null | string = null) {
  $license.set({ account: 'kien', available: true, checking, lastCheck, license: value, loaded: true })
  render(<LicenseBanner />)
}

beforeEach(() => setTimeFormatLocale('en'))

afterEach(() => {
  cleanup()
  setTimeFormatLocale(undefined)
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
})

describe('LicenseBanner', () => {
  it('says nothing while no license is known, or while it covers AI', () => {
    show(null)
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()

    show(license())
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()

    // The reminder is a toast; the banner is for grace and read-only only.
    show(license({ days_left: 7, notice: 'expiring', reminder: 7 }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('warns through the grace period, naming the day read-only begins', () => {
    show(license({ notice: 'grace', state: 'grace' }))

    expect(screen.getByRole('status').textContent).toBe(
      'Your Pilot 2026 plan expired on Dec 31, 2026. From Jan 8, 2027, Workmate switches to read-only mode. ' +
        'Contact it@astralx.com.vn to renew.'
    )
  })

  it.each([
    [{ plan: null, state: 'none' as const }, "Your account hasn't been assigned an AgentX license."],
    [{ state: 'scheduled' as const }, 'Your Pilot 2026 plan starts on Oct 15, 2026.'],
    [{ state: 'expired' as const }, 'Your Pilot 2026 plan expired on Dec 31, 2026. Workmate is in read-only mode.'],
    [{ state: 'revoked' as const }, 'Your AgentX license has been revoked. Workmate is in read-only mode.']
  ])('explains read-only (%o) and whom to ask', (overrides, reason) => {
    show(license({ access: 'read_only', notice: 'read_only', ...overrides }))

    expect(screen.getByRole('status').textContent).toBe(
      `${reason} Contact it@astralx.com.vn to get a license or renew it.`
    )
  })

  it('checks again when asked', () => {
    const refresh = vi.fn(async () => ({ account: 'kien', detail: '', license: null, status: 'ok' }))

    Object.defineProperty(window, 'agentxDesktop', {
      configurable: true,
      value: { license: { get: vi.fn(), onChanged: vi.fn(), refresh } }
    })
    show(license({ access: 'read_only', notice: 'read_only', state: 'revoked' }))

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('says when a check could not reach the service', () => {
    show(license({ access: 'read_only', notice: 'read_only', state: 'revoked' }), false, 'offline')

    expect(screen.getByText("Couldn't check right now — showing the last license we know of.")).toBeTruthy()
    cleanup()

    // A check that answered says nothing extra: the license shown is current.
    show(license({ access: 'read_only', notice: 'read_only', state: 'revoked' }), false, 'ok')

    expect(screen.queryByText("Couldn't check right now — showing the last license we know of.")).toBeNull()
  })

  it('cannot be pressed twice while a check is running', () => {
    show(license({ access: 'read_only', notice: 'read_only', state: 'revoked' }), true)

    expect(screen.getByRole('button', { name: 'Checking…' })).toHaveProperty('disabled', true)
  })
})
