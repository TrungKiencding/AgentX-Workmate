import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import {
  appleScriptAppName,
  GUIDE_MARKER_URL,
  openExtensionsPage,
  planAppleScriptNavigate,
  planWindowLaunch,
  planWindowsNavigate
} from './guide'

const chromeMac = {
  id: 'chrome' as const,
  name: 'Google Chrome',
  executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  appPath: '/Applications/Google Chrome.app',
  extensionsUrl: 'chrome://extensions',
  singleProfile: false,
  supported: true
}

const edgeWin = {
  id: 'edge' as const,
  name: 'Microsoft Edge',
  executable: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  appPath: null,
  extensionsUrl: 'edge://extensions',
  singleProfile: false,
  supported: true
}

describe('planWindowLaunch', () => {
  test('macOS opens a new window for the profile on the marker page through `open -na <app> --args`', () => {
    const plan = planWindowLaunch({ browser: chromeMac, profileDir: 'Profile 2' }, 'darwin')

    assert.deepEqual(plan?.args, [
      '-na',
      '/Applications/Google Chrome.app',
      '--args',
      '--profile-directory=Profile 2',
      '--new-window',
      GUIDE_MARKER_URL
    ])
    assert.equal(plan?.file, 'open')
    assert.equal(
      plan?.command,
      'open -na "/Applications/Google Chrome.app" --args "--profile-directory=Profile 2" --new-window about:blank'
    )
  })

  test('Windows launches the executable directly with the profile switch', () => {
    const plan = planWindowLaunch({ browser: edgeWin, profileDir: 'Default' }, 'win32')

    assert.equal(plan?.file, edgeWin.executable)
    assert.deepEqual(plan?.args, ['--profile-directory=Default', '--new-window', 'about:blank'])
  })

  test('single-profile browsers and missing profiles omit --profile-directory', () => {
    const opera = {
      ...edgeWin,
      id: 'opera' as const,
      name: 'Opera',
      singleProfile: true,
      extensionsUrl: 'chrome://extensions'
    }

    assert.deepEqual(planWindowLaunch({ browser: opera, profileDir: 'Default' }, 'win32')?.args, [
      '--new-window',
      'about:blank'
    ])
    assert.deepEqual(planWindowLaunch({ browser: edgeWin, profileDir: null }, 'win32')?.args, [
      '--new-window',
      'about:blank'
    ])
  })

  test('unsupported browsers and browsers without a binary cannot be planned', () => {
    assert.equal(planWindowLaunch({ browser: { ...chromeMac, supported: false }, profileDir: null }, 'darwin'), null)
    assert.equal(planWindowLaunch({ browser: { ...edgeWin, executable: null }, profileDir: null }, 'win32'), null)
    assert.equal(
      planWindowLaunch({ browser: { ...chromeMac, appPath: null, executable: null }, profileDir: null }, 'darwin'),
      null
    )
  })
})

describe('second move', () => {
  test('AppleScript names the app after its bundle and sets the front window URL', () => {
    assert.equal(appleScriptAppName(chromeMac), 'Google Chrome')
    assert.equal(
      appleScriptAppName({ ...chromeMac, appPath: '/Users/k/Applications/Brave Browser.app' }),
      'Brave Browser'
    )
    assert.equal(appleScriptAppName({ ...chromeMac, appPath: null, executable: null }), null)

    const plan = planAppleScriptNavigate('Microsoft Edge', 'edge://extensions')

    assert.equal(plan.file, 'osascript')
    assert.deepEqual(plan.args, [
      '-e',
      'tell application "Microsoft Edge" to set URL of active tab of front window to "edge://extensions"'
    ])
  })

  test('Windows types the address into the marker window only', () => {
    const plan = planWindowsNavigate('chrome://extensions')

    assert.equal(plan.file, 'powershell.exe')
    assert.match(plan.args.at(-1) ?? '', /AppActivate\('about:blank'\)/)
    assert.match(plan.args.at(-1) ?? '', /SendKeys\('chrome:\/\/extensions\{ENTER\}'\)/)
  })
})

describe('openExtensionsPage', () => {
  test('macOS: opens the window, waits for it to come to the front, then steers it', async () => {
    const calls: string[] = []
    let probes = 0

    const result = await openExtensionsPage({ browser: chromeMac, profileDir: 'Default' }, 'darwin', {
      run: async (file, args) => void calls.push(`run ${file} ${args.join(' ')}`),
      exec: async (file, args) => {
        calls.push(`exec ${file} ${args[1]}`)

        if (/get URL/.test(args[1])) {
          probes += 1

          // First probe: Chrome is still starting (error); second: an existing
          // window is in front; third: our marker window.
          if (probes === 1) {
            throw new Error('not running')
          }

          return probes === 2 ? 'https://mail.example.com/\n' : 'about:blank\n'
        }

        return ''
      },
      sleep: async () => {},
      now: (() => {
        let t = 0

        return () => (t += 100)
      })()
    })

    assert.equal(result.ok, true)
    assert.equal(result.windowOpened, true)
    assert.equal(result.navigated, true)
    assert.equal(result.error, null)
    assert.equal(
      calls[0],
      'run open -na /Applications/Google Chrome.app --args --profile-directory=Default --new-window about:blank'
    )
    assert.equal(
      calls.at(-1),
      'exec osascript tell application "Google Chrome" to set URL of active tab of front window to "chrome://extensions"'
    )
    assert.equal(probes, 3)
  })

  test('macOS: never steers a window that is not ours', async () => {
    let t = 0

    const result = await openExtensionsPage({ browser: chromeMac, profileDir: 'Default' }, 'darwin', {
      run: async () => {},
      exec: async (_file, args) => {
        if (/set URL/.test(args[1])) {
          throw new Error('must not navigate')
        }

        return 'https://bank.example.com/\n'
      },
      sleep: async () => {},
      now: () => (t += 3_000),
      frontWaitMs: 8_000
    })

    assert.equal(result.windowOpened, true)
    assert.equal(result.navigated, false)
    assert.equal(result.error, 'front-window-not-ours')
    assert.equal(result.ok, true)
  })

  test('Windows: opens the window then types the address; a failed keystroke still leaves the window open', async () => {
    const good = await openExtensionsPage({ browser: edgeWin, profileDir: 'Default' }, 'win32', {
      run: async () => {},
      exec: async file => {
        assert.equal(file, 'powershell.exe')

        return ''
      },
      sleep: async () => {}
    })

    assert.deepEqual([good.windowOpened, good.navigated, good.error], [true, true, null])

    const noWindow = await openExtensionsPage({ browser: edgeWin, profileDir: 'Default' }, 'win32', {
      run: async () => {},
      exec: async () => {
        throw new Error('exit 3')
      },
      sleep: async () => {}
    })

    assert.deepEqual([noWindow.windowOpened, noWindow.navigated, noWindow.error], [true, false, 'exit 3'])
  })

  test('a browser that cannot be launched reports it instead of throwing', async () => {
    const failed = await openExtensionsPage({ browser: edgeWin, profileDir: 'Default' }, 'win32', {
      run: async () => {
        throw new Error('ENOENT')
      }
    })

    assert.deepEqual([failed.ok, failed.windowOpened, failed.error], [false, false, 'ENOENT'])
    assert.ok(failed.command)

    const unplannable = await openExtensionsPage(
      { browser: { ...edgeWin, executable: null }, profileDir: null },
      'win32'
    )

    assert.deepEqual(unplannable, {
      ok: false,
      windowOpened: false,
      navigated: false,
      command: null,
      error: 'browser-not-launchable'
    })
  })
})
