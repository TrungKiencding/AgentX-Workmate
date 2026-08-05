import assert from 'node:assert/strict'

import { test } from 'vitest'

import { expandWindowsEnvRefs, parseRegQueryValue, readWindowsUserEnvVar } from './windows-user-env'

// ── parseRegQueryValue ─────────────────────────────────────────────────────

test('parseRegQueryValue extracts a REG_SZ value', () => {
  const out = ['', 'HKEY_CURRENT_USER\\Environment', '    AGENTX_HOME    REG_SZ    F:\\AgentX Workmate\\data', ''].join('\r\n')
  assert.equal(parseRegQueryValue(out, 'AGENTX_HOME'), 'F:\\AgentX Workmate\\data')
})

test('parseRegQueryValue matches the name case-insensitively', () => {
  const out = 'HKEY_CURRENT_USER\\Environment\r\n    AgentX_Home    REG_EXPAND_SZ    %USERPROFILE%\\h\r\n'
  assert.equal(parseRegQueryValue(out, 'AGENTX_HOME'), '%USERPROFILE%\\h')
})

test('parseRegQueryValue preserves spaces inside the value', () => {
  const out = '    AGENTX_HOME    REG_SZ    C:\\Program Files\\AgentX Workmate\r\n'
  assert.equal(parseRegQueryValue(out, 'AGENTX_HOME'), 'C:\\Program Files\\AgentX Workmate')
})

test('parseRegQueryValue returns null when the value line is absent', () => {
  const out = 'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    C:\\x\r\n'
  assert.equal(parseRegQueryValue(out, 'AGENTX_HOME'), null)
  assert.equal(parseRegQueryValue('', 'AGENTX_HOME'), null)
  assert.equal(parseRegQueryValue('garbage', 'AGENTX_HOME'), null)
})

// ── expandWindowsEnvRefs ───────────────────────────────────────────────────

test('expandWindowsEnvRefs expands %VAR% case-insensitively', () => {
  assert.equal(expandWindowsEnvRefs('%UserProfile%\\h', { USERPROFILE: 'C:\\Users\\jeff' }), 'C:\\Users\\jeff\\h')
})

test('expandWindowsEnvRefs leaves literal paths and unknown refs intact', () => {
  assert.equal(expandWindowsEnvRefs('F:\\AgentX Workmate\\data', {}), 'F:\\AgentX Workmate\\data')
  assert.equal(expandWindowsEnvRefs('%NOPE%\\x', {}), '%NOPE%\\x')
})

// ── readWindowsUserEnvVar ──────────────────────────────────────────────────

test('readWindowsUserEnvVar returns null off Windows without spawning', () => {
  let spawned = false

  const exec = () => {
    spawned = true

    return ''
  }

  assert.equal(readWindowsUserEnvVar('AGENTX_HOME', { platform: 'linux', exec }), null)
  assert.equal(spawned, false)
})

test('readWindowsUserEnvVar queries HKCU\\Environment and expands the value', () => {
  const calls = []

  const exec = (cmd, args) => {
    calls.push([cmd, args])

    return 'HKEY_CURRENT_USER\\Environment\r\n    AGENTX_HOME    REG_EXPAND_SZ    %DRIVE%\\AgentX Workmate\r\n'
  }

  const value = readWindowsUserEnvVar('AGENTX_HOME', {
    platform: 'win32',
    env: { DRIVE: 'F:' },
    exec
  })

  assert.equal(value, 'F:\\AgentX Workmate')
  assert.deepEqual(calls, [['reg', ['query', 'HKCU\\Environment', '/v', 'AGENTX_HOME']]])
})

test('readWindowsUserEnvVar returns null when reg exits non-zero (value missing)', () => {
  const exec = () => {
    throw new Error('reg exited 1')
  }

  assert.equal(readWindowsUserEnvVar('AGENTX_HOME', { platform: 'win32', exec }), null)
})

test('readWindowsUserEnvVar returns null for an empty value', () => {
  const exec = () => '    AGENTX_HOME    REG_SZ    \r\n'
  assert.equal(readWindowsUserEnvVar('AGENTX_HOME', { platform: 'win32', exec }), null)
})
