import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import type { BrowserInfo } from './browsers'
import { defaultPrefs } from './prefs'
import { chooseLoginTarget, chosenBrowserFrom, HINT_COOLDOWN_MS, planAuthHints } from './sso'
import type { WebmateConnection } from './status'

function connection(overrides: Partial<WebmateConnection> = {}): WebmateConnection {
  return {
    instanceId: 'inst-1',
    browser: 'Chrome 152',
    extensionVersion: '1.0.5',
    installType: 'workmate',
    signedIn: false,
    protocolVersion: 3,
    lastHelloAt: '2026-09-09T10:00:00.000Z',
    paired: true,
    active: true,
    ...overrides
  }
}

function browser(overrides: Partial<BrowserInfo> = {}): BrowserInfo {
  return {
    id: 'chrome',
    name: 'Google Chrome',
    executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    appPath: '/Applications/Google Chrome.app',
    version: '152',
    isDefault: true,
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
        webmate: { installed: true, path: null, disabled: false, disableReasons: [], elsewhere: false }
      },
      {
        dir: 'Profile 2',
        displayName: 'Work',
        lastActive: null,
        isLastUsed: false,
        webmate: { installed: false, path: null, disabled: false, disableReasons: [], elsewhere: false }
      }
    ],
    ...overrides
  }
}

const NOW = Date.parse('2026-09-09T10:00:00.000Z')

describe('planAuthHints', () => {
  test('hints every Workmate-installed browser that reports not signed in', () => {
    const decision = planAuthHints(
      [
        connection({ instanceId: 'a' }),
        connection({ instanceId: 'b', signedIn: true }),
        connection({ instanceId: 'c', signedIn: null })
      ],
      defaultPrefs(),
      'kien@example.test',
      new Map(),
      NOW
    )

    assert.deepEqual(decision, { instanceIds: ['a'], reason: null })
  })

  test('leaves developer installs and unknown sign-in states alone', () => {
    const decision = planAuthHints(
      [connection({ instanceId: 'dev', installType: 'dev' }), connection({ instanceId: 'x', signedIn: null })],
      defaultPrefs(),
      'kien@example.test',
      new Map(),
      NOW
    )

    assert.deepEqual(decision, { instanceIds: [], reason: 'nobody-signed-out' })
  })

  test('is quiet when the preference is off or Workmate itself is signed out', () => {
    assert.equal(planAuthHints([connection()], { ssoAutoSignIn: false }, 'k@x', new Map(), NOW).reason, 'disabled')
    assert.equal(planAuthHints([connection()], defaultPrefs(), null, new Map(), NOW).reason, 'no-account')
    assert.equal(planAuthHints([connection()], defaultPrefs(), '', new Map(), NOW).reason, 'no-account')
  })

  test('does not re-hint a browser inside the cooldown, and does again after it', () => {
    const memory = new Map([['inst-1', NOW - 1_000]])

    assert.equal(planAuthHints([connection()], defaultPrefs(), 'k@x', memory, NOW).reason, 'cooling-down')
    assert.deepEqual(planAuthHints([connection()], defaultPrefs(), 'k@x', memory, NOW + HINT_COOLDOWN_MS).instanceIds, [
      'inst-1'
    ])
    // A different instance (a reconnect gets the same id; a new profile a new one) is due at once.
    assert.deepEqual(
      planAuthHints([connection({ instanceId: 'inst-2' })], defaultPrefs(), 'k@x', memory, NOW).instanceIds,
      ['inst-2']
    )
  })
})

describe('chooseLoginTarget', () => {
  const chosen = { id: 'chrome', name: 'Google Chrome', profileDir: 'Default', profileName: 'Kiên' }

  test('the Workmate window when that mode is on and the window is open', () => {
    assert.deepEqual(chooseLoginTarget({ mode: 'window', browser: null }, true, [browser()]), { kind: 'window' })
  })

  test('the chosen browser and profile otherwise', () => {
    const target = chooseLoginTarget({ mode: 'browser', browser: chosen }, false, [browser()])

    assert.equal(target.kind, 'browser')
    assert.equal(target.kind === 'browser' && target.browser.id, 'chrome')
    assert.equal(target.kind === 'browser' && target.profileDir, 'Default')
  })

  test('window mode with the window closed falls back to the chosen browser, then the system', () => {
    const target = chooseLoginTarget({ mode: 'window', browser: chosen }, false, [browser()])

    assert.equal(target.kind, 'browser')
    assert.deepEqual(chooseLoginTarget({ mode: 'window', browser: null }, false, [browser()]), {
      kind: 'system',
      reason: 'window-closed'
    })
  })

  test('the system browser when nothing was chosen or the chosen browser is gone', () => {
    assert.deepEqual(chooseLoginTarget({ mode: null, browser: null }, false, [browser()]), {
      kind: 'system',
      reason: 'no-choice'
    })
    assert.deepEqual(
      chooseLoginTarget({ mode: 'browser', browser: chosen }, false, [browser({ id: 'edge', name: 'Edge' })]),
      {
        kind: 'system',
        reason: 'browser-gone'
      }
    )
    assert.deepEqual(
      chooseLoginTarget({ mode: 'browser', browser: chosen }, false, [browser({ executable: null, appPath: null })]),
      {
        kind: 'system',
        reason: 'browser-gone'
      }
    )
  })

  test('a profile that no longer exists is dropped rather than launched', () => {
    const target = chooseLoginTarget({ mode: 'browser', browser: { ...chosen, profileDir: 'Profile 9' } }, false, [
      browser()
    ])

    assert.equal(target.kind === 'browser' && target.profileDir, null)

    const single = chooseLoginTarget({ mode: 'browser', browser: { ...chosen, id: 'opera' } }, false, [
      browser({ id: 'opera', name: 'Opera', singleProfile: true })
    ])

    assert.equal(single.kind === 'browser' && single.profileDir, null)
  })
})

describe('chosenBrowserFrom', () => {
  test('records the profile name when the directory is known', () => {
    assert.deepEqual(chosenBrowserFrom(browser(), 'Profile 2'), {
      id: 'chrome',
      name: 'Google Chrome',
      profileDir: 'Profile 2',
      profileName: 'Work'
    })
    assert.deepEqual(chosenBrowserFrom(browser(), null), {
      id: 'chrome',
      name: 'Google Chrome',
      profileDir: null,
      profileName: null
    })
    assert.deepEqual(chosenBrowserFrom(browser({ id: 'opera', singleProfile: true, profiles: [] }), 'x'), {
      id: 'opera',
      name: 'Google Chrome',
      profileDir: null,
      profileName: null
    })
  })
})
