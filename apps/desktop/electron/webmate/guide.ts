/**
 * The guided install: open the browser's extensions page for the chosen
 * profile and put the `AgentX WebMate` folder where the person can drag it.
 *
 * Never `shell.openExternal` — that always lands in the default browser, and
 * the point is to open the extensions page of the browser the person picked,
 * in the profile they picked (apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.4):
 *
 *   macOS    open -na "<App>.app" --args --profile-directory="<dir>" chrome://extensions
 *   Windows  "<exe>" --profile-directory="<dir>" chrome://extensions   (detached)
 *   Linux    <exe> --profile-directory="<dir>" chrome://extensions       (detached)
 *
 * A running browser receives the URL through its single-instance handoff and
 * opens a tab; a closed one starts. Pure planning here, side effects injected.
 */

import { spawn } from 'node:child_process'

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

function quote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/** The command that opens the extensions page, or null when the browser cannot be launched. */
export function planExtensionsPageLaunch(target: GuideTarget, platform: NodeJS.Platform): GuideLaunch | null {
  const { browser, profileDir } = target

  if (!browser.supported || !browser.extensionsUrl) {
    return null
  }

  const browserArgs: string[] = []

  if (!browser.singleProfile && profileDir) {
    browserArgs.push(`--profile-directory=${profileDir}`)
  }

  browserArgs.push(browser.extensionsUrl)

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

  return { file: browser.executable, args: browserArgs, command: [quote(browser.executable), ...browserArgs.map(quote)].join(' ') }
}

export type SpawnDetached = (file: string, args: string[]) => Promise<void>

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

export interface OpenGuideResult {
  ok: boolean
  command: string | null
  error: string | null
}

/** Open the extensions page. Errors are reported, never thrown. */
export async function openExtensionsPage(
  target: GuideTarget,
  platform: NodeJS.Platform,
  run: SpawnDetached = spawnDetached
): Promise<OpenGuideResult> {
  const launch = planExtensionsPageLaunch(target, platform)

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
