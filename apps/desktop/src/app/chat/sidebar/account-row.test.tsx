import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $keycloakAccount } from '@/store/account'
import { $license } from '@/store/license'

import { accountInitials, SidebarAccountRow } from './account-row'

const signedOut = $keycloakAccount.get()
const noLicense = $license.get()

const renderRow = () =>
  render(
    <MemoryRouter>
      <SidebarAccountRow />
    </MemoryRouter>
  )

beforeEach(() => {
  $keycloakAccount.set({ ...signedOut, loaded: true })
})

afterEach(() => {
  cleanup()
  $keycloakAccount.set(signedOut)
  $license.set(noLicense)
})

describe('accountInitials', () => {
  it('takes the first and last word of a name, else the email', () => {
    expect(accountInitials('Lê Trung Kiên', '')).toBe('LK')
    expect(accountInitials('kien', '')).toBe('K')
    expect(accountInitials('', 'an@example.com')).toBe('A')
    expect(accountInitials('', '')).toBe('')
  })
})

describe('SidebarAccountRow', () => {
  it('renders nothing until someone is signed in', () => {
    const { container } = renderRow()

    expect(container.textContent).toBe('')
  })

  it('shows initials, name and plan, and opens the account menu', () => {
    $keycloakAccount.set({
      ...signedOut,
      displayName: 'Lê Kiên',
      email: 'kien@example.com',
      loaded: true,
      signedIn: true
    })
    $license.set({ ...$license.get(), license: { plan: { name: 'Pro', slug: 'pro' } } as never })

    renderRow()

    const trigger = screen.getByRole('button', { name: 'Account menu' })

    expect(trigger.textContent).toContain('LK')
    expect(trigger.textContent).toContain('Lê Kiên')
    expect(trigger.textContent).toContain('· Pro')
  })
})
