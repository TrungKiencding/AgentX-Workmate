import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { targetsHostPlatform } from './run-electron-builder.mjs'

describe('targetsHostPlatform', () => {
  test('no platform flag means the host, which is electron-builder default', () => {
    assert.equal(targetsHostPlatform([], 'darwin'), true)
    assert.equal(targetsHostPlatform(['--dir'], 'darwin'), true)
  })

  test('a flag for the host platform still uses the local dist', () => {
    assert.equal(targetsHostPlatform(['--mac', 'dmg'], 'darwin'), true)
    assert.equal(targetsHostPlatform(['--win', 'nsis'], 'win32'), true)
    assert.equal(targetsHostPlatform(['--linux', 'AppImage'], 'linux'), true)
  })

  test('a cross-platform target does not', () => {
    // The regression: `npm run dist:win` on a Mac laid a macOS Electron.app
    // into win-unpacked/ and died renaming an electron.exe that never existed.
    assert.equal(targetsHostPlatform(['--win', 'nsis'], 'darwin'), false)
    assert.equal(targetsHostPlatform(['--linux'], 'darwin'), false)
    assert.equal(targetsHostPlatform(['--mac', 'dmg'], 'win32'), false)
  })

  test('short and long spellings both count', () => {
    assert.equal(targetsHostPlatform(['-w'], 'darwin'), false)
    assert.equal(targetsHostPlatform(['--windows'], 'darwin'), false)
    assert.equal(targetsHostPlatform(['-m'], 'darwin'), true)
    assert.equal(targetsHostPlatform(['--macos'], 'darwin'), true)
  })

  test('a multi-platform build that includes the host keeps the dist', () => {
    // The host half can use it; electron-builder fetches what it needs for
    // the rest, so the override is still worth passing.
    assert.equal(targetsHostPlatform(['--mac', '--win'], 'darwin'), true)
  })

  test('an arch flag is not a platform flag', () => {
    assert.equal(targetsHostPlatform(['--x64'], 'darwin'), true)
    assert.equal(targetsHostPlatform(['--win', 'nsis', '--x64'], 'darwin'), false)
  })
})
