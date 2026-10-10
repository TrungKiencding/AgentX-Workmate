/**
 * Installing a downloaded release on Windows: hand the verified installer to NSIS.
 *
 * The NSIS installer electron-builder produces already knows how to update an
 * install in place: run with `--updated /S --force-run` it uninstalls the old copy
 * while keeping its data — `--updated` is also what makes build/installer.nsh skip
 * the AgentX purge — reinstalls to the folder the registry records, and starts the
 * new app.
 *
 * It is not started while the app is still running. Left to itself NSIS gives a
 * running app about a second before closing it and then kills it, which would cut
 * the app's own shutdown (stopping the agent backend and terminals) short. A small
 * detached script waits for the app's process to be gone first — the same hand-off
 * the uninstaller uses (desktop-uninstall.ts) — then runs the installer and records
 * a failure for the next launch to report.
 */

import path from 'node:path'

export const NSIS_UPDATE_ARGS = ['--updated', '/S', '--force-run'] as const

export type WindowsInstallBlock = 'not-installer-build'

export type WindowsInstallPreflight = { ok: true } | { ok: false; reason: WindowsInstallBlock }

/**
 * Only a copy the NSIS installer put in place can be updated by the next NSIS
 * installer; its uninstaller sits beside the executable, named after it
 * (`Uninstall <product>.exe`, electron-builder's UNINSTALL_FILENAME). A portable
 * unpack or a dev run has none.
 */
export function windowsInstallPreflight(
  execPath: string,
  fileExists: (file: string) => boolean
): WindowsInstallPreflight {
  const product = path.win32.basename(execPath, '.exe')
  const uninstaller = path.win32.join(path.win32.dirname(execPath), `Uninstall ${product}.exe`)

  return fileExists(uninstaller) ? { ok: true } : { ok: false, reason: 'not-installer-build' }
}

/**
 * A value inside a double-quoted cmd.exe argument. cmd has no escape for `"`, and
 * Windows paths cannot contain one; `%` would expand as a variable unless doubled.
 */
function cmdQuoted(value: string): string {
  return `"${String(value).replace(/"/g, '').replace(/%/g, '%%')}"`
}

export interface WindowsUpdateScriptOptions {
  /** The running app; the installer starts only once it is gone. */
  pid: number
  installer: string
  version: string
  /** Where a failed install is recorded for the next launch to read. */
  resultFile: string
  /** How long to wait for the app to exit before running the installer anyway. */
  waitSeconds?: number
}

/**
 * The detached hand-off. After `waitSeconds` it runs the installer regardless:
 * NSIS then closes a hung app itself, and the person asked for this update.
 */
export function buildWindowsUpdateScript(options: WindowsUpdateScriptOptions): string {
  const pid = Number(options.pid) || 0
  const wait = Math.max(1, Math.round(options.waitSeconds ?? 120))
  const version = String(options.version).replace(/[^0-9.]/g, '')

  return [
    '@echo off',
    'setlocal enableextensions',
    // Avoid a tasklist | findstr pipeline: its inherited pipe handles can keep
    // findstr alive after the app exits, preventing the installer from running.
    // Wait-Process observes the exact PID and has a native timeout; a missing
    // or timed-out process falls through to NSIS, which handles a hung app.
    `powershell.exe -NoProfile -NonInteractive -Command "Wait-Process -Id ${pid} -Timeout ${wait} -ErrorAction SilentlyContinue" >nul 2>nul`,
    ':run',
    `${cmdQuoted(options.installer)} ${NSIS_UPDATE_ARGS.join(' ')}`,
    'set "CODE=%ERRORLEVEL%"',
    `if not "%CODE%"=="0" (echo {"version":"${version}","ok":false,"message":"the installer exited with code %CODE%"}> ${cmdQuoted(options.resultFile)})`,
    'del "%~f0"',
    ''
  ].join('\r\n')
}
