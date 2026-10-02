/**
 * The app updater, wired to a real machine: where its files live, which feed and
 * key it trusts, how each platform hands over to its installer, and when it checks.
 *
 * main.ts supplies the Electron and process facts (paths, `net.fetch`, quitting,
 * the agent's in-flight work) and registers the IPC; everything that decides
 * anything lives in updater.ts and the install-* modules, where it is tested.
 *
 * Test hooks, honoured in any build and logged when used:
 *   AGENTX_DESKTOP_UPDATE_FEED_URL     another feed (http only on 127.0.0.1 / localhost)
 *   AGENTX_DESKTOP_UPDATE_PUBLIC_KEY   the PEM that feed is signed with (`\n` escapes ok)
 * Setting them takes the same power as setting any other variable the app starts
 * with; a feed they name still has to verify, and so does every installer it lists.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import type { FetchLike } from './download'
import { APP_RELEASE_FEED_URL, APP_RELEASE_PUBLIC_KEY } from './feed'
import {
  buildMacSwapScript,
  bundleIdentifier,
  bundlePathForExecutable,
  macInstallPreflight,
  type RunProgram,
  stageMacUpdate
} from './install-mac'
import { buildWindowsUpdateScript, windowsInstallPreflight } from './install-win'
import {
  type ActiveWork,
  type AppUpdateBlock,
  AppUpdater,
  type AppUpdateState,
  type InstallHandoff,
  type InstallResult,
  type PersistedUpdateState
} from './updater'

/** First check after launch: late enough not to compete with the boot. */
export const FIRST_CHECK_DELAY_MS = 15_000
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** A window regaining focus checks again only if the last check is this old. */
export const FOCUS_CHECK_MIN_AGE_MS = 60 * 60 * 1000

export interface AppUpdateServiceDeps {
  appVersion: string
  isPackaged: boolean
  platform: NodeJS.Platform
  arch: string
  execPath: string
  userDataDir: string
  tempDir: string
  pid: number
  cwd: string
  argv: string[]
  env: NodeJS.ProcessEnv
  fetch: FetchLike
  broadcast: (state: AppUpdateState) => void
  log: (line: string) => void
  activeWork: () => ActiveWork
  /** Quit so the detached installer can take over (skips the quit confirmation). */
  quitForHandoff: () => void
  fileExists: (file: string) => boolean
  isWritable: (dir: string) => boolean
}

const execFileAsync = promisify(execFile)

const runProgram: RunProgram = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { maxBuffer: 4 * 1024 * 1024 })

  return { stdout: String(stdout) }
}

/** Where installing in place is impossible on this copy, before any release is known. */
export function locationBlock(
  deps: Pick<AppUpdateServiceDeps, 'execPath' | 'fileExists' | 'isPackaged' | 'isWritable' | 'platform'>
): AppUpdateBlock | null {
  if (!deps.isPackaged) {
    return 'dev-build'
  }

  if (deps.platform === 'darwin') {
    const preflight = macInstallPreflight(deps.execPath, deps.isWritable)

    return 'reason' in preflight ? preflight.reason : null
  }

  if (deps.platform === 'win32') {
    const preflight = windowsInstallPreflight(deps.execPath, deps.fileExists)

    return 'reason' in preflight ? preflight.reason : null
  }

  return 'unsupported-platform'
}

/** The feed, key and URL policy to use: the release ones unless a test points elsewhere. */
export function feedSettings(env: NodeJS.ProcessEnv) {
  const feedUrl = env.AGENTX_DESKTOP_UPDATE_FEED_URL?.trim()
  const publicKey = env.AGENTX_DESKTOP_UPDATE_PUBLIC_KEY?.trim()

  if (!feedUrl || !publicKey) {
    return {
      feedUrl: APP_RELEASE_FEED_URL,
      publicKeyPem: APP_RELEASE_PUBLIC_KEY,
      allowLoopbackHttp: false,
      overridden: false
    }
  }

  return { feedUrl, publicKeyPem: `${publicKey.replace(/\\n/g, '\n')}\n`, allowLoopbackHttp: true, overridden: true }
}

/**
 * Environment the relaunched app must keep: the overrides that point it at another
 * AgentX home, userData folder or update feed. A normal launch has none.
 */
export function relaunchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        entry[1] !== '' &&
        (entry[0] === 'AGENTX_HOME' || entry[0].startsWith('AGENTX_DESKTOP_'))
    )
  )
}

/** Launch arguments worth replaying: everything but Chromium's per-process ones. */
export function relaunchArgs(argv: string[]): string[] {
  return argv.filter(arg => !arg.startsWith('--type=') && !arg.startsWith('-psn_'))
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJsonFile(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(`${file}.tmp`, file)
}

export interface AppUpdateService {
  updater: AppUpdater
  /** Settle the last launch's outcome, then check on a schedule. */
  start: () => Promise<void>
  /** A window regained focus: check again if the last check is old. */
  onFocus: () => void
  stop: () => void
}

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  const stateFile = path.join(deps.userDataDir, 'app-update.json')
  const resultFile = path.join(deps.userDataDir, 'app-update-result.json')
  const downloadDir = path.join(deps.userDataDir, 'updates')
  const settings = feedSettings(deps.env)
  const block = locationBlock(deps)
  let timer: NodeJS.Timeout | null = null
  let firstCheck: NodeJS.Timeout | null = null

  if (settings.overridden) {
    deps.log(`[app-update] using the test feed ${settings.feedUrl} (AGENTX_DESKTOP_UPDATE_FEED_URL)`)
  }

  const handoff: InstallHandoff = {
    start: async (installer, version) => {
      if (deps.platform === 'darwin') {
        const bundlePath = bundlePathForExecutable(deps.execPath)

        if (!bundlePath) {
          throw new Error('this copy is not an app bundle')
        }

        const staged = await stageMacUpdate({
          dmgPath: installer,
          bundlePath,
          version,
          bundleId: await bundleIdentifier(runProgram, bundlePath),
          run: runProgram,
          makeTempDir: async () => fs.promises.mkdtemp(path.join(deps.tempDir, 'agentx-update-mount-')),
          removeDir: async dir => fs.promises.rm(dir, { recursive: true, force: true }),
          listDir: async dir => fs.promises.readdir(dir)
        })

        const script = path.join(deps.tempDir, `agentx-update-${Date.now()}.sh`)

        fs.writeFileSync(
          script,
          buildMacSwapScript({
            pid: deps.pid,
            target: bundlePath,
            staged,
            version,
            resultFile,
            relaunch: {
              env: relaunchEnv(deps.env),
              args: relaunchArgs(deps.argv),
              cwd: deps.cwd,
              executableName: path.basename(deps.execPath)
            }
          }),
          { mode: 0o755 }
        )
        spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref()
        deps.log(`[app-update] staged ${version} at ${staged}; ${script} swaps it in once the app quits`)

        return
      }

      if (deps.platform === 'win32') {
        const script = path.join(deps.tempDir, `agentx-update-${Date.now()}.cmd`)

        fs.writeFileSync(script, buildWindowsUpdateScript({ pid: deps.pid, installer, version, resultFile }))
        spawn(deps.env.ComSpec || 'cmd.exe', ['/d', '/c', script], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        }).unref()
        deps.log(`[app-update] ${script} runs ${installer} once the app quits`)

        return
      }

      throw new Error(`no installer hand-off for ${deps.platform}`)
    }
  }

  const updater = new AppUpdater({
    currentVersion: deps.appVersion,
    platform: deps.platform,
    arch: deps.arch,
    locationBlock: block,
    feedUrl: settings.feedUrl,
    publicKeyPem: settings.publicKeyPem,
    feedOptions: { allowLoopbackHttp: settings.allowLoopbackHttp },
    downloadDir,
    fetch: deps.fetch,
    handoff,
    activeWork: deps.activeWork,
    quit: deps.quitForHandoff,
    readPersisted: () => readJsonFile<PersistedUpdateState>(stateFile) ?? {},
    writePersisted: state => writeJsonFile(stateFile, state),
    takeInstallResult: () => {
      const result = readJsonFile<InstallResult>(resultFile)

      fs.rmSync(resultFile, { force: true })

      return result && typeof result.version === 'string' && typeof result.ok === 'boolean' ? result : null
    },
    pruneDownloads: async keep => {
      let entries: fs.Dirent[]

      try {
        entries = await fs.promises.readdir(downloadDir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || !keep(entry.name)) {
          await fs.promises.rm(path.join(downloadDir, entry.name), { recursive: true, force: true })
        }
      }
    },
    broadcast: deps.broadcast,
    log: deps.log
  })

  // A development run checks only when a test feed says to; otherwise every
  // `npm run dev` on an older branch would announce the latest release.
  const scheduled = deps.isPackaged || settings.overridden

  return {
    updater,
    start: async () => {
      await updater.initialize()

      if (!scheduled) {
        return
      }

      firstCheck = setTimeout(() => void updater.check(), FIRST_CHECK_DELAY_MS)
      timer = setInterval(() => void updater.check(), CHECK_INTERVAL_MS)
      firstCheck.unref?.()
      timer.unref?.()
    },
    onFocus: () => {
      const { checkedAt } = updater.getState()

      if (scheduled && checkedAt !== null && Date.now() - checkedAt >= FOCUS_CHECK_MIN_AGE_MS) {
        void updater.check()
      }
    },
    stop: () => {
      if (firstCheck) {
        clearTimeout(firstCheck)
      }

      if (timer) {
        clearInterval(timer)
      }
    }
  }
}
