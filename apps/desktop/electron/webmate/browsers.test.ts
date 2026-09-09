import assert from 'node:assert/strict'
import path from 'node:path'

import { describe, test } from 'vitest'

import {
  browserIdFromBundleId,
  browserIdFromDesktopId,
  browserIdFromProgId,
  type BrowserScanIo,
  executableFromCommand,
  expandEnv,
  extensionRecordFromPreferences,
  findInstalledProfile,
  httpsHandlerFromLaunchServices,
  parseLocalState,
  parseRegQueryOutput,
  samePath,
  scanBrowsers,
  versionFromInfoPlist,
  webmateStateFromRecord
} from './browsers'
import { WEBMATE_EXTENSION_ID } from './paths'

interface FakeMachine {
  platform: NodeJS.Platform
  homeDir: string
  env: NodeJS.ProcessEnv
  files: Record<string, string>
  /** `file + ' ' + args.join(' ')` → stdout; a missing key rejects like a failed helper. */
  exec: Record<string, string>
}

function fakeIo(machine: FakeMachine): BrowserScanIo & { execCalls: string[] } {
  const pathModule = machine.platform === 'win32' ? path.win32 : path.posix
  const files = new Map(Object.entries(machine.files))
  const execCalls: string[] = []

  // A directory "exists" when any file lives under it.
  const exists = (p: string) => {
    if (files.has(p)) {
      return true
    }

    const prefix = p.endsWith(pathModule.sep) ? p : p + pathModule.sep

    for (const key of files.keys()) {
      if (key.startsWith(prefix)) {
        return true
      }
    }

    return false
  }

  return {
    platform: machine.platform,
    homeDir: machine.homeDir,
    env: machine.env,
    pathModule,
    exists,
    readText: p => files.get(p) ?? null,
    execCalls,
    exec: async (file, args) => {
      const key = `${file} ${args.join(' ')}`

      execCalls.push(key)

      if (key in machine.exec) {
        return machine.exec[key]
      }

      throw new Error(`exec failed: ${key}`)
    }
  }
}

const INSTALL_MAC = '/Users/k/.agentx/webmate/AgentX WebMate'
const INSTALL_WIN = 'C:\\Users\\k\\AppData\\Local\\agentx\\webmate\\AgentX WebMate'

const securePrefs = (settings: Record<string, unknown>) =>
  JSON.stringify({ extensions: { settings }, protection: { macs: {} } })

const infoPlist = (version: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`

describe('pure helpers', () => {
  test('parseRegQueryOutput reads named and default values', () => {
    const out = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
      '    ProgId    REG_SZ    ChromeHTML',
      '    Hash    REG_SZ    abc=',
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
      '    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      '    Path    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application',
      ''
    ].join('\r\n')

    const rows = parseRegQueryOutput(out)

    assert.deepEqual(
      rows.map(r => [r.name, r.value]),
      [
        ['ProgId', 'ChromeHTML'],
        ['Hash', 'abc='],
        ['(Default)', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
        ['Path', 'C:\\Program Files\\Google\\Chrome\\Application']
      ]
    )
  })

  test('executableFromCommand strips the quoted program from a shell open command', () => {
    assert.equal(
      executableFromCommand('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -- "%1"'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    )
    assert.equal(executableFromCommand('C:\\Tools\\brave.exe --flag'), 'C:\\Tools\\brave.exe')
    assert.equal(executableFromCommand('   '), null)
  })

  test('default-browser identifiers map to browser ids', () => {
    assert.equal(browserIdFromProgId('ChromeHTML'), 'chrome')
    assert.equal(browserIdFromProgId('MSEdgeHTM'), 'edge')
    assert.equal(browserIdFromProgId('BraveHTML'), 'brave')
    assert.equal(browserIdFromProgId('VivaldiHTM.ABCDEF'), 'vivaldi')
    assert.equal(browserIdFromProgId('FirefoxURL-308046B0AF4A39CB'), 'firefox')
    assert.equal(browserIdFromProgId('Unknown'), null)
    assert.equal(browserIdFromBundleId('com.microsoft.edgemac'), 'edge')
    assert.equal(browserIdFromBundleId('COM.GOOGLE.CHROME'), 'chrome')
    assert.equal(browserIdFromBundleId(''), null)
    assert.equal(browserIdFromDesktopId('google-chrome.desktop'), 'chrome')
    assert.equal(browserIdFromDesktopId('brave-browser.desktop'), 'brave')
  })

  test('httpsHandlerFromLaunchServices prefers https and falls back to http', () => {
    const json = JSON.stringify({
      LSHandlers: [
        { LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'com.google.chrome' },
        { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.microsoft.edgemac' }
      ]
    })

    assert.equal(httpsHandlerFromLaunchServices(json), 'com.microsoft.edgemac')
    assert.equal(
      httpsHandlerFromLaunchServices(
        JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'com.brave.browser' }] })
      ),
      'com.brave.browser'
    )
    assert.equal(httpsHandlerFromLaunchServices('{}'), null)
    assert.equal(httpsHandlerFromLaunchServices('not json'), null)
  })

  test('versionFromInfoPlist reads XML and refuses binary plists', () => {
    assert.equal(versionFromInfoPlist(infoPlist('152.0.7977.83')), '152.0.7977.83')
    assert.equal(versionFromInfoPlist('bplist00...'), null)
    assert.equal(versionFromInfoPlist(null), null)
  })

  test('expandEnv resolves %VAR% and ~, and reports a missing variable as null', () => {
    assert.equal(
      expandEnv('%LOCALAPPDATA%\\Google', { LOCALAPPDATA: 'C:\\Users\\k\\AppData\\Local' }, 'C:\\Users\\k'),
      'C:\\Users\\k\\AppData\\Local\\Google'
    )
    assert.equal(expandEnv('%ProgramFiles(x86)%\\Edge', {}, 'C:\\Users\\k'), null)
    assert.equal(expandEnv('~/Library', {}, '/Users/k'), '/Users/k/Library')
  })

  test('samePath ignores case and trailing separators where the filesystem does', () => {
    assert.equal(samePath('C:\\A\\AgentX WebMate\\', 'c:\\a\\agentx webmate', path.win32, 'win32'), true)
    assert.equal(
      samePath(
        '/Users/k/.agentx/webmate/AgentX WebMate',
        '/Users/k/.agentx/webmate/agentx webmate/',
        path.posix,
        'darwin'
      ),
      true
    )
    assert.equal(samePath('/a/b', '/a/B', path.posix, 'linux'), false)
  })

  test('parseLocalState reads the profile cache and the last-used profile', () => {
    const parsed = parseLocalState(
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: 'Kiên', gaia_name: 'Kiên Trung', is_using_default_name: false, active_time: 1787574339.5 },
            'Profile 2': { name: 'Profile 2', gaia_name: 'Work Me', is_using_default_name: true }
          },
          last_active_profiles: ['Profile 2']
        }
      })
    )

    assert.equal(parsed.lastUsed, 'Profile 2')
    assert.deepEqual(
      parsed.entries.map(e => [e.dir, e.name, e.gaiaName, e.usingDefaultName, e.activeTime]),
      [
        ['Default', 'Kiên', 'Kiên Trung', false, 1787574339.5],
        ['Profile 2', 'Profile 2', 'Work Me', true, null]
      ]
    )
    assert.deepEqual(parseLocalState('garbage'), { lastUsed: null, entries: [] })
  })

  test('webmateStateFromRecord tells installed, disabled, elsewhere and store installs apart', () => {
    const ours = { location: 4, path: INSTALL_MAC }

    assert.deepEqual(webmateStateFromRecord(ours, INSTALL_MAC, path.posix, 'darwin'), {
      installed: true,
      path: INSTALL_MAC,
      disabled: false,
      disableReasons: [],
      elsewhere: false
    })

    // Chrome ≥ 130: a list of reasons. Older: a bitmask or state 0.
    assert.equal(
      webmateStateFromRecord({ ...ours, disable_reasons: [1] }, INSTALL_MAC, path.posix, 'darwin').disabled,
      true
    )
    assert.equal(
      webmateStateFromRecord({ ...ours, disable_reasons: 1 }, INSTALL_MAC, path.posix, 'darwin').disabled,
      true
    )
    assert.equal(
      webmateStateFromRecord({ ...ours, disable_reasons: [], state: 0 }, INSTALL_MAC, path.posix, 'darwin').disabled,
      true
    )
    assert.equal(
      webmateStateFromRecord({ ...ours, disable_reasons: [] }, INSTALL_MAC, path.posix, 'darwin').disabled,
      false
    )

    const dev = webmateStateFromRecord(
      { location: 4, path: '/Users/k/Desktop/AgentX-WebMate/brand-dist/chrome' },
      INSTALL_MAC,
      path.posix,
      'darwin'
    )

    assert.equal(dev.installed, false)
    assert.equal(dev.elsewhere, true)

    const store = webmateStateFromRecord({ location: 1, path: 'pfad/1.0.4_0' }, INSTALL_MAC, path.posix, 'darwin')

    assert.equal(store.installed, false)
    assert.equal(store.elsewhere, true)
    assert.equal(webmateStateFromRecord(null, INSTALL_MAC, path.posix, 'darwin').installed, false)

    // Windows: Chrome writes backslashes; our path came from path.join too.
    assert.equal(
      webmateStateFromRecord({ location: 4, path: INSTALL_WIN.toUpperCase() }, INSTALL_WIN, path.win32, 'win32')
        .installed,
      true
    )
  })

  test('extensionRecordFromPreferences distinguishes "not present" from "could not parse"', () => {
    assert.deepEqual(extensionRecordFromPreferences(securePrefs({}), WEBMATE_EXTENSION_ID), {
      ok: true,
      record: undefined
    })
    assert.equal(extensionRecordFromPreferences('{"extensions": {"settings": {', WEBMATE_EXTENSION_ID).ok, false)
    assert.equal(extensionRecordFromPreferences(null, WEBMATE_EXTENSION_ID).ok, false)
  })
})

describe('scanBrowsers on macOS', () => {
  const home = '/Users/k'
  const chromeApp = '/Applications/Google Chrome.app'
  const edgeApp = '/Applications/Microsoft Edge.app'
  const chromeData = `${home}/Library/Application Support/Google/Chrome`
  const edgeData = `${home}/Library/Application Support/Microsoft Edge`
  const plist = `${home}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`

  const machine = (): FakeMachine => ({
    platform: 'darwin',
    homeDir: home,
    env: {},
    files: {
      [`${chromeApp}/Contents/Info.plist`]: infoPlist('152.0.7977.83'),
      [`${edgeApp}/Contents/Info.plist`]: 'bplist00binary',
      '/Applications/Safari.app/Contents/Info.plist': infoPlist('19.0'),
      [`${home}/Applications/Firefox.app/Contents/Info.plist`]: infoPlist('143.0'),
      [`${chromeData}/Local State`]: JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: 'Kiên', active_time: 1787574339.59, is_using_default_name: false },
            'Profile 2': {
              name: 'Person 2',
              gaia_name: 'Work Kiên',
              is_using_default_name: true,
              active_time: 1787000000
            }
          },
          last_active_profiles: ['Default']
        }
      }),
      [`${chromeData}/Default/Secure Preferences`]: securePrefs({
        [WEBMATE_EXTENSION_ID]: { location: 4, path: INSTALL_MAC, disable_reasons: [] },
        other: { location: 5, path: 'x' }
      }),
      [`${chromeData}/SingletonLock`]: 'kien-mbp-4242',
      [`${chromeData}/Profile 2/Secure Preferences`]: securePrefs({
        [WEBMATE_EXTENSION_ID]: {
          location: 4,
          path: '/Users/k/Desktop/AgentX-WebMate/brand-dist/chrome',
          disable_reasons: [1]
        }
      }),
      // Edge has run but its Local State is being rewritten — profiles fall back to Default.
      [`${edgeData}/Default/Preferences`]: securePrefs({}),
      [plist]: 'bplist'
    },
    exec: {
      [`plutil -convert json -o - ${plist}`]: JSON.stringify({
        LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.microsoft.edgemac' }]
      }),
      [`plutil -extract CFBundleShortVersionString raw -o - ${edgeApp}/Contents/Info.plist`]: '152.0.4191.66\n'
    }
  })

  test('finds installed browsers, their profiles and the WebMate state, default first', async () => {
    const io = fakeIo(machine())
    const browsers = await scanBrowsers(INSTALL_MAC, io)

    assert.deepEqual(
      browsers.map(b => [b.id, b.isDefault, b.supported]),
      [
        ['edge', true, true],
        ['chrome', false, true],
        ['firefox', false, false],
        ['safari', false, false]
      ]
    )

    const chrome = browsers.find(b => b.id === 'chrome')!

    assert.equal(chrome.version, '152.0.7977.83')
    assert.equal(chrome.appPath, chromeApp)
    assert.equal(chrome.executable, `${chromeApp}/Contents/MacOS/Google Chrome`)
    assert.equal(chrome.dataDir, chromeData)
    assert.equal(chrome.extensionsUrl, 'chrome://extensions')
    assert.deepEqual(
      chrome.profiles.map(p => [
        p.dir,
        p.displayName,
        p.isLastUsed,
        p.webmate.installed,
        p.webmate.disabled,
        p.webmate.elsewhere
      ]),
      [
        ['Default', 'Kiên', true, true, false, false],
        ['Profile 2', 'Work Kiên', false, false, true, true]
      ]
    )
    assert.equal(chrome.profiles[0].lastActive, 1787574339590)
    // Chrome holds its SingletonLock; Edge (ran before, not now) does not.
    assert.equal(chrome.running, true)

    const edge = browsers.find(b => b.id === 'edge')!

    assert.equal(edge.version, '152.0.4191.66')
    assert.equal(edge.extensionsUrl, 'edge://extensions')
    assert.equal(edge.running, false)
    assert.deepEqual(
      edge.profiles.map(p => [p.dir, p.displayName, p.webmate.installed]),
      [['Default', 'Default', false]]
    )

    const firefox = browsers.find(b => b.id === 'firefox')!

    assert.equal(firefox.unsupportedReason, 'firefox')
    assert.equal(firefox.appPath, `${home}/Applications/Firefox.app`)
    assert.deepEqual(firefox.profiles, [])

    assert.equal(findInstalledProfile(browsers)?.profile.dir, 'Default')
    assert.equal(findInstalledProfile(browsers)?.browser.id, 'chrome')
  })

  test('no LaunchServices https handler means Safari is the default', async () => {
    const m = machine()

    delete m.files[plist]
    const browsers = await scanBrowsers(INSTALL_MAC, fakeIo(m))

    assert.equal(browsers.find(b => b.id === 'safari')?.isDefault, true)
    assert.equal(browsers.find(b => b.id === 'edge')?.isDefault, false)
  })

  test('a browser that never ran has no data dir and no profiles', async () => {
    const m = machine()

    for (const key of Object.keys(m.files)) {
      if (key.startsWith(edgeData)) {
        delete m.files[key]
      }
    }

    const edge = (await scanBrowsers(INSTALL_MAC, fakeIo(m))).find(b => b.id === 'edge')!

    assert.equal(edge.dataDir, null)
    assert.equal(edge.running, null)
    assert.deepEqual(edge.profiles, [])
  })
})

describe('scanBrowsers on Windows', () => {
  const home = 'C:\\Users\\k'
  const local = 'C:\\Users\\k\\AppData\\Local'
  const chromeExe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const braveExe = `${local}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
  const chromeData = `${local}\\Google\\Chrome\\User Data`
  const braveData = `${local}\\BraveSoftware\\Brave-Browser\\User Data`

  const reg = (key: string, name: string, value: string) => `\r\n${key}\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`

  const machine = (): FakeMachine => ({
    platform: 'win32',
    homeDir: home,
    env: {
      LOCALAPPDATA: local,
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      APPDATA: `${home}\\AppData\\Roaming`
    },
    files: {
      [chromeExe]: 'MZ',
      [braveExe]: 'MZ',
      [`${chromeData}\\Local State`]: JSON.stringify({
        profile: { info_cache: { Default: { name: 'Person 1' } }, last_used: 'Default' }
      }),
      [`${chromeData}\\Default\\Secure Preferences`]: securePrefs({
        [WEBMATE_EXTENSION_ID]: { location: 4, path: 'c:\\users\\k\\appdata\\local\\agentx\\webmate\\AgentX WebMate' }
      }),
      [`${braveData}\\Default\\Secure Preferences`]: securePrefs({}),
      [`${braveData}\\lockfile`]: ''
    },
    exec: {
      'reg query HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice /v ProgId':
        reg('HKEY', 'ProgId', 'BraveHTML'),
      'reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe /ve': reg(
        'HKEY',
        '(Default)',
        chromeExe
      ),
      'reg query HKCU\\Software\\Google\\Chrome\\BLBeacon /v version': reg('HKEY', 'version', '152.0.7977.83')
    }
  })

  test('reads App Paths, falls back to default folders, and matches the extension path case-insensitively', async () => {
    const io = fakeIo(machine())
    const browsers = await scanBrowsers(INSTALL_WIN, io)

    assert.deepEqual(
      browsers.map(b => [b.id, b.isDefault]),
      [
        ['brave', true],
        ['chrome', false]
      ]
    )

    const chrome = browsers.find(b => b.id === 'chrome')!

    assert.equal(chrome.executable, chromeExe)
    assert.equal(chrome.version, '152.0.7977.83')
    assert.equal(chrome.appPath, null)
    assert.equal(chrome.dataDir, chromeData)
    assert.deepEqual(
      chrome.profiles.map(p => [p.dir, p.displayName, p.isLastUsed, p.webmate.installed]),
      [['Default', 'Person 1', true, true]]
    )

    const brave = browsers.find(b => b.id === 'brave')!

    // No App Paths key and no BLBeacon: found through the default install dirs, version unknown.
    assert.equal(brave.executable, braveExe)
    assert.equal(brave.version, null)
    assert.equal(brave.running, true)
    assert.equal(chrome.running, false)
    assert.deepEqual(
      brave.profiles.map(p => [p.dir, p.webmate.installed]),
      [['Default', false]]
    )

    // Registry misses never surface as errors.
    assert.ok(io.execCalls.some(call => call.includes('App Paths\\msedge.exe')))
  })

  test('Edge found through StartMenuInternet when App Paths is missing', async () => {
    const m = machine()
    const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

    m.files[edgeExe] = 'MZ'
    m.exec['reg query HKLM\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge\\shell\\open\\command /ve'] = reg(
      'HKEY',
      '(Default)',
      `"${edgeExe}"`
    )
    const edge = (await scanBrowsers(INSTALL_WIN, fakeIo(m))).find(b => b.id === 'edge')

    assert.equal(edge?.executable, edgeExe)
    assert.equal(edge?.extensionsUrl, 'edge://extensions')
  })
})
