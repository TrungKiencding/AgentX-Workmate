import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildMacSwapScript,
  bundlePathForExecutable,
  macInstallPreflight,
  macRelaunchCommand,
  MacStageError,
  stagedBundlePath,
  stageMacUpdate
} from './install-mac'

const EXEC = '/Applications/AgentX Workmate.app/Contents/MacOS/AgentX Workmate'

describe('macOS install preflight', () => {
  it('finds the bundle of a packaged executable and nothing else', () => {
    expect(bundlePathForExecutable(EXEC)).toBe('/Applications/AgentX Workmate.app')
    expect(bundlePathForExecutable('/usr/local/bin/node')).toBeNull()
    expect(bundlePathForExecutable('/Applications/AgentX Workmate.app/Contents/Frameworks/x')).toBeNull()
  })

  it('refuses translocated, unwritable and unbundled copies', () => {
    const writable = () => true

    expect(macInstallPreflight(EXEC, writable)).toEqual({ ok: true, bundlePath: '/Applications/AgentX Workmate.app' })
    expect(macInstallPreflight('/opt/electron/Electron', writable)).toEqual({ ok: false, reason: 'not-a-bundle' })
    expect(
      macInstallPreflight(
        '/private/var/folders/x/AppTranslocation/1234/d/AgentX Workmate.app/Contents/MacOS/AgentX Workmate',
        writable
      )
    ).toEqual({ ok: false, reason: 'translocated' })
    expect(macInstallPreflight(EXEC, dir => dir !== '/Applications')).toEqual({ ok: false, reason: 'not-writable' })
  })
})

interface FakeImage {
  apps?: string[]
  bundleId?: string
  version?: string
  failAttach?: boolean
  failDitto?: boolean
}

function fakeStage(image: FakeImage = {}) {
  const calls: string[] = []
  const removed: string[] = []

  const options = {
    dmgPath: '/tmp/AgentXWorkmate-mac-arm64.dmg',
    bundlePath: '/Applications/AgentX Workmate.app',
    version: '1.0.4',
    bundleId: 'com.agentx.workmate',
    makeTempDir: async () => '/tmp/mount-1',
    removeDir: async (dir: string) => {
      removed.push(dir)
    },
    listDir: async () => image.apps ?? ['AgentX Workmate.app', '.background'],
    run: async (file: string, args: string[]) => {
      calls.push([path.basename(file), ...args].join(' ').replace(/\\/g, '/'))

      if (file.endsWith('hdiutil') && args[0] === 'attach' && image.failAttach) {
        throw new Error('hdiutil: attach failed - image not recognized')
      }

      if (file.endsWith('ditto') && image.failDitto) {
        throw new Error('ditto: No space left on device')
      }

      if (file.endsWith('plutil')) {
        return {
          stdout: JSON.stringify({
            CFBundleIdentifier: image.bundleId ?? 'com.agentx.workmate',
            CFBundleShortVersionString: image.version ?? '1.0.4'
          })
        }
      }

      return { stdout: '' }
    }
  }

  return { options, calls, removed }
}

describe('stageMacUpdate', () => {
  it('copies the app out of the image beside the running bundle and detaches', async () => {
    const { options, calls, removed } = fakeStage()

    await expect(stageMacUpdate(options)).resolves.toBe('/Applications/AgentX Workmate.app.agentx-update-new')

    expect(calls[0]).toMatch(/^hdiutil attach -nobrowse -readonly -noautoopen -noverify -mountpoint \/tmp\/mount-1 /)
    expect(calls).toContain(
      'ditto /tmp/mount-1/AgentX Workmate.app /Applications/AgentX Workmate.app.agentx-update-new'
    )
    expect(calls).toContain('xattr -dr com.apple.quarantine /Applications/AgentX Workmate.app.agentx-update-new')
    expect(calls.at(-1)).toBe('hdiutil detach /tmp/mount-1')
    expect(removed).toContain('/tmp/mount-1')
  })

  it('refuses an image that holds a different app, another version, or not one app', async () => {
    for (const image of [
      { bundleId: 'com.example.other' },
      { version: '1.0.5' },
      { apps: [] },
      { apps: ['A.app', 'B.app'] }
    ]) {
      const { options, calls, removed } = fakeStage(image)

      await expect(stageMacUpdate(options)).rejects.toBeInstanceOf(MacStageError)
      expect(calls.some(call => call.startsWith('ditto'))).toBe(false)
      expect(calls.at(-1)).toBe('hdiutil detach /tmp/mount-1')
      expect(removed).toContain(stagedBundlePath(options.bundlePath))
    }
  })

  it('cleans up when the image will not mount or the copy fails', async () => {
    const unmountable = fakeStage({ failAttach: true })

    await expect(stageMacUpdate(unmountable.options)).rejects.toThrow(/could not prepare the new version: hdiutil/)
    expect(unmountable.calls.some(call => call.startsWith('hdiutil detach'))).toBe(false)
    expect(unmountable.removed).toContain('/tmp/mount-1')

    const full = fakeStage({ failDitto: true })

    await expect(stageMacUpdate(full.options)).rejects.toThrow(/No space left/)
    expect(full.calls.at(-1)).toBe('hdiutil detach /tmp/mount-1')
    expect(full.removed).toContain(stagedBundlePath(full.options.bundlePath))
  })
})

describe('macRelaunchCommand', () => {
  const plain = { env: {}, args: [], cwd: '/', executableName: 'AgentX Workmate' }

  it('reopens an ordinary launch through LaunchServices', () => {
    expect(macRelaunchCommand('/Applications/AgentX Workmate.app', plain)).toBe(
      "/usr/bin/open '/Applications/AgentX Workmate.app'"
    )
  })

  it('re-executes a launch that carried overrides, keeping them', () => {
    const command = macRelaunchCommand('/Applications/AgentX Workmate.app', {
      ...plain,
      env: { AGENTX_HOME: "/tmp/it's home" },
      args: ['--remote-debugging-port=9223'],
      cwd: '/tmp'
    })

    expect(command).toContain("export AGENTX_HOME='/tmp/it'\\''s home'")
    expect(command).toContain(
      "nohup '/Applications/AgentX Workmate.app/Contents/MacOS/AgentX Workmate' '--remote-debugging-port=9223' >/dev/null 2>&1 &"
    )
    expect(command.startsWith("cd '/tmp'")).toBe(true)
  })
})

// The swap script is bash; run it for real against throwaway bundles.
const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('the swap script', () => {
  let dir: string
  let holder: ChildProcess | null = null

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-swap-'))
  })

  afterEach(() => {
    holder?.kill('SIGKILL')
    holder = null
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A fake bundle whose executable records that it ran, and with which environment. */
  function makeBundle(bundle: string, label: string) {
    const macos = path.join(bundle, 'Contents', 'MacOS')

    fs.mkdirSync(macos, { recursive: true })
    fs.writeFileSync(path.join(bundle, 'label.txt'), label)
    fs.writeFileSync(
      path.join(macos, 'app'),
      `#!/bin/bash\nprintf '%s %s' ${label} "$AGENTX_HOME" > ${JSON.stringify(path.join(dir, 'relaunched.txt'))}\n`,
      { mode: 0o755 }
    )
  }

  function startHolder(): number {
    holder = spawn('sleep', ['30'], { stdio: 'ignore' })

    return holder.pid!
  }

  async function runSwap(pid: number, { quit = true, waitSeconds = 10 } = {}) {
    const target = path.join(dir, 'AgentX Workmate.app')
    const resultFile = path.join(dir, 'install-result.json')
    const scriptFile = path.join(dir, 'swap.sh')

    fs.writeFileSync(
      scriptFile,
      buildMacSwapScript({
        pid,
        target,
        staged: stagedBundlePath(target),
        version: '1.0.4',
        resultFile,
        waitSeconds,
        relaunch: { env: { AGENTX_HOME: path.join(dir, 'home') }, args: [], cwd: dir, executableName: 'app' }
      }),
      { mode: 0o755 }
    )

    const script = spawn('/bin/bash', [scriptFile], { stdio: 'ignore' })

    if (quit) {
      setTimeout(() => holder?.kill('SIGTERM'), 300)
    }

    await new Promise(resolve => script.once('exit', resolve))

    return { target, resultFile, scriptFile }
  }

  async function relaunched(): Promise<null | string> {
    const file = path.join(dir, 'relaunched.txt')

    for (let i = 0; i < 40 && !fs.existsSync(file); i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  }

  it('waits for the app to quit, swaps the bundles, records success and reopens the new one', async () => {
    makeBundle(path.join(dir, 'AgentX Workmate.app'), 'old')
    makeBundle(stagedBundlePath(path.join(dir, 'AgentX Workmate.app')), 'new')

    const { target, resultFile, scriptFile } = await runSwap(startHolder())

    expect(fs.readFileSync(path.join(target, 'label.txt'), 'utf8')).toBe('new')
    expect(fs.existsSync(`${target}.agentx-update-old`)).toBe(false)
    expect(fs.existsSync(stagedBundlePath(target))).toBe(false)
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toMatchObject({ version: '1.0.4', ok: true })
    expect(await relaunched()).toBe(`new ${path.join(dir, 'home')}`)
    expect(fs.existsSync(scriptFile)).toBe(false)
  })

  it('puts the old bundle back when the new one cannot move into place', async () => {
    makeBundle(path.join(dir, 'AgentX Workmate.app'), 'old')
    // No staged bundle: the second rename fails.

    const { target, resultFile } = await runSwap(startHolder())

    expect(fs.readFileSync(path.join(target, 'label.txt'), 'utf8')).toBe('old')
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toMatchObject({
      ok: false,
      message: 'the new app could not be moved into place; the old one was put back'
    })
    expect(await relaunched()).toBe(`old ${path.join(dir, 'home')}`)
  })

  it('leaves everything as it was when the app never quits', async () => {
    makeBundle(path.join(dir, 'AgentX Workmate.app'), 'old')
    makeBundle(stagedBundlePath(path.join(dir, 'AgentX Workmate.app')), 'new')

    const { target, resultFile } = await runSwap(startHolder(), { quit: false, waitSeconds: 1 })

    expect(fs.readFileSync(path.join(target, 'label.txt'), 'utf8')).toBe('old')
    expect(fs.existsSync(stagedBundlePath(target))).toBe(false)
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toMatchObject({
      ok: false,
      message: 'the app did not quit in time'
    })
    expect(await relaunched()).toBeNull()
  })

  it('is valid bash', () => {
    const script = buildMacSwapScript({
      pid: 1,
      target: "/Applications/It's Workmate.app",
      staged: "/Applications/It's Workmate.app.agentx-update-new",
      version: '1.0.4',
      resultFile: '/tmp/result.json',
      relaunch: { env: {}, args: [], cwd: '/', executableName: 'AgentX Workmate' }
    })

    expect(spawnSync('/bin/bash', ['-n'], { input: script }).status).toBe(0)
  })
})
