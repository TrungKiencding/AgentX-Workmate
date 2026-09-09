import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopWebmateBrowser, DesktopWebmateStatus } from '@/global'
import { $webmateBrowsers, $webmateGuide, $webmateScanning, $webmateStatus } from '@/store/webmate'

import { BrowserStepPanel } from './browser-step'

const desktopWindow = window as unknown as { agentxDesktop?: Window['agentxDesktop'] }
const initialAgentxDesktop = desktopWindow.agentxDesktop

function browser(overrides: Partial<DesktopWebmateBrowser> = {}): DesktopWebmateBrowser {
  return {
    id: 'chrome',
    name: 'Google Chrome',
    executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    appPath: '/Applications/Google Chrome.app',
    version: '152.0.7977.83',
    isDefault: false,
    supported: true,
    unsupportedReason: null,
    dataDir: '/d',
    extensionsUrl: 'chrome://extensions',
    singleProfile: false,
    running: true,
    profiles: [
      {
        dir: 'Default',
        displayName: 'Kiên',
        lastActive: null,
        isLastUsed: true,
        webmate: { installed: false, path: null, disabled: false, disableReasons: [], elsewhere: false }
      }
    ],
    ...overrides
  }
}

function status(overrides: Partial<DesktopWebmateStatus> = {}): DesktopWebmateStatus {
  return {
    paths: {
      root: '/Users/k/.agentx/webmate',
      installDir: '/Users/k/.agentx/webmate/AgentX WebMate',
      workmateJson: '',
      pairingFile: '',
      stateFile: '',
      commandsDir: '',
      versionsDir: '',
      prevDir: '',
      updateCheckFile: '',
      profileDir: ''
    },
    installedVersion: '1.0.4',
    pairingPresent: true,
    bridge: null,
    stale: false,
    serverRunning: true,
    connected: false,
    browser: null,
    extensionVersion: null,
    installType: null,
    signedIn: null,
    protocolVersion: null,
    lastCommand: null,
    error: null,
    prefs: {
      schema: 1,
      prompt: null,
      autoUpdate: true,
      askWhenNotReady: true,
      mode: null,
      browser: null,
      connectedAt: null,
      cardSnoozedUntil: null,
      updateToastSnoozedUntil: null,
      updatedAt: ''
    },
    update: null,
    readAt: Date.now(),
    ...overrides
  }
}

beforeEach(() => {
  $webmateBrowsers.set(null)
  $webmateScanning.set(false)
  $webmateGuide.set(null)
  $webmateStatus.set(status())
})

afterEach(() => {
  cleanup()
  desktopWindow.agentxDesktop = initialAgentxDesktop
  vi.restoreAllMocks()
})

describe('BrowserStepPanel', () => {
  it('lists supported browsers (default first, unsupported greyed) and offers later / never', () => {
    $webmateBrowsers.set([
      browser({ id: 'edge', name: 'Microsoft Edge', isDefault: true, extensionsUrl: 'edge://extensions' }),
      browser(),
      browser({ id: 'firefox', name: 'Firefox', supported: false, unsupportedReason: 'firefox', profiles: [] })
    ])
    const onFinish = vi.fn()

    render(<BrowserStepPanel leaving={false} onFinish={onFinish} />)

    expect(screen.getByText('Connect your browser')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Microsoft Edge/ })).toBeTruthy()
    expect(screen.getByText('Default')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Google Chrome/ })).toBeTruthy()
    // Firefox is shown, not clickable, with the reason.
    expect(screen.queryByRole('button', { name: /Firefox/ })).toBeNull()
    expect(screen.getByText('Firefox is not supported yet')).toBeTruthy()
    // The third door: Workmate's own window, live now that a Chromium browser exists.
    expect(screen.getByRole('button', { name: /A separate Workmate browser window/ })).toBeTruthy()
    expect(screen.queryByText(/No Chromium-based browser/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(onFinish).toHaveBeenCalledWith('later')
    fireEvent.click(screen.getByRole('button', { name: 'Don’t ask again' }))
    expect(onFinish).toHaveBeenCalledWith('never')
  })

  it('shows one row per profile when a browser has several, and marks the profile that already has WebMate', () => {
    $webmateBrowsers.set([
      browser({
        profiles: [
          {
            dir: 'Default',
            displayName: 'Kiên',
            lastActive: null,
            isLastUsed: true,
            webmate: {
              installed: true,
              path: '/Users/k/.agentx/webmate/AgentX WebMate',
              disabled: false,
              disableReasons: [],
              elsewhere: false
            }
          },
          {
            dir: 'Profile 2',
            displayName: 'Work',
            lastActive: null,
            isLastUsed: false,
            webmate: { installed: false, path: null, disabled: false, disableReasons: [], elsewhere: false }
          }
        ]
      })
    ])

    render(<BrowserStepPanel leaving={false} onFinish={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Kiên/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Google Chrome\s*·\s*Work/ })).toBeTruthy()
    expect(screen.getByText('WebMate added')).toBeTruthy()
  })

  it('says so when no browser was found, and scans on mount when nothing is cached', () => {
    const scan = vi.fn(async () => [])

    desktopWindow.agentxDesktop = { webmate: { scan } } as unknown as Window['agentxDesktop']
    $webmateBrowsers.set([])

    render(<BrowserStepPanel leaving={false} onFinish={vi.fn()} />)

    expect(screen.getByText(/No supported browser was found/)).toBeTruthy()
    // Cached (empty) list → no rescan; a null cache does scan.
    expect(scan).not.toHaveBeenCalled()
    cleanup()
    $webmateBrowsers.set(null)
    render(<BrowserStepPanel leaving={false} onFinish={vi.fn()} />)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Looking for browsers on this computer…')).toBeTruthy()
  })

  it('walks the three steps while waiting, then flips to connected with a Start button', () => {
    const onFinish = vi.fn()

    $webmateBrowsers.set([browser()])
    $webmateGuide.set({
      kind: 'browser',
      browserId: 'chrome',
      browserName: 'Google Chrome',
      profileDir: 'Default',
      profileName: 'Kiên',
      startedAt: Date.now(),
      opened: true,
      navigated: true,
      openError: null,
      folderOpened: true,
      copied: false,
      serverError: null,
      preparing: false
    })

    render(<BrowserStepPanel leaving={false} onFinish={onFinish} />)

    expect(screen.getByText('Three steps in Google Chrome')).toBeTruthy()
    expect(screen.getByText(/Turn on “Developer mode”/)).toBeTruthy()
    expect(screen.getByText('Waiting for WebMate to connect…')).toBeTruthy()
    expect(screen.getByText('/Users/k/.agentx/webmate/AgentX WebMate')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()

    // The extension dials in: the main process pushes a connected status.
    act(() => {
      $webmateStatus.set(
        status({ connected: true, browser: 'Chrome 152', installType: 'workmate', extensionVersion: '1.0.4' })
      )
    })

    expect(screen.getByText('Connected · Chrome 152')).toBeTruthy()
    expect(screen.queryByText('Waiting for WebMate to connect…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(onFinish).toHaveBeenCalledWith('connected')
  })

  it('a developer copy that connects does not count as the Workmate install', () => {
    $webmateGuide.set({
      kind: 'browser',
      browserId: 'chrome',
      browserName: 'Google Chrome',
      profileDir: 'Default',
      profileName: null,
      startedAt: Date.now(),
      opened: true,
      navigated: true,
      openError: null,
      folderOpened: true,
      copied: false,
      serverError: null,
      preparing: false
    })
    $webmateStatus.set(status({ connected: true, browser: 'Chrome 152', installType: 'dev' }))

    render(<BrowserStepPanel leaving={false} onFinish={vi.fn()} />)

    expect(screen.getByText('Waiting for WebMate to connect…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
  })

  it('after two minutes without a hello it lists the usual reasons', () => {
    $webmateGuide.set({
      kind: 'browser',
      browserId: 'edge',
      browserName: 'Microsoft Edge',
      profileDir: null,
      profileName: null,
      startedAt: Date.now() - 130_000,
      opened: false,
      navigated: false,
      openError: 'ENOENT',
      folderOpened: false,
      copied: false,
      serverError: null,
      preparing: false
    })

    render(<BrowserStepPanel leaving={false} onFinish={vi.fn()} />)

    expect(screen.getByText(/WebMate has not connected yet/)).toBeTruthy()
    expect(screen.getByText(/Developer mode is still off/)).toBeTruthy()
    expect(screen.getByText(/Microsoft Edge could not be opened/)).toBeTruthy()
    expect((screen.getByRole('button', { name: /Use a separate window/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('the Workmate window door', () => {
  it('opens the window through the bridge and shows the window steps, connected on the hello', async () => {
    const openWindow = vi.fn(async () => ({
      ok: true,
      error: null,
      window: {
        open: true,
        phase: 'open',
        pid: 1,
        browserId: 'edge',
        browserName: 'Microsoft Edge',
        extensionId: 'x',
        startedAt: Date.now(),
        error: null,
        exitCode: null
      }
    }))

    desktopWindow.agentxDesktop = {
      api: vi.fn(async () => ({
        schema: 1,
        server: { registered: true, enabled: true, command: 'node', args: [], bundled: true },
        connected: false,
        code: null
      })),
      webmate: { openWindow, status: vi.fn(async () => status()), setPrefs: vi.fn(async (p: unknown) => p) }
    } as unknown as Window['agentxDesktop']
    const { $gateway } = await import('@/store/gateway')

    $gateway.set({ request: vi.fn(async () => ({ status: 'reloaded' })) } as never)
    $webmateBrowsers.set([browser({ id: 'edge', name: 'Microsoft Edge', isDefault: true })])
    const onFinish = vi.fn()

    render(<BrowserStepPanel leaving={false} onFinish={onFinish} />)
    fireEvent.click(screen.getByRole('button', { name: /A separate Workmate browser window/ }))

    expect(await screen.findByText(/sign in again to the sites/)).toBeTruthy()
    await vi.waitFor(() => expect(openWindow).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()

    act(() => {
      $webmateStatus.set(status({ connected: true, browser: 'Microsoft Edge 152', installType: 'workmate' }))
    })
    expect(screen.getByText('Connected · Microsoft Edge 152')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(onFinish).toHaveBeenCalledWith('connected')
    $gateway.set(null)
  })

  it('is greyed out with the reason when no Chromium-based browser exists', () => {
    $webmateBrowsers.set([
      browser({ id: 'firefox', name: 'Firefox', supported: false, unsupportedReason: 'firefox', profiles: [] })
    ])

    render(<BrowserStepPanel leaving={false} onFinish={vi.fn()} />)

    expect(
      (screen.getByRole('button', { name: /A separate Workmate browser window/ }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(screen.getByText(/No Chromium-based browser/)).toBeTruthy()
  })
})
