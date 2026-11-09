import { host } from '@agentx/plugin-sdk'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line no-restricted-imports -- register real bundles as the plugin loader does
import { registerPluginLocales } from '@/i18n/plugin-i18n'

import { BOTS_LOCALES } from './i18n'
import { PLUGIN_ID } from './state'
import { WorkspaceSwitcher } from './workspace-switcher'

let disposeLocales: () => void

beforeAll(() => {
  disposeLocales = registerPluginLocales(PLUGIN_ID, BOTS_LOCALES)
})

afterAll(() => disposeLocales())

beforeEach(() => {
  window.history.replaceState(null, '', '#/')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Work / Assistants navigation', () => {
  it('returns to the exact workspace destination, including its query, without resetting a chat', async () => {
    window.history.replaceState(null, '', '#/session%3Aone?view=details')
    const newChat = vi.spyOn(host, 'newChat')
    render(<WorkspaceSwitcher />)

    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Assistants' }))

    await waitFor(() => {
      expect(window.location.hash).toBe('#/bots')
      expect(screen.getByRole('button', { name: 'Assistants' }).getAttribute('aria-pressed')).toBe('true')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    await waitFor(() => expect(window.location.hash).toBe('#/session%3Aone?view=details'))
    expect(newChat).not.toHaveBeenCalled()
  })

  it('recognises an externally opened assistant page with a query and falls back to the focused session', async () => {
    window.history.replaceState(null, '', '#/bots?selected=writer')
    vi.spyOn(host.state.storedSessionId, 'get').mockReturnValue('session:two')
    render(<WorkspaceSwitcher />)

    expect(screen.getByRole('button', { name: 'Assistants' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    await waitFor(() => expect(window.location.hash).toBe('#/session%3Atwo'))
  })

  it('opens the existing draft when no session exists', async () => {
    window.history.replaceState(null, '', '#/bots')
    vi.spyOn(host.state.storedSessionId, 'get').mockReturnValue(null)
    render(<WorkspaceSwitcher />)

    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    await waitFor(() => expect(window.location.hash).toBe('#/'))
  })

  it('keeps the current destination when its selected button is clicked again', () => {
    window.history.replaceState(null, '', '#/skills?tab=mcp')
    const navigate = vi.spyOn(host, 'navigate')
    render(<WorkspaceSwitcher />)

    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(navigate).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/skills?tab=mcp')
  })

  it('tracks browser navigation independently of button clicks', async () => {
    render(<WorkspaceSwitcher />)
    window.location.hash = '/bots'
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Assistants' }).getAttribute('aria-pressed')).toBe('true')
    )

    window.location.hash = '/artifacts'
    await waitFor(() => expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-pressed')).toBe('true'))

    window.location.hash = '/bots'
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Assistants' }).getAttribute('aria-pressed')).toBe('true')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    await waitFor(() => expect(window.location.hash).toBe('#/artifacts'))
  })
})
