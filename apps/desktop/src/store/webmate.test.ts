import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopWebmateBrowser,
  DesktopWebmateConnection,
  DesktopWebmatePrefs,
  DesktopWebmateSignInOutcome,
  DesktopWebmateStatus,
  DesktopWebmateUpdateCheck
} from '@/global'
import * as notifications from '@/store/notifications'
import type { WebmateBackendStatus } from '@/types/hermes'

import {
  $webmateGuide,
  $webmatePrompt,
  $webmateStatus,
  browserIdFromBridgeLabel,
  connectionsForBrowser,
  connectionsNotSignedIn,
  dismissWebmatePrompt,
  ensureWebmateServer,
  maybeNotifyWebmateUpdate,
  reportWebmateToolCode,
  reportWebmateToolPayload,
  resetWebmatePromptSession,
  signInWebmate,
  startWebmateGuide,
  webmateCodeFromToolPayload,
  webmateConnections,
  webmateReadiness,
  webmateSignInOutcomeCopy
} from './webmate'

const desktopWindow = window as unknown as { agentxDesktop?: Window['agentxDesktop'] }
const initialAgentxDesktop = desktopWindow.agentxDesktop

function prefs(overrides: Partial<DesktopWebmatePrefs> = {}): DesktopWebmatePrefs {
  return {
    schema: 1,
    prompt: null,
    autoUpdate: true,
    askWhenNotReady: true,
    mode: null,
    browser: null,
    connectedAt: null,
    cardSnoozedUntil: null,
    updateToastSnoozedUntil: null,
      ssoAutoSignIn: true,
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...overrides
  }
}

function status(overrides: Partial<DesktopWebmateStatus> = {}): DesktopWebmateStatus {
  return {
    paths: {
      root: '/r',
      installDir: '/r/AgentX WebMate',
      workmateJson: '/r/AgentX WebMate/workmate.json',
      pairingFile: '/r/pairing.json',
      stateFile: '/r/state.json',
      commandsDir: '/r/commands',
      versionsDir: '/r/versions',
      prevDir: '/r/versions/prev',
      updateCheckFile: '/r/update-check.json',
      profileDir: '/r/profile'
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
    instanceId: null,
    connections: [],
    lastCommand: null,
    error: null,
    prefs: prefs(),
    update: null,
    readAt: Date.now(),
    ...overrides
  }
}

function backend(overrides: Partial<WebmateBackendStatus> = {}): WebmateBackendStatus {
  return {
    schema: 1,
    server: { registered: true, enabled: true, command: 'node', args: [], bundled: true },
    connected: false,
    code: null,
    ...overrides
  }
}

function browser(overrides: Partial<DesktopWebmateBrowser> = {}): DesktopWebmateBrowser {
  return {
    id: 'chrome',
    name: 'Google Chrome',
    executable: '/x',
    appPath: null,
    version: '152',
    isDefault: true,
    supported: true,
    unsupportedReason: null,
    dataDir: '/d',
    extensionsUrl: 'chrome://extensions',
    singleProfile: false,
    running: true,
    profiles: [],
    ...overrides
  }
}

const profile = (installed: boolean, disabled = false) => ({
  dir: 'Default',
  displayName: 'Kiên',
  lastActive: null,
  isLastUsed: true,
  webmate: {
    installed,
    path: installed ? '/r/AgentX WebMate' : null,
    disabled,
    disableReasons: disabled ? [1] : [],
    elsewhere: false
  }
})

beforeEach(() => {
  resetWebmatePromptSession()
  $webmateStatus.set(null)
  $webmateGuide.set(null)
  notifications.clearNotifications()
})

afterEach(() => {
  desktopWindow.agentxDesktop = initialAgentxDesktop
  vi.restoreAllMocks()
})

describe('webmateCodeFromToolPayload', () => {
  it('finds the code in the wrapped error, the raw text and structuredContent — for webmate tools only', () => {
    expect(
      webmateCodeFromToolPayload({
        name: 'webmate_run',
        result: { error: 'WEBMATE_NOT_CONNECTED: no browser attached' }
      })
    ).toBe('WEBMATE_NOT_CONNECTED')
    expect(
      webmateCodeFromToolPayload({ name: 'mcp_webmate_webmate_status', result: 'WEBMATE_NOT_SIGNED_IN: sign in first' })
    ).toBe('WEBMATE_NOT_SIGNED_IN')
    expect(
      webmateCodeFromToolPayload({
        name: 'webmate_extract',
        result: { result: 'failed', structuredContent: { code: 'WEBMATE_OUTDATED' } }
      })
    ).toBe('WEBMATE_OUTDATED')
    expect(webmateCodeFromToolPayload({ name: 'webmate_run', result: { result: 'Done. Page read.' } })).toBeNull()
    // Another tool quoting the code is not a WebMate failure.
    expect(webmateCodeFromToolPayload({ name: 'terminal', result: { error: 'WEBMATE_DISABLED' } })).toBeNull()
    expect(webmateCodeFromToolPayload(null)).toBeNull()
  })
})

describe('browserIdFromBridgeLabel', () => {
  it('maps the userAgentData brand labels the extension sends', () => {
    expect(browserIdFromBridgeLabel('Chrome 152')).toBe('chrome')
    expect(browserIdFromBridgeLabel('Microsoft Edge 152')).toBe('edge')
    expect(browserIdFromBridgeLabel('Brave 152')).toBe('brave')
    expect(browserIdFromBridgeLabel('Chromium 152')).toBe('chromium')
    expect(browserIdFromBridgeLabel(null)).toBeNull()
  })
})

describe('webmateReadiness', () => {
  it('reports off before anything else', () => {
    expect(
      webmateReadiness({
        status: status({ connected: true }),
        backend: backend({ server: { registered: true, enabled: false, command: null, args: [], bundled: true } })
      })
    ).toBe('off')
    expect(
      webmateReadiness({
        status: status(),
        backend: backend({ server: { registered: false, enabled: false, command: null, args: [], bundled: false } })
      })
    ).toBe('off')
  })

  it('walks the overall states: not installed → not connected → outdated → not signed in → ready', () => {
    expect(webmateReadiness({ status: status({ installedVersion: null }), backend: backend() })).toBe('notInstalled')
    expect(webmateReadiness({ status: status(), backend: backend() })).toBe('installedNotConnected')
    expect(
      webmateReadiness({
        status: status({
          connected: true,
          browser: 'Chrome 152',
          protocolVersion: 2,
          update: {
            checkedAt: null,
            ok: true,
            error: null,
            feedVersion: '1.0.5',
            available: false,
            blockedByMinWorkmate: false,
            belowMinProtocol: true,
            pendingVersion: null,
            failedVersions: [],
            notes: {},
            minProtocol: 3
          }
        }),
        backend: backend()
      })
    ).toBe('outdated')
    expect(
      webmateReadiness({
        status: status({ connected: true, browser: 'Chrome 152', signedIn: false }),
        backend: backend()
      })
    ).toBe('notSignedIn')
    expect(
      webmateReadiness({
        status: status({ connected: true, browser: 'Chrome 152', signedIn: true }),
        backend: backend()
      })
    ).toBe('ready')
    // Unknown backend (unreachable) never paints a false "off".
    expect(
      webmateReadiness({ status: status({ connected: true, browser: 'Chrome 152', signedIn: true }), backend: null })
    ).toBe('ready')
  })

  it('tells a closed browser from a disabled extension per profile', () => {
    const chrome = browser({ running: false })

    expect(webmateReadiness({ status: status(), backend: backend(), browser: chrome, profile: profile(false) })).toBe(
      'notInstalled'
    )
    expect(webmateReadiness({ status: status(), backend: backend(), browser: chrome, profile: profile(true) })).toBe(
      'installedClosed'
    )
    expect(
      webmateReadiness({
        status: status(),
        backend: backend(),
        browser: browser({ running: true }),
        profile: profile(true)
      })
    ).toBe('installedNotConnected')
    expect(
      webmateReadiness({
        status: status(),
        backend: backend(),
        browser: browser({ running: true }),
        profile: profile(true, true)
      })
    ).toBe('installedDisabled')
  })

  it('attributes a connection to the browser the bridge names', () => {
    const connected = status({ connected: true, browser: 'Microsoft Edge 152', signedIn: true })

    expect(
      webmateReadiness({
        status: connected,
        backend: backend(),
        browser: browser({ id: 'edge', name: 'Microsoft Edge' }),
        profile: profile(true)
      })
    ).toBe('ready')
    expect(
      webmateReadiness({
        status: connected,
        backend: backend(),
        browser: browser({ id: 'chrome', running: true }),
        profile: profile(true)
      })
    ).toBe('installedNotConnected')
  })
})

const connection = (overrides: Partial<DesktopWebmateConnection> = {}): DesktopWebmateConnection => ({
  instanceId: 'inst-1',
  browser: 'Chrome 152',
  extensionVersion: '1.0.5',
  installType: 'workmate',
  signedIn: true,
  protocolVersion: 3,
  lastHelloAt: null,
  paired: true,
  active: true,
  ...overrides
})

describe('several browsers at once (phase 4)', () => {
  it('lists the server’s connections, or synthesises one from the older fields', () => {
    expect(webmateConnections(status())).toEqual([])
    expect(webmateConnections(status({ connected: true, browser: 'Edge 152', signedIn: false, installType: 'workmate' }))).toEqual([
      expect.objectContaining({ instanceId: '', browser: 'Edge 152', signedIn: false, active: true })
    ])

    const two = status({
      connected: true,
      browser: 'Chrome 152',
      connections: [connection({ instanceId: 'a', signedIn: false, active: false }), connection({ instanceId: 'b' })]
    })

    expect(webmateConnections(two).map(c => c.instanceId)).toEqual(['a', 'b'])
    expect(connectionsNotSignedIn(two).map(c => c.instanceId)).toEqual(['a'])
    expect(connectionsForBrowser(two, 'chrome').map(c => c.instanceId)).toEqual(['b', 'a'])
    expect(connectionsForBrowser(two, 'edge')).toEqual([])
  })

  it('a browser with one signed-in copy is ready even while another copy in it is not', () => {
    const chrome = browser({ profiles: [profile(true)] })

    const both = status({
      connected: true,
      browser: 'Chrome 152',
      signedIn: false,
      installType: 'workmate',
      connections: [
        connection({ instanceId: 'own', signedIn: false, active: false }),
        connection({ instanceId: 'window', signedIn: true })
      ]
    })

    expect(webmateReadiness({ status: both, backend: backend(), browser: chrome, profile: chrome.profiles[0] })).toBe('ready')
    expect(webmateReadiness({ status: both, backend: backend() })).toBe('ready')

    const nobody = status({
      connected: true,
      browser: 'Chrome 152',
      signedIn: false,
      installType: 'workmate',
      connections: [connection({ instanceId: 'own', signedIn: false })]
    })

    expect(webmateReadiness({ status: nobody, backend: backend(), browser: chrome, profile: chrome.profiles[0] })).toBe('notSignedIn')
    // A browser the server does not list is "not connected" even while another browser is.
    const edge = browser({ id: 'edge', name: 'Microsoft Edge', profiles: [profile(true)] })

    expect(webmateReadiness({ status: nobody, backend: backend(), browser: edge, profile: edge.profiles[0] })).toBe(
      'installedNotConnected'
    )
  })

  it('turns a sign-in outcome into the one toast that matters', () => {
    const outcome = (result: Partial<NonNullable<DesktopWebmateSignInOutcome['result']>> | null, extra = {}) => ({
      ok: true,
      sent: true,
      commandId: 'c',
      result: result ? { id: 'c', action: 'auth_open', ok: true, startedAt: '', finishedAt: '', ...result } : null,
      error: null,
      ...extra
    })

    expect(webmateSignInOutcomeCopy(outcome(null, { sent: false }))).toEqual({
      kind: 'warning',
      message: 'WebMate is not connected, so there is nothing to sign in.'
    })
    expect(webmateSignInOutcomeCopy(outcome(null))?.message).toBe('WebMate did not answer in time.')
    expect(
      webmateSignInOutcomeCopy(
        outcome({ results: [{ instanceId: 'a', browser: 'Chrome 152', ok: true, outcome: 'signed-in', signedIn: true, email: 'kien@example.test' }] })
      )
    ).toEqual({ kind: 'success', message: 'WebMate is signed in as kien@example.test.' })
    expect(
      webmateSignInOutcomeCopy(
        outcome({ results: [{ instanceId: 'a', browser: null, ok: true, outcome: 'login-required', signedIn: false }] })
      )?.kind
    ).toBe('info')
    expect(
      webmateSignInOutcomeCopy(
        outcome({ ok: false, results: [{ instanceId: 'a', browser: null, ok: false, outcome: 'error', signedIn: false, message: 'offline' }] }, { ok: false })
      )
    ).toEqual({ kind: 'error', message: 'Could not sign in WebMate: offline' })
    expect(webmateSignInOutcomeCopy(outcome({ results: [] }))?.message).toBe('Every connected WebMate is already signed in.')
    expect(
      webmateSignInOutcomeCopy(outcome({ results: [{ instanceId: 'a', browser: null, ok: true, outcome: 'opened', signedIn: false }] }))
    ).toEqual({
      kind: 'info',
      message: 'The AgentX sign-in is open in the browser that has WebMate. Finish it there; Workmate notices on its own.'
    })
  })

  it('signInWebmate asks the bridge and toasts the outcome', async () => {
    const signIn = vi.fn(async () => ({
      ok: true,
      sent: true,
      commandId: 'c1',
      result: {
        id: 'c1',
        action: 'auth_open',
        ok: true,
        startedAt: '',
        finishedAt: '',
        signedIn: true,
        results: [{ instanceId: 'a', browser: 'Chrome 152', ok: true, outcome: 'signed-in', signedIn: true }]
      },
      error: null
    }))

    desktopWindow.agentxDesktop = {
      webmate: { signIn, status: vi.fn(async () => status()) }
    } as unknown as Window['agentxDesktop']

    const outcome = await signInWebmate({ instanceId: 'a' })

    expect(signIn).toHaveBeenCalledWith({ instanceId: 'a' })
    expect(outcome?.ok).toBe(true)
    expect(notifications.$notifications.get().map(n => [n.kind, n.message])).toEqual([['success', 'WebMate is signed in.']])
  })
})

describe('the "wants to use your browser" card', () => {
  it('shows once per session, honours the snooze and the opt-out', () => {
    $webmateStatus.set(status())
    reportWebmateToolCode('WEBMATE_NOT_INSTALLED')
    expect($webmatePrompt.get()?.code).toBe('WEBMATE_NOT_INSTALLED')

    dismissWebmatePrompt('acted')
    reportWebmateToolCode('WEBMATE_NOT_CONNECTED')
    expect($webmatePrompt.get()).toBeNull()

    resetWebmatePromptSession()
    $webmateStatus.set(status({ prefs: prefs({ cardSnoozedUntil: new Date(Date.now() + 60_000).toISOString() }) }))
    reportWebmateToolCode('WEBMATE_NOT_CONNECTED')
    expect($webmatePrompt.get()).toBeNull()

    $webmateStatus.set(status({ prefs: prefs({ askWhenNotReady: false }) }))
    reportWebmateToolCode('WEBMATE_NOT_CONNECTED')
    expect($webmatePrompt.get()).toBeNull()

    $webmateStatus.set(status())
    expect(reportWebmateToolPayload({ name: 'webmate_run', result: { error: 'WEBMATE_DISABLED: off' } })).toBe(
      'WEBMATE_DISABLED'
    )
    expect($webmatePrompt.get()?.code).toBe('WEBMATE_DISABLED')
  })

  it('"not now" snoozes through prefs, "never" turns the card off', async () => {
    const setPrefs = vi.fn(async (patch: Partial<DesktopWebmatePrefs>) => prefs(patch))

    desktopWindow.agentxDesktop = { webmate: { setPrefs } } as unknown as Window['agentxDesktop']
    $webmateStatus.set(status())
    reportWebmateToolCode('WEBMATE_NOT_INSTALLED')

    dismissWebmatePrompt('notNow')
    expect($webmatePrompt.get()).toBeNull()
    expect(setPrefs).toHaveBeenCalledTimes(1)
    expect(typeof setPrefs.mock.calls[0][0].cardSnoozedUntil).toBe('string')

    resetWebmatePromptSession()
    reportWebmateToolCode('WEBMATE_NOT_INSTALLED')
    dismissWebmatePrompt('never')
    expect(setPrefs).toHaveBeenLastCalledWith({ askWhenNotReady: false })
  })
})

describe('maybeNotifyWebmateUpdate', () => {
  const check = (overrides: Partial<DesktopWebmateUpdateCheck> = {}): DesktopWebmateUpdateCheck => ({
    schema: 1,
    checkedAt: '2026-09-09T00:00:00.000Z',
    ok: true,
    error: null,
    feed: {
      version: '1.0.5',
      publishedAt: '2026-09-09T00:00:00.000Z',
      minWorkmate: '0.21.0',
      minProtocol: 3,
      notes: {},
      chrome: { url: 'https://example.com/x.zip', sha256: 'a'.repeat(64), bytes: 1 }
    },
    installedVersion: '1.0.4',
    available: true,
    blockedByMinWorkmate: false,
    belowMinProtocol: false,
    pendingVersion: null,
    failedVersions: [],
    lastApply: null,
    ...overrides
  })

  it('stays quiet while auto-update is on, toasts when it is off, and warns when the update is mandatory', () => {
    $webmateStatus.set(status({ prefs: prefs({ autoUpdate: true }) }))
    maybeNotifyWebmateUpdate(check())
    expect(notifications.$notifications.get()).toHaveLength(0)

    $webmateStatus.set(status({ prefs: prefs({ autoUpdate: false }) }))
    maybeNotifyWebmateUpdate(check())
    expect(notifications.$notifications.get().map(n => n.id)).toEqual(['webmate-update-available'])

    notifications.clearNotifications()
    $webmateStatus.set(
      status({
        prefs: prefs({ autoUpdate: false, updateToastSnoozedUntil: new Date(Date.now() + 60_000).toISOString() })
      })
    )
    maybeNotifyWebmateUpdate(check())
    expect(notifications.$notifications.get()).toHaveLength(0)

    maybeNotifyWebmateUpdate(check({ belowMinProtocol: true, available: true }))
    expect(notifications.$notifications.get().map(n => [n.id, n.kind])).toEqual([
      ['webmate-update-required', 'warning']
    ])

    // Resolved on the next check.
    maybeNotifyWebmateUpdate(check({ available: false, belowMinProtocol: false }))
    expect(notifications.$notifications.get()).toHaveLength(0)
  })
})

describe('ensureWebmateServer + startWebmateGuide', () => {
  it('installs the catalog entry when missing, enables it, reloads MCP, then opens the guide', async () => {
    const calls: string[] = []

    const api = vi.fn(async (request: { path: string; method?: string; body?: unknown }) => {
      calls.push(`${request.method ?? 'GET'} ${request.path}`)

      if (request.path === '/api/webmate/status') {
        return backend({ server: { registered: false, enabled: false, command: null, args: [], bundled: false } })
      }

      if (request.path === '/api/mcp/catalog') {
        return { entries: [{ name: 'webmate', installed: false, enabled: false }], diagnostics: [] }
      }

      return { ok: true }
    })

    const openGuide = vi.fn(async () => ({
      ok: true,
      windowOpened: true,
      navigated: true,
      command: 'open …',
      error: null,
      folderOpened: true,
      folderError: null,
      browser: 'Google Chrome'
    }))

    const setPrefs = vi.fn(async (patch: Partial<DesktopWebmatePrefs>) => prefs(patch))

    desktopWindow.agentxDesktop = {
      api,
      webmate: { openGuide, setPrefs, status: async () => status() }
    } as unknown as Window['agentxDesktop']

    const request = vi.fn(async () => ({ status: 'reloaded' }))
    const { $gateway } = await import('@/store/gateway')

    $gateway.set({ request } as never)

    const result = await ensureWebmateServer()

    expect(result).toEqual({ ok: true, error: null })
    expect(calls).toContain('POST /api/mcp/catalog/install')
    expect(calls).toContain('PUT /api/mcp/servers/webmate/enabled')
    expect(calls).toContain('PUT /api/skills/toggle')
    expect(request).toHaveBeenCalledWith('reload.mcp', { confirm: true }, 180_000)

    const guide = await startWebmateGuide(browser(), profile(false))

    expect(guide.opened).toBe(true)
    expect(guide.folderOpened).toBe(true)
    expect(guide.preparing).toBe(false)
    expect(guide.serverError).toBeNull()
    expect(openGuide).toHaveBeenCalledWith({ browserId: 'chrome', profileDir: 'Default' })
    expect($webmateGuide.get()?.browserName).toBe('Google Chrome')

    $gateway.set(null)
  })

  it('reports a gateway that is not up instead of throwing', async () => {
    desktopWindow.agentxDesktop = {
      api: vi.fn(async () => backend()),
      webmate: {}
    } as unknown as Window['agentxDesktop']
    const { $gateway } = await import('@/store/gateway')

    $gateway.set(null)

    const result = await ensureWebmateServer()

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/gateway/)
  })
})
