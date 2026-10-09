import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UninstallSection } from './uninstall-section'

function stubUninstall(agentInstalled = true) {
  const run = vi.fn(async () => ({ ok: true }))

  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    value: {
      uninstall: {
        run,
        summary: vi.fn(async () => ({ agent_installed: agentInstalled, running_app_path: '/Applications/AgentX.app' }))
      }
    }
  })

  return run
}

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: undefined })
})

describe('UninstallSection', () => {
  it('leads with the option that keeps the person’s data, and recommends it', async () => {
    stubUninstall()
    render(<UninstallSection />)

    const options = await screen.findAllByRole('button', { name: /Uninstall/ })
    const titles = options.map(button => button.textContent ?? '')

    expect(titles[0]).toContain('Uninstall, keep my data')
    expect(titles[0]).toContain('Recommended')
    expect(titles[1]).toContain('Uninstall everything')
    expect(titles[1]).not.toContain('Recommended')
  })

  it('runs the keep-data uninstall once confirmed', async () => {
    const run = stubUninstall()
    render(<UninstallSection />)

    fireEvent.click(await screen.findByRole('button', { name: /Uninstall, keep my data/ }))

    expect(screen.getByText(/your chats, settings and model key are kept/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Yes, uninstall' }))

    await waitFor(() => expect(run).toHaveBeenCalledWith('lite'))
  })

  it('still offers wiping everything, as a choice of its own', async () => {
    const run = stubUninstall()
    render(<UninstallSection />)

    fireEvent.click(await screen.findByRole('button', { name: /Uninstall everything/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, uninstall' }))

    await waitFor(() => expect(run).toHaveBeenCalledWith('full'))
  })
})
