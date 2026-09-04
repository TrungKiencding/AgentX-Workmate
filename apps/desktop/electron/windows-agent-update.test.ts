import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { decideInAppAgentUpdate, isInside } from './windows-agent-update'

const NSIS_EXE = 'C:\\Users\\kien\\AppData\\Local\\Programs\\AgentX Workmate\\AgentX Workmate.exe'
const CHECKOUT = 'C:\\Users\\kien\\AppData\\Local\\agentx\\agentx-agent'
const SOURCE_EXE = `${CHECKOUT}\\apps\\desktop\\release\\win-unpacked\\AgentX Workmate.exe`

const context = (over: Partial<Parameters<typeof decideInAppAgentUpdate>[0]> = {}) => ({
  execPath: NSIS_EXE,
  updateRoot: CHECKOUT,
  isPackaged: true,
  platform: 'win32',
  hasStagedUpdater: false,
  ...over
})

describe('isInside', () => {
  test('a path under the checkout is inside it', () => {
    assert.equal(isInside(SOURCE_EXE, CHECKOUT), true)
  })

  test('the checkout is inside itself', () => {
    assert.equal(isInside(CHECKOUT, CHECKOUT), true)
  })

  test('an NSIS install is not inside the checkout', () => {
    assert.equal(isInside(NSIS_EXE, CHECKOUT), false)
  })

  test('case and separators do not decide the answer', () => {
    // process.execPath uses backslashes; a config-derived root may not, and
    // Windows does not care about case. Two spellings of one directory must
    // not read as two different installs.
    assert.equal(isInside(SOURCE_EXE.toUpperCase().replace(/\\/g, '/'), CHECKOUT), true)
    assert.equal(isInside(`${CHECKOUT}\\`, CHECKOUT), true)
  })

  test('a sibling directory sharing a prefix is not inside', () => {
    // `...\agentx-agent-old` starts with `...\agentx-agent` as a STRING. Only
    // a separator makes it containment, and getting this wrong would send a
    // second install down the wrong update path.
    assert.equal(isInside(`${CHECKOUT}-old\\apps\\desktop\\x.exe`, CHECKOUT), false)
  })

  test('empty inputs are never containment', () => {
    assert.equal(isInside('', CHECKOUT), false)
    assert.equal(isInside(NSIS_EXE, ''), false)
  })
})

describe('decideInAppAgentUpdate', () => {
  test('an NSIS install with no staged updater updates in-app', () => {
    // The case the whole module exists for: the agent used to sit at whatever
    // commit it was bootstrapped at, because the app could only print the
    // command and hope.
    assert.deepEqual(decideInAppAgentUpdate(context()), { inApp: true })
  })

  test('a source install keeps the hand-off, because it IS what gets rebuilt', () => {
    // Windows cannot replace a running image, so a desktop built from the
    // checkout must not try to update the checkout it was built from.
    assert.deepEqual(decideInAppAgentUpdate(context({ execPath: SOURCE_EXE })), {
      inApp: false,
      reason: 'built-from-checkout'
    })
  })

  test('a staged updater wins, because it also rebuilds and we cannot', () => {
    assert.deepEqual(decideInAppAgentUpdate(context({ hasStagedUpdater: true })), {
      inApp: false,
      reason: 'has-staged-updater'
    })
  })

  test('a dev run never mutates a checkout', () => {
    assert.deepEqual(decideInAppAgentUpdate(context({ isPackaged: false })), {
      inApp: false,
      reason: 'not-packaged'
    })
  })

  test('macOS and Linux are left to the path they already have', () => {
    for (const platform of ['darwin', 'linux']) {
      assert.deepEqual(decideInAppAgentUpdate(context({ platform })), {
        inApp: false,
        reason: 'not-windows'
      })
    }
  })

  test('the staged-updater check comes before the packaged check', () => {
    // Ordering is behaviour: a dev run WITH a staged updater must report the
    // updater, not "not packaged", or the reason in the log sends whoever
    // reads it looking at the wrong thing.
    assert.deepEqual(decideInAppAgentUpdate(context({ hasStagedUpdater: true, isPackaged: false })), {
      inApp: false,
      reason: 'has-staged-updater'
    })
  })
})
