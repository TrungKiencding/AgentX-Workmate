import { describe, expect, it } from 'vitest'

import { buildWindowsUpdateScript, NSIS_UPDATE_ARGS, windowsInstallPreflight } from './install-win'

const EXEC = 'C:\\Users\\An\\AppData\\Local\\Programs\\AgentX Workmate\\AgentX Workmate.exe'

describe('Windows install preflight', () => {
  it('accepts a copy the NSIS installer put in place, found by its uninstaller', () => {
    const seen: string[] = []

    const preflight = windowsInstallPreflight(EXEC, file => {
      seen.push(file)

      return true
    })

    expect(preflight).toEqual({ ok: true })
    expect(seen).toEqual(['C:\\Users\\An\\AppData\\Local\\Programs\\AgentX Workmate\\Uninstall AgentX Workmate.exe'])
  })

  it('refuses a portable or development copy', () => {
    expect(windowsInstallPreflight(EXEC, () => false)).toEqual({
      ok: false,
      reason: 'not-installer-build'
    })
  })

  it('runs the installer as an in-place update that keeps data and restarts the app', () => {
    // --updated: keep app data and skip build/installer.nsh's purge on the old
    // uninstall; /S: no wizard; --force-run: start the new app when done.
    expect([...NSIS_UPDATE_ARGS]).toEqual(['--updated', '/S', '--force-run'])
  })

  it('starts the installer only after the app has exited, and records a failed install', () => {
    const script = buildWindowsUpdateScript({
      pid: 4242,
      installer: 'C:\\Users\\An 100%\\AppData\\Roaming\\AgentX Workmate\\updates\\1.0.4\\AgentXWorkmate-win-x64.exe',
      version: '1.0.4',
      resultFile: 'C:\\Users\\An 100%\\AppData\\Roaming\\AgentX Workmate\\app-update-result.json',
      waitSeconds: 90
    })

    const lines = script.split('\r\n')

    const waitLine = 'powershell.exe -NoProfile -NonInteractive -Command "Wait-Process -Id 4242 -Timeout 90 -ErrorAction SilentlyContinue" >nul 2>nul'
    expect(lines).toContain(waitLine)
    expect(script).not.toContain('findstr')
    expect(script).not.toContain('tasklist')
    // The installer runs after the wait loop, with `%` doubled so cmd keeps it.
    expect(lines.indexOf(':run')).toBeGreaterThan(lines.indexOf(waitLine))
    expect(lines[lines.indexOf(':run') + 1]).toBe(
      '"C:\\Users\\An 100%%\\AppData\\Roaming\\AgentX Workmate\\updates\\1.0.4\\AgentXWorkmate-win-x64.exe" --updated /S --force-run'
    )
    expect(script).toContain(
      'if not "%CODE%"=="0" (echo {"version":"1.0.4","ok":false,"message":"the installer exited with code %CODE%"}> "C:\\Users\\An 100%%\\AppData\\Roaming\\AgentX Workmate\\app-update-result.json")'
    )
    expect(lines.at(-2)).toBe('del "%~f0"')
  })
})
