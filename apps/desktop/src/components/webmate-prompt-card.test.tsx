import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $webmatePrompt, $webmateStatus, resetWebmatePromptSession } from '@/store/webmate'

import { WebmatePromptCard } from './webmate-prompt-card'

const desktopWindow = window as unknown as { agentxDesktop?: Window['agentxDesktop'] }
const initialAgentxDesktop = desktopWindow.agentxDesktop

function LocationProbe() {
  const location = useLocation()

  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderCard() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          element={
            <>
              <WebmatePromptCard />
              <LocationProbe />
            </>
          }
          path="*"
        />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  resetWebmatePromptSession()
  $webmateStatus.set(null)
  desktopWindow.agentxDesktop = {
    webmate: { setPrefs: vi.fn(async (patch: Record<string, unknown>) => patch) }
  } as unknown as Window['agentxDesktop']
})

afterEach(() => {
  cleanup()
  desktopWindow.agentxDesktop = initialAgentxDesktop
})

describe('WebmatePromptCard', () => {
  it('renders nothing until a code arrives, then the three doors', () => {
    renderCard()
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => $webmatePrompt.set({ code: 'WEBMATE_NOT_INSTALLED', at: Date.now() }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Workmate wants to use your browser')).toBeTruthy()
    expect(screen.getByText(/This needs WebMate/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add WebMate' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Don’t ask again' })).toBeTruthy()
  })

  it('"Add WebMate" opens Settings → Browser and closes the card', () => {
    renderCard()
    act(() => $webmatePrompt.set({ code: 'WEBMATE_NOT_INSTALLED', at: Date.now() }))

    fireEvent.click(screen.getByRole('button', { name: 'Add WebMate' }))

    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=browser')
    expect($webmatePrompt.get()).toBeNull()
  })

  it('"Not now" and "Don’t ask again" close it and record the choice', () => {
    const setPrefs = (desktopWindow.agentxDesktop as unknown as { webmate: { setPrefs: ReturnType<typeof vi.fn> } }).webmate.setPrefs

    renderCard()
    act(() => $webmatePrompt.set({ code: 'WEBMATE_NOT_CONNECTED', at: Date.now() }))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect($webmatePrompt.get()).toBeNull()
    expect(typeof setPrefs.mock.calls[0][0].cardSnoozedUntil).toBe('string')

    act(() => $webmatePrompt.set({ code: 'WEBMATE_PORT_IN_USE', at: Date.now() }))
    // Nothing Settings can do about a taken port: no primary door.
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Don’t ask again' }))
    expect(setPrefs).toHaveBeenLastCalledWith({ askWhenNotReady: false })
  })
})
