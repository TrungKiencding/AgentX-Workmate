/**
 * Installing a downloaded release on macOS: swap the .app bundle, then reopen it.
 *
 * Without a Developer ID there is no Squirrel.Mac, so the swap is ours. It happens in
 * two halves on purpose:
 *
 *   - While the app is still running, the new bundle is copied out of the verified DMG
 *     to `<bundle>.agentx-update-new`, beside the bundle it will replace. Everything
 *     that can fail for a reason the person can act on (a read-only location, a full
 *     disk, a damaged image) fails here, with the app still open to say so.
 *   - After the app quits, a detached script swaps the two by renaming within one
 *     folder, puts the old bundle back if the second rename fails, records the outcome
 *     for the next launch to read, and reopens the app.
 *
 * Every helper takes its side effects as arguments so the whole path runs in tests.
 */

import path from 'node:path'

export type MacInstallBlock = 'not-a-bundle' | 'not-writable' | 'translocated'

export type MacInstallPreflight = { ok: true; bundlePath: string } | { ok: false; reason: MacInstallBlock }

/** `<App>.app` for an executable at `<App>.app/Contents/MacOS/<exe>`, else null. */
export function bundlePathForExecutable(execPath: string): null | string {
  const bundle = path.dirname(path.dirname(path.dirname(execPath)))

  return bundle.endsWith('.app') && path.basename(path.dirname(execPath)) === 'MacOS' ? bundle : null
}

/**
 * Can this copy replace itself? Not when Gatekeeper's App Translocation is running it
 * from a randomized read-only mount (opened straight from Downloads or the DMG), and
 * not when its folder is not writable (a standard account in /Applications, a mounted
 * disk image).
 */
export function macInstallPreflight(execPath: string, isWritable: (dir: string) => boolean): MacInstallPreflight {
  const bundlePath = bundlePathForExecutable(execPath)

  if (!bundlePath) {
    return { ok: false, reason: 'not-a-bundle' }
  }

  if (bundlePath.includes('/AppTranslocation/')) {
    return { ok: false, reason: 'translocated' }
  }

  if (!isWritable(path.dirname(bundlePath))) {
    return { ok: false, reason: 'not-writable' }
  }

  return { ok: true, bundlePath }
}

export function stagedBundlePath(bundlePath: string): string {
  return `${bundlePath}.agentx-update-new`
}

/** Runs a program to completion; rejects with its stderr when it exits non-zero. */
export type RunProgram = (file: string, args: string[]) => Promise<{ stdout: string }>

export interface StageMacUpdateOptions {
  dmgPath: string
  bundlePath: string
  /** The version the signed feed promised; the bundle inside must say the same. */
  version: string
  /** CFBundleIdentifier of the running app; the new bundle must be the same app. */
  bundleId: string
  run: RunProgram
  makeTempDir: () => Promise<string>
  removeDir: (dir: string) => Promise<void>
  listDir: (dir: string) => Promise<string[]>
}

export class MacStageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MacStageError'
  }
}

async function readBundleInfo(run: RunProgram, bundle: string): Promise<Record<string, unknown>> {
  const { stdout } = await run('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    path.join(bundle, 'Contents', 'Info.plist')
  ])

  return JSON.parse(stdout) as Record<string, unknown>
}

/** The running app's CFBundleIdentifier, read from its own Info.plist. */
export async function bundleIdentifier(run: RunProgram, bundlePath: string): Promise<string> {
  const info = await readBundleInfo(run, bundlePath)

  return String(info.CFBundleIdentifier || '')
}

/**
 * Copy the app out of the DMG to the staging path beside the running bundle. Returns
 * the staged path. The DMG was already matched against the signed feed's sha256;
 * this checks that what it holds is this app at the promised version.
 */
export async function stageMacUpdate(options: StageMacUpdateOptions): Promise<string> {
  const { dmgPath, bundlePath, version, bundleId, run } = options
  const staged = stagedBundlePath(bundlePath)
  const mountPoint = await options.makeTempDir()
  let attached = false

  try {
    await run('/usr/bin/hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-noautoopen',
      // The file's sha256 already matched the signed feed; the image checksum adds
      // nothing but a minute of reading.
      '-noverify',
      '-mountpoint',
      mountPoint,
      dmgPath
    ])
    attached = true

    const apps = (await options.listDir(mountPoint)).filter(name => name.endsWith('.app'))

    if (apps.length !== 1) {
      throw new MacStageError(`the disk image holds ${apps.length} apps, expected exactly one`)
    }

    const source = path.join(mountPoint, apps[0])
    const info = await readBundleInfo(run, source)

    if (info.CFBundleIdentifier !== bundleId) {
      throw new MacStageError(`the disk image holds ${String(info.CFBundleIdentifier)}, not ${bundleId}`)
    }

    if (info.CFBundleShortVersionString !== version) {
      throw new MacStageError(
        `the disk image holds version ${String(info.CFBundleShortVersionString)}, the release says ${version}`
      )
    }

    await options.removeDir(staged)
    await run('/usr/bin/ditto', [source, staged])
    // Nothing we wrote should carry a quarantine flag, but a copy that did would be
    // refused at launch with no one there to approve it.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => undefined)

    return staged
  } catch (error) {
    await options.removeDir(staged).catch(() => undefined)

    if (error instanceof MacStageError) {
      throw error
    }

    throw new MacStageError(`could not prepare the new version: ${(error as Error).message}`)
  } finally {
    if (attached) {
      await run('/usr/bin/hdiutil', ['detach', mountPoint]).catch(() =>
        run('/usr/bin/hdiutil', ['detach', '-force', mountPoint]).catch(() => undefined)
      )
    }

    await options.removeDir(mountPoint).catch(() => undefined)
  }
}

/** POSIX single-quote a value for the generated script. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export interface MacRelaunch {
  /**
   * Environment the relaunched app must keep (an AGENTX_HOME or userData override).
   * Empty for an ordinary launch, which then goes through LaunchServices.
   */
  env: Record<string, string>
  args: string[]
  cwd: string
  executableName: string
}

/**
 * How the script reopens the app. An ordinary launch goes through `open`, like a
 * double-click. A launch that carried an AGENTX_HOME or userData override is
 * re-executed directly with that environment, because `open` would drop it and bring
 * the app back up on the person's real data.
 */
export function macRelaunchCommand(target: string, relaunch: MacRelaunch): string {
  if (Object.keys(relaunch.env).length === 0 && relaunch.args.length === 0) {
    return `/usr/bin/open ${shellQuote(target)}`
  }

  const exports = Object.entries(relaunch.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`)
  const executable = path.posix.join(target, 'Contents', 'MacOS', relaunch.executableName)
  const args = relaunch.args.map(shellQuote).join(' ')

  return [
    `cd ${shellQuote(relaunch.cwd)} 2>/dev/null || cd /`,
    ...exports,
    `nohup ${shellQuote(executable)}${args ? ` ${args}` : ''} >/dev/null 2>&1 &`
  ].join('\n  ')
}

export interface MacSwapScriptOptions {
  pid: number
  target: string
  staged: string
  version: string
  /** Where the outcome is recorded for the next launch to read. */
  resultFile: string
  relaunch: MacRelaunch
  /** How long to wait for the app to exit before giving up; two minutes. */
  waitSeconds?: number
}

/**
 * The detached swap. Waits for the app to exit; gives up (and keeps the old bundle)
 * rather than swapping under a process that is still running.
 */
export function buildMacSwapScript(options: MacSwapScriptOptions): string {
  const { pid, target, staged, version, resultFile } = options
  const polls = Math.max(1, Math.round((options.waitSeconds ?? 120) * 2))

  return `#!/bin/bash
# AgentX Workmate update: swap in the staged app once the running one has quit.
set -u
APP_PID=${Number(pid)}
TARGET=${shellQuote(target)}
STAGED=${shellQuote(staged)}
OLD="$TARGET.agentx-update-old"
RESULT=${shellQuote(resultFile)}
VERSION=${shellQuote(version)}

report() {
  printf '{"version":"%s","ok":%s,"message":"%s","at":%s}\\n' "$VERSION" "$1" "$2" "$(date +%s)" > "$RESULT.tmp" \\
    && mv -f "$RESULT.tmp" "$RESULT"
}

relaunch() {
  ${macRelaunchCommand(target, options.relaunch)}
}

for _ in $(seq 1 ${polls}); do
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.5
done

if kill -0 "$APP_PID" 2>/dev/null; then
  rm -rf "$STAGED"
  report false "the app did not quit in time"
  exit 1
fi

rm -rf "$OLD" 2>/dev/null
if ! mv "$TARGET" "$OLD"; then
  rm -rf "$STAGED"
  report false "the old app could not be moved aside"
  relaunch
  exit 1
fi

if ! mv "$STAGED" "$TARGET"; then
  if mv "$OLD" "$TARGET"; then
    report false "the new app could not be moved into place; the old one was put back"
  else
    report false "the new app could not be moved into place and the old one is left beside it"
  fi
  rm -rf "$STAGED"
  relaunch
  exit 1
fi

rm -rf "$OLD"
report true "installed"
relaunch
rm -f -- "$0"
`
}
