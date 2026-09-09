import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopWebmateBrowser, DesktopWebmateStatus } from '@/global'
import { $webmateBackend, $webmateBrowsers, $webmateGuide, $webmateStatus, $webmateUpdate } from '@/store/webmate'
import type { WebmateBackendStatus } from '@/types/hermes'

import { BrowserSettings } from './browser-settings'

const desktopWindow = window as unknown as { agentxDesktop?: Window['agentxDesktop'] }
const initialAgentxDesktop = desktopWindow.agentxDesktop

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

function backend(enabled: boolean): WebmateBackendStatus {
  return {
    schema: 1,
    server: { registered: true, enabled, command: 'node', args: [], bundled: true },
    connected: false,
    code: null
  }
}

function browser(overrides: Partial<DesktopWebmateBrowser> = {}): DesktopWebmateBrowser {
  return {
    id: 'chrome',
    name: 'Google Chrome',
    executable: '/x',
    appPath: null,
    version: '152.0.7977.83',
    isDefault: true,
    supported: true,
    unsupportedReason: null,
    dataDir: '/d',
    extensionsUrl: 'chrome://extensions',
    singleProfile: false,
    running: false,
    profiles: [
      {
        dir: 'Default',
        displayName: 'Kiên',
        lastActive: null,
        isLastUsed: true,
        webmate: { installed: true, path: '/Users/k/.agentx/webmate/AgentX WebMate', disabled: false, disableReasons: [], elsewhere: false }
      }
    ],
    ...overrides
  }
}

beforeEach(() => {
  $webmateStatus.set(status())
  $webmateBackend.set(backend(true))
  $webmateBrowsers.set([browser()])
  $webmateGuide.set(null)
  $webmateUpdate.set({ check: null, checking: false, applying: false, progress: null, lastOutcome: null })
  desktopWindow.agentxDesktop = {
    api: vi.fn(async () => backend(true)),
    webmate: {
      status: vi.fn(async () => status()),
      scan: vi.fn(async () => [browser()]),
      setPrefs: vi.fn(async (patch: Record<string, unknown>) => ({ ...status().prefs, ...patch })),
      checkUpdate: vi.fn(async () => null)
    }
  } as unknown as Window['agentxDesktop']
})

afterEach(() => {
  cleanup()
  desktopWindow.agentxDesktop = initialAgentxDesktop
  vi.restoreAllMocks()
})

describe('BrowserSettings', () => {
  it('shows the switch, one card per browser profile with its state, the folder and the update card', () => {
    render(<BrowserSettings />)

    expect(screen.getByText('Browser')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'WebMate controls the browser' })).toBeTruthy()
    // Installed in a closed browser: state + hint + Reconnect.
    expect(screen.getByText('Added · browser closed')).toBeTruthy()
    expect(screen.getByText('Open the browser and WebMate connects on its own.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
    expect(screen.getByText('/Users/k/.agentx/webmate/AgentX WebMate')).toBeTruthy()
    expect(screen.getByText('Not checked yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset token' })).toBeTruthy()
  })

  it('reads "Off" everywhere when the server is switched off, and "Ready" when connected and signed in', () => {
    $webmateBackend.set(backend(false))
    render(<BrowserSettings />)
    expect(screen.getAllByText('Off').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    cleanup()

    $webmateBackend.set(backend(true))
    $webmateStatus.set(status({ connected: true, browser: 'Chrome 152', installType: 'workmate', signedIn: true, extensionVersion: '1.0.4' }))
    render(<BrowserSettings />)
    expect(screen.getAllByText('Ready').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Workmate can use this browser.')).toBeTruthy()
  })

  it('offers "Add to this browser" for a profile without WebMate and shows the steps inline once started', async () => {
    $webmateBrowsers.set([
      browser({
        profiles: [
          {
            dir: 'Default',
            displayName: 'Kiên',
            lastActive: null,
            isLastUsed: true,
            webmate: { installed: false, path: null, disabled: false, disableReasons: [], elsewhere: false }
          }
        ]
      })
    ])
    render(<BrowserSettings />)

    expect(screen.getByText('Not added')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add to this browser' })).toBeTruthy()

    act(() => {
      $webmateGuide.set({
        browserId: 'chrome',
        browserName: 'Google Chrome',
        profileDir: 'Default',
        profileName: 'Kiên',
        startedAt: Date.now(),
        opened: true,
        openError: null,
        folderOpened: true,
        copied: false,
        serverError: null,
        preparing: false
      })
    })

    expect(screen.getByText('Three steps in Google Chrome')).toBeTruthy()
    // Settings surface: a single Close instead of later/never/start.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect($webmateGuide.get()).toBeNull()
  })

  it('an outdated attached extension gets the update action', () => {
    $webmateStatus.set(
      status({
        connected: true,
        browser: 'Chrome 152',
        installType: 'workmate',
        protocolVersion: 2,
        update: {
          checkedAt: '2026-09-09T00:00:00.000Z',
          ok: true,
          error: null,
          feedVersion: '1.0.5',
          available: true,
          blockedByMinWorkmate: false,
          belowMinProtocol: true,
          pendingVersion: null,
          failedVersions: [],
          notes: { en: 'Fixes' },
          minProtocol: 3
        }
      })
    )
    render(<BrowserSettings />)

    expect(screen.getAllByText('Connected · old version').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByRole('button', { name: 'Update WebMate' }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('The WebMate in your browser is too old for this Workmate. Update it to use the browser again.')).toBeTruthy()
  })
})
