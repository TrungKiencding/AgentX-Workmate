/**
 * Which browsers are on this machine, which profiles they have, and whether
 * the WebMate folder Workmate manages is loaded in each one.
 *
 * Read-only by construction (apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.3):
 * the scanner reads the browser's `Local State` and each profile's
 * `Secure Preferences` / `Preferences`, asks the OS which browser owns https
 * links, and never writes a byte into a browser directory. Every I/O call goes
 * through `BrowserScanIo` so the Windows and macOS shapes are both testable on
 * any host; the default io wraps fs + child_process (`plutil`, `reg`).
 *
 * Firefox and Safari are reported with `supported: false` so the picker can
 * say why they are greyed out, instead of silently omitting them.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'

import { WEBMATE_EXTENSION_ID } from './paths'

export type BrowserId = 'chrome' | 'edge' | 'brave' | 'vivaldi' | 'opera' | 'arc' | 'chromium' | 'firefox' | 'safari'

export interface BrowserProfileWebmate {
  /** The Workmate-managed folder is loaded (unpacked, same path). */
  installed: boolean
  /** The folder the browser has loaded for this extension ID, if any. */
  path: string | null
  /** The extension is present but switched off (or blocked). */
  disabled: boolean
  disableReasons: number[]
  /** Loaded unpacked from some other folder (a developer checkout, an old install). */
  elsewhere: boolean
}

export interface BrowserProfile {
  /** Directory name under the browser's data dir, e.g. "Default", "Profile 2". */
  dir: string
  displayName: string
  /** Epoch milliseconds of the profile's last activity, or null. */
  lastActive: number | null
  /** The profile the browser opened last. */
  isLastUsed: boolean
  webmate: BrowserProfileWebmate
}

export interface BrowserInfo {
  id: BrowserId
  name: string
  /** The binary Workmate launches (Windows/Linux) or the app bundle's binary (macOS). */
  executable: string | null
  /** macOS only: the .app bundle, for `open -na`. */
  appPath: string | null
  version: string | null
  isDefault: boolean
  supported: boolean
  unsupportedReason: 'firefox' | 'safari' | null
  /** The browser's user-data directory, or null when it has never run. */
  dataDir: string | null
  /** The URL of the extensions page for this browser. */
  extensionsUrl: string
  /** Opera keeps one profile in the data dir itself; `--profile-directory` does not apply. */
  singleProfile: boolean
  profiles: BrowserProfile[]
}

export interface BrowserScanIo {
  platform: NodeJS.Platform
  homeDir: string
  env: NodeJS.ProcessEnv
  pathModule: typeof nodePath
  exists(path: string): boolean
  readText(path: string): string | null
  /** stdout of a short helper (`plutil`, `reg`, `xdg-settings`). Rejects on failure. */
  exec(file: string, args: string[]): Promise<string>
}

interface BrowserSpec {
  id: BrowserId
  name: string
  supported: boolean
  extensionsUrl: string
  singleProfile?: boolean
  mac: {
    bundleIds: string[]
    appNames: string[]
    binaryName: string
    /** Relative to ~/Library/Application Support. */
    dataDir: string | null
  }
  win: {
    /** Names looked up under `App Paths`. Empty for forks that reuse chrome.exe (Chromium) so they never claim Chrome's entry. */
    exeNames: string[]
    /** Names tried inside `defaultDirs`; defaults to `exeNames`. */
    defaultExeNames?: string[]
    startMenuNames: string[]
    progIdPrefixes: string[]
    /** Relative to %LOCALAPPDATA% unless it starts with %APPDATA%. */
    dataDir: string | null
    beaconKey: string | null
    defaultDirs: string[]
  }
  linux: {
    executables: string[]
    desktopIds: string[]
    /** Relative to ~/.config. */
    dataDir: string | null
  }
}

const CHROME_EXTENSIONS = 'chrome://extensions'

export const BROWSER_SPECS: readonly BrowserSpec[] = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    supported: true,
    extensionsUrl: CHROME_EXTENSIONS,
    mac: { bundleIds: ['com.google.chrome'], appNames: ['Google Chrome'], binaryName: 'Google Chrome', dataDir: 'Google/Chrome' },
    win: {
      exeNames: ['chrome.exe'],
      startMenuNames: ['Google Chrome'],
      progIdPrefixes: ['ChromeHTML'],
      dataDir: 'Google\\Chrome\\User Data',
      beaconKey: 'HKCU\\Software\\Google\\Chrome\\BLBeacon',
      defaultDirs: ['%ProgramFiles%\\Google\\Chrome\\Application', '%ProgramFiles(x86)%\\Google\\Chrome\\Application', '%LOCALAPPDATA%\\Google\\Chrome\\Application']
    },
    linux: { executables: ['google-chrome', 'google-chrome-stable'], desktopIds: ['google-chrome'], dataDir: 'google-chrome' }
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    supported: true,
    extensionsUrl: 'edge://extensions',
    mac: { bundleIds: ['com.microsoft.edgemac'], appNames: ['Microsoft Edge'], binaryName: 'Microsoft Edge', dataDir: 'Microsoft Edge' },
    win: {
      exeNames: ['msedge.exe'],
      startMenuNames: ['Microsoft Edge'],
      progIdPrefixes: ['MSEdgeHTM'],
      dataDir: 'Microsoft\\Edge\\User Data',
      beaconKey: 'HKCU\\Software\\Microsoft\\Edge\\BLBeacon',
      defaultDirs: ['%ProgramFiles(x86)%\\Microsoft\\Edge\\Application', '%ProgramFiles%\\Microsoft\\Edge\\Application']
    },
    linux: { executables: ['microsoft-edge', 'microsoft-edge-stable'], desktopIds: ['microsoft-edge'], dataDir: 'microsoft-edge' }
  },
  {
    id: 'brave',
    name: 'Brave',
    supported: true,
    extensionsUrl: 'brave://extensions',
    mac: { bundleIds: ['com.brave.browser'], appNames: ['Brave Browser'], binaryName: 'Brave Browser', dataDir: 'BraveSoftware/Brave-Browser' },
    win: {
      exeNames: ['brave.exe'],
      startMenuNames: ['Brave'],
      progIdPrefixes: ['BraveHTML'],
      dataDir: 'BraveSoftware\\Brave-Browser\\User Data',
      beaconKey: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\BLBeacon',
      defaultDirs: ['%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application', '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application']
    },
    linux: { executables: ['brave-browser', 'brave'], desktopIds: ['brave-browser'], dataDir: 'BraveSoftware/Brave-Browser' }
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    supported: true,
    extensionsUrl: CHROME_EXTENSIONS,
    mac: { bundleIds: ['com.vivaldi.vivaldi'], appNames: ['Vivaldi'], binaryName: 'Vivaldi', dataDir: 'Vivaldi' },
    win: {
      exeNames: ['vivaldi.exe'],
      startMenuNames: ['Vivaldi'],
      progIdPrefixes: ['VivaldiHTM'],
      dataDir: 'Vivaldi\\User Data',
      beaconKey: null,
      defaultDirs: ['%LOCALAPPDATA%\\Vivaldi\\Application', '%ProgramFiles%\\Vivaldi\\Application']
    },
    linux: { executables: ['vivaldi', 'vivaldi-stable'], desktopIds: ['vivaldi'], dataDir: 'vivaldi' }
  },
  {
    id: 'opera',
    name: 'Opera',
    supported: true,
    extensionsUrl: CHROME_EXTENSIONS,
    singleProfile: true,
    mac: { bundleIds: ['com.operasoftware.opera'], appNames: ['Opera'], binaryName: 'Opera', dataDir: 'com.operasoftware.Opera' },
    win: {
      exeNames: ['opera.exe', 'launcher.exe'],
      startMenuNames: ['Opera', 'OperaStable'],
      progIdPrefixes: ['Opera'],
      dataDir: '%APPDATA%\\Opera Software\\Opera Stable',
      beaconKey: null,
      defaultDirs: ['%LOCALAPPDATA%\\Programs\\Opera', '%ProgramFiles%\\Opera']
    },
    linux: { executables: ['opera'], desktopIds: ['opera'], dataDir: 'opera' }
  },
  {
    id: 'arc',
    name: 'Arc',
    supported: true,
    extensionsUrl: CHROME_EXTENSIONS,
    mac: { bundleIds: ['company.thebrowser.browser'], appNames: ['Arc'], binaryName: 'Arc', dataDir: 'Arc/User Data' },
    win: {
      exeNames: ['Arc.exe'],
      startMenuNames: ['Arc'],
      progIdPrefixes: ['ArcHTML', 'Arc'],
      dataDir: 'Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc\\User Data',
      beaconKey: null,
      defaultDirs: ['%LOCALAPPDATA%\\Microsoft\\WindowsApps']
    },
    linux: { executables: [], desktopIds: [], dataDir: null }
  },
  {
    id: 'chromium',
    name: 'Chromium',
    supported: true,
    extensionsUrl: CHROME_EXTENSIONS,
    mac: { bundleIds: ['org.chromium.chromium'], appNames: ['Chromium'], binaryName: 'Chromium', dataDir: 'Chromium' },
    win: {
      exeNames: [],
      defaultExeNames: ['chrome.exe'],
      startMenuNames: ['Chromium'],
      progIdPrefixes: ['ChromiumHTM'],
      dataDir: 'Chromium\\User Data',
      beaconKey: null,
      defaultDirs: ['%LOCALAPPDATA%\\Chromium\\Application']
    },
    linux: { executables: ['chromium', 'chromium-browser'], desktopIds: ['chromium', 'chromium-browser'], dataDir: 'chromium' }
  },
  {
    id: 'firefox',
    name: 'Firefox',
    supported: false,
    extensionsUrl: 'about:addons',
    mac: { bundleIds: ['org.mozilla.firefox'], appNames: ['Firefox'], binaryName: 'firefox', dataDir: null },
    win: {
      exeNames: ['firefox.exe'],
      startMenuNames: ['FIREFOX.EXE', 'Firefox'],
      progIdPrefixes: ['FirefoxURL', 'FirefoxHTML'],
      dataDir: null,
      beaconKey: null,
      defaultDirs: ['%ProgramFiles%\\Mozilla Firefox', '%ProgramFiles(x86)%\\Mozilla Firefox']
    },
    linux: { executables: ['firefox'], desktopIds: ['firefox'], dataDir: null }
  },
  {
    id: 'safari',
    name: 'Safari',
    supported: false,
    extensionsUrl: '',
    mac: { bundleIds: ['com.apple.safari'], appNames: ['Safari'], binaryName: 'Safari', dataDir: null },
    win: { exeNames: [], startMenuNames: [], progIdPrefixes: [], dataDir: null, beaconKey: null, defaultDirs: [] },
    linux: { executables: [], desktopIds: [], dataDir: null }
  }
]

const ORDER: Record<BrowserId, number> = { chrome: 0, edge: 1, brave: 2, vivaldi: 3, opera: 4, arc: 5, chromium: 6, firefox: 7, safari: 8 }

// ---------------------------------------------------------------------------
// Default io
// ---------------------------------------------------------------------------

export function defaultBrowserScanIo(): BrowserScanIo {
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    env: process.env,
    pathModule: nodePath,
    exists: p => fs.existsSync(p),
    readText: p => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    exec: (file, args) =>
      new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 8_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) {
            reject(error)

            return
          }

          resolve(String(stdout))
        })
      })
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Expand `%VAR%` (Windows) and a leading `~` against the given env/home. */
export function expandEnv(template: string, env: NodeJS.ProcessEnv, homeDir: string): string | null {
  let missing = false

  const expanded = template
    .replace(/%([^%]+)%/g, (_match, name: string) => {
      const value = env[name] ?? env[name.toUpperCase()]

      if (!value) {
        missing = true

        return ''
      }

      return value
    })
    .replace(/^~(?=\/|$)/, homeDir)

  return missing ? null : expanded
}

export interface RegValue {
  name: string
  type: string
  value: string
}

/** Parse `reg query` output into its `name  REG_TYPE  value` rows. */
export function parseRegQueryOutput(stdout: string): RegValue[] {
  const rows: RegValue[] = []

  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = /^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(rawLine) ?? /^\s+(\(Default\))\s+(REG_[A-Z_]+)\s+(.*)$/.exec(rawLine)

    if (match) {
      rows.push({ name: match[1].trim(), type: match[2], value: match[3].trim() })
    }
  }

  return rows
}

/** `"C:\...\chrome.exe" -- "%1"` → `C:\...\chrome.exe`. */
export function executableFromCommand(command: string): string | null {
  const trimmed = command.trim()

  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)

    return end > 1 ? trimmed.slice(1, end) : null
  }

  const exe = /^(.*?\.exe)\b/i.exec(trimmed)

  return exe ? exe[1] : trimmed.split(/\s+/)[0]
}

/** Windows `UserChoice\ProgId` → browser id. */
export function browserIdFromProgId(progId: string | null | undefined): BrowserId | null {
  const value = String(progId || '').trim()

  if (!value) {
    return null
  }

  for (const spec of BROWSER_SPECS) {
    if (spec.win.progIdPrefixes.some(prefix => value.toLowerCase().startsWith(prefix.toLowerCase()))) {
      return spec.id
    }
  }

  return null
}

/** macOS LaunchServices bundle id → browser id. */
export function browserIdFromBundleId(bundleId: string | null | undefined): BrowserId | null {
  const value = String(bundleId || '')
    .trim()
    .toLowerCase()

  if (!value) {
    return null
  }

  return BROWSER_SPECS.find(spec => spec.mac.bundleIds.includes(value))?.id ?? null
}

/** The https handler in `com.apple.launchservices.secure.plist` (converted to JSON), or null. */
export function httpsHandlerFromLaunchServices(json: string): string | null {
  let parsed: unknown

  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }

  const handlers = (parsed as { LSHandlers?: unknown })?.LSHandlers

  if (!Array.isArray(handlers)) {
    return null
  }

  for (const scheme of ['https', 'http']) {
    const handler = handlers.find(
      entry => entry && typeof entry === 'object' && (entry as Record<string, unknown>).LSHandlerURLScheme === scheme
    ) as Record<string, unknown> | undefined

    const role = handler?.LSHandlerRoleAll ?? handler?.LSHandlerRoleViewer

    if (typeof role === 'string' && role) {
      return role
    }
  }

  return null
}

/** `xdg-settings get default-web-browser` → browser id. */
export function browserIdFromDesktopId(desktopId: string | null | undefined): BrowserId | null {
  const value = String(desktopId || '')
    .trim()
    .replace(/\.desktop$/, '')
    .toLowerCase()

  if (!value) {
    return null
  }

  return BROWSER_SPECS.find(spec => spec.linux.desktopIds.some(id => value.startsWith(id)))?.id ?? null
}

/** `CFBundleShortVersionString` from an XML Info.plist; null for a binary plist or a missing key. */
export function versionFromInfoPlist(xml: string | null): string | null {
  if (!xml || xml.startsWith('bplist')) {
    return null
  }

  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)

  return match ? match[1].trim() : null
}

function normalizeForCompare(p: string, pathModule: typeof nodePath, platform: NodeJS.Platform): string {
  let normalized = pathModule.normalize(p)

  while (normalized.length > 1 && (normalized.endsWith(pathModule.sep) || normalized.endsWith('/'))) {
    normalized = normalized.slice(0, -1)
  }

  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized
}

export function samePath(a: string, b: string, pathModule: typeof nodePath, platform: NodeJS.Platform): boolean {
  return normalizeForCompare(a, pathModule, platform) === normalizeForCompare(b, pathModule, platform)
}

const NOT_INSTALLED: BrowserProfileWebmate = { installed: false, path: null, disabled: false, disableReasons: [], elsewhere: false }

/**
 * Interpret one `extensions.settings[<id>]` record. Chrome ≥ 130 stores
 * `disable_reasons` as a list of ints (older builds: a bitmask, or a `state`
 * of 0); `location` 4 is "unpacked".
 */
export function webmateStateFromRecord(
  record: unknown,
  installDir: string,
  pathModule: typeof nodePath,
  platform: NodeJS.Platform
): BrowserProfileWebmate {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return NOT_INSTALLED
  }

  const settings = record as Record<string, unknown>
  const loadedPath = typeof settings.path === 'string' ? settings.path : null
  const unpacked = settings.location === 4

  const reasons = Array.isArray(settings.disable_reasons)
    ? settings.disable_reasons.filter((value): value is number => typeof value === 'number')
    : typeof settings.disable_reasons === 'number' && settings.disable_reasons !== 0
      ? [settings.disable_reasons]
      : []

  const disabled = reasons.length > 0 || settings.state === 0

  if (!unpacked || !loadedPath) {
    // Installed some other way (a store build, a policy) — not the folder we manage.
    return { installed: false, path: loadedPath, disabled, disableReasons: reasons, elsewhere: Boolean(loadedPath) }
  }

  // Chrome stores the folder as an absolute path; on macOS it may keep the
  // path exactly as dropped, so compare normalised, case-insensitive on
  // platforms whose default filesystems are.
  const ours = samePath(loadedPath, installDir, pathModule, platform)

  return { installed: ours, path: loadedPath, disabled, disableReasons: reasons, elsewhere: !ours }
}

/** `extensions.settings[<id>]` from a preferences JSON text, or undefined when absent/unparseable. */
export function extensionRecordFromPreferences(text: string | null, extensionId: string): { ok: boolean; record: unknown } {
  if (!text) {
    return { ok: false, record: undefined }
  }

  try {
    const parsed = JSON.parse(text) as { extensions?: { settings?: Record<string, unknown> } }

    return { ok: true, record: parsed?.extensions?.settings?.[extensionId] }
  } catch {
    return { ok: false, record: undefined }
  }
}

export interface LocalStateProfiles {
  lastUsed: string | null
  entries: Array<{ dir: string; name: string; gaiaName: string | null; usingDefaultName: boolean; activeTime: number | null }>
}

/** `Local State` → the profile cache. Never throws. */
export function parseLocalState(text: string | null): LocalStateProfiles {
  const empty: LocalStateProfiles = { lastUsed: null, entries: [] }

  if (!text) {
    return empty
  }

  let parsed: { profile?: Record<string, unknown> }

  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }

  const profile = parsed?.profile ?? {}
  const cache = profile.info_cache

  const entries: LocalStateProfiles['entries'] = []

  if (cache && typeof cache === 'object' && !Array.isArray(cache)) {
    for (const [dir, raw] of Object.entries(cache as Record<string, unknown>)) {
      const info = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

      entries.push({
        dir,
        name: typeof info.name === 'string' && info.name ? info.name : dir,
        gaiaName: typeof info.gaia_name === 'string' && info.gaia_name ? info.gaia_name : null,
        usingDefaultName: info.is_using_default_name === true,
        activeTime: typeof info.active_time === 'number' ? info.active_time : null
      })
    }
  }

  const lastActive = Array.isArray(profile.last_active_profiles) ? profile.last_active_profiles : []

  const lastUsed =
    typeof profile.last_used === 'string' && profile.last_used
      ? profile.last_used
      : typeof lastActive[0] === 'string'
        ? lastActive[0]
        : null

  return { lastUsed, entries }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

async function safeExec(io: BrowserScanIo, file: string, args: string[]): Promise<string | null> {
  try {
    return await io.exec(file, args)
  } catch {
    return null
  }
}

async function detectDefaultBrowser(io: BrowserScanIo): Promise<BrowserId | null> {
  if (io.platform === 'darwin') {
    const plist = io.pathModule.join(io.homeDir, 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist')

    if (!io.exists(plist)) {
      return 'safari'
    }

    const json = await safeExec(io, 'plutil', ['-convert', 'json', '-o', '-', plist])
    const handler = json ? httpsHandlerFromLaunchServices(json) : null

    // No explicit https handler means the system default: Safari.
    return handler ? browserIdFromBundleId(handler) : 'safari'
  }

  if (io.platform === 'win32') {
    const out = await safeExec(io, 'reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
      '/v',
      'ProgId'
    ])

    const progId = out ? parseRegQueryOutput(out).find(row => row.name.toLowerCase() === 'progid')?.value : null

    return browserIdFromProgId(progId)
  }

  const desktopId = await safeExec(io, 'xdg-settings', ['get', 'default-web-browser'])

  return browserIdFromDesktopId(desktopId)
}

async function regDefaultValue(io: BrowserScanIo, key: string): Promise<string | null> {
  const out = await safeExec(io, 'reg', ['query', key, '/ve'])

  if (!out) {
    return null
  }

  const row = parseRegQueryOutput(out).find(entry => entry.name === '(Default)')

  return row?.value || null
}

async function regValue(io: BrowserScanIo, key: string, name: string): Promise<string | null> {
  const out = await safeExec(io, 'reg', ['query', key, '/v', name])

  if (!out) {
    return null
  }

  return parseRegQueryOutput(out).find(entry => entry.name.toLowerCase() === name.toLowerCase())?.value || null
}

interface Located {
  executable: string | null
  appPath: string | null
  version: string | null
}

async function locateMac(io: BrowserScanIo, spec: BrowserSpec): Promise<Located> {
  const roots = ['/Applications', io.pathModule.join(io.homeDir, 'Applications')]

  for (const root of roots) {
    for (const appName of spec.mac.appNames) {
      const appPath = io.pathModule.join(root, `${appName}.app`)
      const plist = io.pathModule.join(appPath, 'Contents', 'Info.plist')

      if (!io.exists(plist)) {
        continue
      }

      let version = versionFromInfoPlist(io.readText(plist))

      if (!version) {
        version = (await safeExec(io, 'plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]))?.trim() || null
      }

      return { executable: io.pathModule.join(appPath, 'Contents', 'MacOS', spec.mac.binaryName), appPath, version }
    }
  }

  return { executable: null, appPath: null, version: null }
}

async function locateWindows(io: BrowserScanIo, spec: BrowserSpec): Promise<Located> {
  let executable: string | null = null

  for (const exe of spec.win.exeNames) {
    for (const hive of ['HKLM', 'HKCU']) {
      const value = await regDefaultValue(io, `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`)

      if (value && io.exists(value)) {
        executable = value

        break
      }
    }

    if (executable) {
      break
    }
  }

  if (!executable) {
    for (const name of spec.win.startMenuNames) {
      for (const hive of ['HKLM', 'HKCU']) {
        const command = await regDefaultValue(io, `${hive}\\SOFTWARE\\Clients\\StartMenuInternet\\${name}\\shell\\open\\command`)
        const candidate = command ? executableFromCommand(command) : null

        if (candidate && io.exists(candidate)) {
          executable = candidate

          break
        }
      }

      if (executable) {
        break
      }
    }
  }

  if (!executable) {
    for (const dir of spec.win.defaultDirs) {
      const expanded = expandEnv(dir, io.env, io.homeDir)

      if (!expanded) {
        continue
      }

      for (const exe of spec.win.defaultExeNames ?? spec.win.exeNames) {
        const candidate = io.pathModule.join(expanded, exe)

        if (io.exists(candidate)) {
          executable = candidate

          break
        }
      }

      if (executable) {
        break
      }
    }
  }

  if (!executable) {
    return { executable: null, appPath: null, version: null }
  }

  const version = spec.win.beaconKey ? await regValue(io, spec.win.beaconKey, 'version') : null

  return { executable, appPath: null, version }
}

async function locateLinux(io: BrowserScanIo, spec: BrowserSpec): Promise<Located> {
  const dirs = (io.env.PATH || '/usr/local/bin:/usr/bin:/bin:/snap/bin').split(':').filter(Boolean)

  for (const name of spec.linux.executables) {
    for (const dir of dirs) {
      const candidate = io.pathModule.join(dir, name)

      if (io.exists(candidate)) {
        const version = (await safeExec(io, candidate, ['--version']))?.trim() || null

        return { executable: candidate, appPath: null, version: version ? (/(\d+(?:\.\d+)+)/.exec(version)?.[1] ?? version) : null }
      }
    }
  }

  return { executable: null, appPath: null, version: null }
}

function dataDirFor(io: BrowserScanIo, spec: BrowserSpec): string | null {
  if (io.platform === 'darwin') {
    return spec.mac.dataDir ? io.pathModule.join(io.homeDir, 'Library', 'Application Support', ...spec.mac.dataDir.split('/')) : null
  }

  if (io.platform === 'win32') {
    if (!spec.win.dataDir) {
      return null
    }

    const template = spec.win.dataDir.startsWith('%') ? spec.win.dataDir : `%LOCALAPPDATA%\\${spec.win.dataDir}`

    return expandEnv(template, io.env, io.homeDir)
  }

  return spec.linux.dataDir ? io.pathModule.join(io.homeDir, '.config', ...spec.linux.dataDir.split('/')) : null
}

function readProfileWebmate(io: BrowserScanIo, profileDir: string, installDir: string): BrowserProfileWebmate {
  // Secure Preferences holds extension settings in current Chromium; older
  // builds (and some forks) still use Preferences. A file the browser is
  // rewriting can fail to parse for a moment — re-read once before giving up.
  for (const fileName of ['Secure Preferences', 'Preferences']) {
    const file = io.pathModule.join(profileDir, fileName)

    if (!io.exists(file)) {
      continue
    }

    let attempt = extensionRecordFromPreferences(io.readText(file), WEBMATE_EXTENSION_ID)

    if (!attempt.ok) {
      attempt = extensionRecordFromPreferences(io.readText(file), WEBMATE_EXTENSION_ID)
    }

    if (attempt.ok && attempt.record !== undefined) {
      return webmateStateFromRecord(attempt.record, installDir, io.pathModule, io.platform)
    }
  }

  return NOT_INSTALLED
}

function readProfiles(io: BrowserScanIo, spec: BrowserSpec, dataDir: string | null, installDir: string): BrowserProfile[] {
  if (!dataDir || !io.exists(dataDir)) {
    return []
  }

  if (spec.singleProfile) {
    return [
      {
        dir: '',
        displayName: spec.name,
        lastActive: null,
        isLastUsed: true,
        webmate: readProfileWebmate(io, dataDir, installDir)
      }
    ]
  }

  const localState = parseLocalState(io.readText(io.pathModule.join(dataDir, 'Local State')))
  let entries = localState.entries.filter(entry => io.exists(io.pathModule.join(dataDir, entry.dir)))

  if (entries.length === 0 && io.exists(io.pathModule.join(dataDir, 'Default'))) {
    entries = [{ dir: 'Default', name: 'Default', gaiaName: null, usingDefaultName: true, activeTime: null }]
  }

  const lastUsed = localState.lastUsed ?? (entries.length === 1 ? entries[0].dir : null)

  const profiles = entries.map<BrowserProfile>(entry => ({
    dir: entry.dir,
    displayName: entry.usingDefaultName && entry.gaiaName ? entry.gaiaName : entry.name,
    lastActive: entry.activeTime !== null ? Math.round(entry.activeTime * 1000) : null,
    isLastUsed: entry.dir === lastUsed,
    webmate: readProfileWebmate(io, io.pathModule.join(dataDir, entry.dir), installDir)
  }))

  profiles.sort((a, b) => Number(b.isLastUsed) - Number(a.isLastUsed) || (b.lastActive ?? 0) - (a.lastActive ?? 0) || a.dir.localeCompare(b.dir))

  return profiles
}

/**
 * Scan the machine. `installDir` is the folder Workmate manages
 * (`<webmate>/AgentX WebMate`); a profile counts as "installed" only when the
 * browser has loaded exactly that folder.
 */
export async function scanBrowsers(installDir: string, io: BrowserScanIo = defaultBrowserScanIo()): Promise<BrowserInfo[]> {
  const [defaultId, located] = await Promise.all([
    detectDefaultBrowser(io),
    Promise.all(
      BROWSER_SPECS.map(spec =>
        io.platform === 'darwin' ? locateMac(io, spec) : io.platform === 'win32' ? locateWindows(io, spec) : locateLinux(io, spec)
      )
    )
  ])

  const browsers: BrowserInfo[] = []

  BROWSER_SPECS.forEach((spec, index) => {
    const found = located[index]

    if (!found.executable) {
      return
    }

    const dataDir = dataDirFor(io, spec)

    browsers.push({
      id: spec.id,
      name: spec.name,
      executable: found.executable,
      appPath: found.appPath,
      version: found.version,
      isDefault: defaultId === spec.id,
      supported: spec.supported,
      unsupportedReason: spec.supported ? null : (spec.id as 'firefox' | 'safari'),
      dataDir: dataDir && io.exists(dataDir) ? dataDir : null,
      extensionsUrl: spec.extensionsUrl,
      singleProfile: Boolean(spec.singleProfile),
      profiles: spec.supported ? readProfiles(io, spec, dataDir, installDir) : []
    })
  })

  browsers.sort(
    (a, b) => Number(b.supported) - Number(a.supported) || Number(b.isDefault) - Number(a.isDefault) || ORDER[a.id] - ORDER[b.id]
  )

  return browsers
}

/** The browser + profile the extension folder is loaded in, if any. */
export function findInstalledProfile(
  browsers: BrowserInfo[]
): { browser: BrowserInfo; profile: BrowserProfile } | null {
  for (const browser of browsers) {
    for (const profile of browser.profiles) {
      if (profile.webmate.installed) {
        return { browser, profile }
      }
    }
  }

  return null
}
