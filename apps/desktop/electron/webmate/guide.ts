/**
 * The guided install: open the browser's extensions page for the chosen
 * profile and put the `AgentX WebMate` folder where the person can drag it.
 *
 * Never `shell.openExternal` — that always lands in the default browser, and
 * the point is to open the extensions page of the browser the person picked,
 * in the profile they picked (apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.4).
 *
 * Measured on Chrome 152 (macOS, 09/09/2026): a `chrome://…` URL given on the
 * command line is dropped — cold start and hand-off to a running instance
 * alike — and the window opens on the New Tab page instead (chrome://settings
 * is dropped the same way). So the page is reached in two moves:
 *
 *   1. open a NEW WINDOW for the profile on a marker page the command line
 *      does accept: `--profile-directory=<dir> --new-window about:blank`
 *      (macOS: `open -na "<App>.app" --args …`; Windows/Linux: the binary,
 *      detached);
 *   2. steer that window to the extensions page from outside the command
 *      line: macOS AppleScript (`set URL of active tab of front window` — the
 *      Apple-Event path treats the URL as trusted; verified on Chrome and
 *      Edge), Windows a WScript.Shell keystroke into the window whose title is
 *      the marker page (untested on a real Windows machine so far).
 *
 * Step 2 only touches a window whose active tab is the marker (or the
 * browser's own New Tab / What's New pages that a cold start may put in
 * front), never a tab the person had open. When it cannot find that window
 * the result says so and the panel tells the person to type the address.
 */

import { execFile, spawn } from 'node:child_process'

import type { BrowserInfo } from './browsers'

export interface GuideLaunch {
  file: string
  args: string[]
  /** Human-readable rendering for logs and the "what did Workmate run" detail. */
  command: string
}

export interface GuideTarget {
  browser: Pick<BrowserInfo, 'id' | 'name' | 'executable' | 'appPath' | 'extensionsUrl' | 'singleProfile' | 'supported'>
  /** Profile directory name ("Default", "Profile 2"); null or '' for single-profile browsers. */
  profileDir: string | null
}

/** The page a fresh window is opened on; the command line accepts it and it is unmistakable. */
export const GUIDE_MARKER_URL = 'about:blank'

/** Pages a cold-started browser may put in front of our marker; steering those is still steering our window. */
const STEERABLE_URLS = [
  GUIDE_MARKER_URL,
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'chrome://whats-new/',
  'edge://newtab/',
  'brave://newtab/'
]

function quote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/** macOS app name for AppleScript ("Google Chrome", "Microsoft Edge", "Brave Browser"). */
export function appleScriptAppName(browser: GuideTarget['browser']): string | null {
  const source = browser.appPath ?? browser.executable

  if (!source) {
    return null
  }

  const match = /([^/]+)\.app(?:\/|$)/.exec(source)

  return match ? match[1] : browser.name
}

/** Move 1: the command that opens a new window for the profile on the marker page. */
export function planWindowLaunch(target: GuideTarget, platform: NodeJS.Platform): GuideLaunch | null {
  const { browser, profileDir } = target

  if (!browser.supported || !browser.extensionsUrl) {
    return null
  }

  const browserArgs: string[] = []

  if (!browser.singleProfile && profileDir) {
    browserArgs.push(`--profile-directory=${profileDir}`)
  }

  browserArgs.push('--new-window', GUIDE_MARKER_URL)

  if (platform === 'darwin') {
    const app = browser.appPath ?? browser.executable

    if (!app) {
      return null
    }

    const args = ['-na', app, '--args', ...browserArgs]

    return { file: 'open', args, command: ['open', ...args.map(quote)].join(' ') }
  }

  if (!browser.executable) {
    return null
  }

  return {
    file: browser.executable,
    args: browserArgs,
    command: [quote(browser.executable), ...browserArgs.map(quote)].join(' ')
  }
}

/** macOS: read the front window's active-tab URL. */
export function planReadFrontUrl(appName: string): GuideLaunch {
  const script = `tell application "${appName}" to get URL of active tab of front window`

  return { file: 'osascript', args: ['-e', script], command: `osascript -e '${script}'` }
}

/** Move 2 on macOS: point the front window's active tab at the extensions page. */
export function planAppleScriptNavigate(appName: string, url: string): GuideLaunch {
  const script = `tell application "${appName}" to set URL of active tab of front window to "${url}"`

  return { file: 'osascript', args: ['-e', script], command: `osascript -e '${script}'` }
}

/**
 * Move 2 on Windows: focus the window titled after the marker page and type
 * the address. `AppActivate` matches on the window title, which for a fresh
 * about:blank window is "about:blank - Google Chrome" (Edge/Brave alike), so a
 * window the person had open is never the target.
 */
export function planWindowsNavigate(url: string): GuideLaunch {
  const script = [
    '$shell = New-Object -ComObject WScript.Shell',
    `if (-not $shell.AppActivate('${GUIDE_MARKER_URL}')) { exit 3 }`,
    'Start-Sleep -Milliseconds 400',
    "$shell.SendKeys('^l')",
    'Start-Sleep -Milliseconds 150',
    `$shell.SendKeys('${url}{ENTER}')`
  ].join('; ')

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]

  return { file: 'powershell.exe', args, command: `powershell.exe -NoProfile -NonInteractive -Command "${script}"` }
}

/** Kept for callers that only need the first move (tests, logs). */
export function planExtensionsPageLaunch(target: GuideTarget, platform: NodeJS.Platform): GuideLaunch | null {
  return planWindowLaunch(target, platform)
}

/**
 * Open an ordinary web page in the chosen browser profile (phase 4: Workmate's
 * own Keycloak sign-in, so the SSO cookie lands in the browser WebMate lives
 * in and `auth_hint` can reuse it). Unlike `chrome://` pages, an http(s) URL
 * on the command line is honoured — it opens as a tab in that profile's
 * window, or a new window when none is open. Only http(s) is ever launched.
 */
export function planUrlLaunch(target: GuideTarget, url: string, platform: NodeJS.Platform): GuideLaunch | null {
  const { browser, profileDir } = target

  if (!browser.supported) {
    return null
  }

  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }

  const browserArgs: string[] = []

  if (!browser.singleProfile && profileDir) {
    browserArgs.push(`--profile-directory=${profileDir}`)
  }

  browserArgs.push(parsed.toString())

  if (platform === 'darwin') {
    const app = browser.appPath ?? browser.executable

    if (!app) {
      return null
    }

    const args = ['-na', app, '--args', ...browserArgs]

    return { file: 'open', args, command: ['open', ...args.map(quote)].join(' ') }
  }

  if (!browser.executable) {
    return null
  }

  return {
    file: browser.executable,
    args: browserArgs,
    command: [quote(browser.executable), ...browserArgs.map(quote)].join(' ')
  }
}

export interface OpenUrlResult {
  ok: boolean
  command: string | null
  error: string | null
}

/** Run `planUrlLaunch`. Errors are reported, never thrown; the caller falls back to the system browser. */
export async function openUrlInBrowser(
  target: GuideTarget,
  url: string,
  platform: NodeJS.Platform,
  deps: Pick<GuideDeps, 'run'> = {}
): Promise<OpenUrlResult> {
  const run = deps.run ?? spawnDetached
  const launch = planUrlLaunch(target, url, platform)

  if (!launch) {
    return { ok: false, command: null, error: 'browser-not-launchable' }
  }

  try {
    await run(launch.file, launch.args)

    return { ok: true, command: launch.command, error: null }
  } catch (error) {
    return { ok: false, command: launch.command, error: error instanceof Error ? error.message : String(error) }
  }
}

export type SpawnDetached = (file: string, args: string[]) => Promise<void>
export type ExecCapture = (file: string, args: string[]) => Promise<string>

/** Default side effect: spawn detached, never wait, never inherit stdio. */
export const spawnDetached: SpawnDetached = (file, args) =>
  new Promise((resolve, reject) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })

      child.once('error', reject)
      // `spawn` reports a missing binary asynchronously; give it a tick.
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    } catch (error) {
      reject(error)
    }
  })

/** Default capture: run a short helper (osascript, powershell) and return its stdout. */
export const execCapture: ExecCapture = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error)

        return
      }

      resolve(String(stdout))
    })
  })

export interface GuideDeps {
  run?: SpawnDetached
  exec?: ExecCapture
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long to wait for the new window to come to the front (macOS). */
  frontWaitMs?: number
  /** Pause after the launch before the first probe (a cold start needs a moment). */
  settleMs?: number
}

export interface OpenGuideResult {
  ok: boolean
  /** The window for the profile opened (move 1). */
  windowOpened: boolean
  /** The extensions page was reached (move 2); false means "type the address yourself". */
  navigated: boolean
  command: string | null
  error: string | null
}

/**
 * Open the extensions page for the chosen browser profile. Errors are
 * reported, never thrown; `navigated: false` with `windowOpened: true` is the
 * degraded outcome the panel already has copy for.
 */
export async function openExtensionsPage(
  target: GuideTarget,
  platform: NodeJS.Platform,
  deps: GuideDeps = {}
): Promise<OpenGuideResult> {
  const run = deps.run ?? spawnDetached
  const exec = deps.exec ?? execCapture
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const launch = planWindowLaunch(target, platform)

  if (!launch) {
    return { ok: false, windowOpened: false, navigated: false, command: null, error: 'browser-not-launchable' }
  }

  try {
    await run(launch.file, launch.args)
  } catch (error) {
    return {
      ok: false,
      windowOpened: false,
      navigated: false,
      command: launch.command,
      error: error instanceof Error ? error.message : String(error)
    }
  }

  const url = target.browser.extensionsUrl

  if (platform === 'darwin') {
    const appName = appleScriptAppName(target.browser)

    if (!appName) {
      return { ok: true, windowOpened: true, navigated: false, command: launch.command, error: 'no-app-name' }
    }

    await sleep(deps.settleMs ?? 700)
    const deadline = now() + (deps.frontWaitMs ?? 8_000)
    let frontIsOurs = false

    while (now() <= deadline) {
      try {
        const front = (await exec(planReadFrontUrl(appName).file, planReadFrontUrl(appName).args)).trim()

        if (STEERABLE_URLS.includes(front)) {
          frontIsOurs = true

          break
        }
      } catch {
        /* the app may still be starting */
      }

      await sleep(300)
    }

    if (!frontIsOurs) {
      return { ok: true, windowOpened: true, navigated: false, command: launch.command, error: 'front-window-not-ours' }
    }

    const navigate = planAppleScriptNavigate(appName, url)

    try {
      await exec(navigate.file, navigate.args)

      return {
        ok: true,
        windowOpened: true,
        navigated: true,
        command: `${launch.command} && ${navigate.command}`,
        error: null
      }
    } catch (error) {
      return {
        ok: true,
        windowOpened: true,
        navigated: false,
        command: launch.command,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  if (platform === 'win32') {
    await sleep(deps.settleMs ?? 1_500)
    const navigate = planWindowsNavigate(url)

    try {
      await exec(navigate.file, navigate.args)

      return {
        ok: true,
        windowOpened: true,
        navigated: true,
        command: `${launch.command} && ${navigate.command}`,
        error: null
      }
    } catch (error) {
      return {
        ok: true,
        windowOpened: true,
        navigated: false,
        command: launch.command,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  // Linux: no trusted side channel; the window is open, the person types the address.
  return { ok: true, windowOpened: true, navigated: false, command: launch.command, error: 'no-navigation-channel' }
}
