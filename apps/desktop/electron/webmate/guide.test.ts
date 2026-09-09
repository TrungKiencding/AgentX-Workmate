import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { openExtensionsPage, planExtensionsPageLaunch } from './guide'

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

describe('planExtensionsPageLaunch', () => {
  test('macOS goes through `open -na <app> --args` so the chosen browser and profile receive the URL', () => {
    const plan = planExtensionsPageLaunch({ browser: chromeMac, profileDir: 'Profile 2' }, 'darwin')

    assert.deepEqual(plan?.args, ['-na', '/Applications/Google Chrome.app', '--args', '--profile-directory=Profile 2', 'chrome://extensions'])
    assert.equal(plan?.file, 'open')
    assert.equal(plan?.command, 'open -na "/Applications/Google Chrome.app" --args "--profile-directory=Profile 2" chrome://extensions')
  })

  test('Windows launches the executable directly with the profile switch', () => {
    const plan = planExtensionsPageLaunch({ browser: edgeWin, profileDir: 'Default' }, 'win32')

    assert.equal(plan?.file, edgeWin.executable)
    assert.deepEqual(plan?.args, ['--profile-directory=Default', 'edge://extensions'])
  })

  test('single-profile browsers and missing profiles omit --profile-directory', () => {
    const opera = { ...edgeWin, id: 'opera' as const, name: 'Opera', singleProfile: true, extensionsUrl: 'chrome://extensions' }

    assert.deepEqual(planExtensionsPageLaunch({ browser: opera, profileDir: 'Default' }, 'win32')?.args, ['chrome://extensions'])
    assert.deepEqual(planExtensionsPageLaunch({ browser: edgeWin, profileDir: null }, 'win32')?.args, ['edge://extensions'])
  })

  test('unsupported browsers and browsers without a binary cannot be planned', () => {
    assert.equal(planExtensionsPageLaunch({ browser: { ...chromeMac, supported: false }, profileDir: null }, 'darwin'), null)
    assert.equal(planExtensionsPageLaunch({ browser: { ...edgeWin, executable: null }, profileDir: null }, 'win32'), null)
    assert.equal(planExtensionsPageLaunch({ browser: { ...chromeMac, appPath: null, executable: null }, profileDir: null }, 'darwin'), null)
  })
})

describe('openExtensionsPage', () => {
  test('reports the spawn outcome instead of throwing', async () => {
    const calls: Array<[string, string[]]> = []

    const ok = await openExtensionsPage({ browser: edgeWin, profileDir: 'Default' }, 'win32', async (file, args) => {
      calls.push([file, args])
    })

    assert.equal(ok.ok, true)
    assert.equal(calls.length, 1)

    const failed = await openExtensionsPage({ browser: edgeWin, profileDir: 'Default' }, 'win32', async () => {
      throw new Error('ENOENT')
    })

    assert.equal(failed.ok, false)
    assert.equal(failed.error, 'ENOENT')
    assert.ok(failed.command)

    const unplannable = await openExtensionsPage({ browser: { ...edgeWin, executable: null }, profileDir: null }, 'win32')

    assert.deepEqual(unplannable, { ok: false, command: null, error: 'browser-not-launchable' })
  })
})
