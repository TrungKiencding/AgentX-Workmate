import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { cleanStores } from 'nanostores'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { DesktopAccountQuota, DesktopAccountQuotaView } from '@/global'
import { $keycloakAccount } from '@/store/account'
import { $accountQuota } from '@/store/account-quota'

import { ComposerAccountQuota } from './account-quota'

const original = window.agentxDesktop
const account = $keycloakAccount.get()

const quota: DesktopAccountQuota = {
  spend: 12.5,
  limit: 50,
  remaining: 37.5,
  renews: true,
  reset_at: '2099-12-01T00:00:00Z',
  updated_at: '2026-11-09T12:00:00Z'
}

let read = vi.fn<() => Promise<DesktopAccountQuotaView>>()

beforeEach(() => {
  $keycloakAccount.set({ ...account, signedIn: true, issuer: 'sso', userId: 'alice' })
  read = vi.fn().mockResolvedValue({ status: 'ok', quota })
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: { account: { quota: read } } })
})
afterEach(() => {
  cleanup()
  cleanStores($accountQuota)
  $keycloakAccount.set(account)
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
})

async function open() {
  render(<ComposerAccountQuota />)
  const trigger = await screen.findByRole('button', { name: /View allowance: 75%/ })
  fireEvent.click(trigger)

  return screen.findByRole('dialog', { name: 'Model allowance' })
}

it('keeps the resting composer control compact and opens details only on click', async () => {
  render(<ComposerAccountQuota />)
  const trigger = await screen.findByRole('button', { name: /View allowance: 75%/ })
  expect(trigger.textContent).toBe('75%')
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.mouseEnter(trigger)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  expect(await screen.findByRole('dialog', { name: 'Model allowance' })).toBeTruthy()
})

it('opens accessible details with percentages and reset time and closes with Escape', async () => {
  await open()
  const panel = screen.getByRole('dialog')
  expect(panel.textContent).toContain('75%')
  expect(panel.textContent).toContain('25%')
  expect(panel.textContent).not.toMatch(/\$|USD|Last updated|Shared across devices/)
  expect(panel.querySelectorAll('time')).toHaveLength(1)
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
  expect(window.document.querySelector('time[datetime="2099-12-01T00:00:00Z"]')).toBeTruthy()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false))
  fireEvent.keyDown(window.document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it.each([
  [0, 0, 'Allowance used up'],
  [50, 0, 'Allowance used up'],
  [50, 5, 'Nearly used up'],
  [null, null, 'Unlimited']
])('distinguishes zero, exhausted, low and unlimited budgets (%s, %s)', async (limit, remaining, label) => {
  read.mockResolvedValue({ status: 'ok', quota: { ...quota, limit, remaining } })
  render(<ComposerAccountQuota />)
  await waitFor(() => expect($accountQuota.get().loaded).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: /View allowance/ }))
  expect((await screen.findAllByText(label)).length).toBeGreaterThan(0)

  if (limit === null) {
    expect(screen.queryByRole('progressbar')).toBeNull()
  }
})

it('retains last-known percentages and explains a failed refresh', async () => {
  await open()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false))
  read.mockResolvedValue({ status: 'offline', quota: null })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(await screen.findByText('Usage is temporarily unavailable. Try refreshing.')).toBeTruthy()
  expect(screen.getByRole('dialog').textContent).toContain('75%')
})

it('explains unsupported usage and hides when signed out', async () => {
  read.mockResolvedValue({ status: 'unsupported', quota: null })
  const view = render(<ComposerAccountQuota />)
  fireEvent.click(await screen.findByRole('button', { name: /View allowance/ }))
  expect(await screen.findByText('Your server does not share usage details. Contact your administrator.')).toBeTruthy()
  view.unmount()
  $keycloakAccount.set({ ...account, signedIn: false })
  expect(render(<ComposerAccountQuota />).container.textContent).toBe('')
})

it('waits for upstream confirmation when the reset time has passed', async () => {
  read.mockResolvedValue({ status: 'ok', quota: { ...quota, reset_at: '2000-01-01T00:00:00Z' } })
  await open()
  expect(screen.getByText('Awaiting reset confirmation')).toBeTruthy()
  expect(screen.getByRole('dialog').textContent).toContain('75%')
})
