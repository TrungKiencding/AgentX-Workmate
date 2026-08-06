import assert from 'node:assert/strict'
import path from 'node:path'

import { describe, test } from 'vitest'

import {
  ADMIN_KEY_ENV_VAR,
  buildDeploymentConfig,
  maskKey,
  readEnvValue,
  resolveAdminKey,
  resolveAgentxHome
} from './write-deployment-config.mjs'

describe('resolveAgentxHome', () => {
  test('AGENTX_HOME wins', () => {
    assert.equal(resolveAgentxHome({ AGENTX_HOME: '/custom' }, 'darwin', '/Users/x'), '/custom')
  })

  test('posix falls back to ~/.agentx', () => {
    assert.equal(resolveAgentxHome({}, 'darwin', '/Users/x'), path.join('/Users/x', '.agentx'))
  })

  test('windows uses LOCALAPPDATA', () => {
    assert.equal(
      resolveAgentxHome({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\Users\\x'),
      path.join('C:\\Users\\x\\AppData\\Local', 'agentx')
    )
  })
})

describe('readEnvValue', () => {
  test('reads a plain assignment', () => {
    assert.equal(readEnvValue('A=1\nAGENTX_LITELLM_ADMIN_KEY=sk-abc\n', ADMIN_KEY_ENV_VAR), 'sk-abc')
  })

  test('reads the export form the CLI also accepts', () => {
    assert.equal(readEnvValue('export AGENTX_LITELLM_ADMIN_KEY=sk-abc\n', ADMIN_KEY_ENV_VAR), 'sk-abc')
  })

  test('unwraps quoted values', () => {
    assert.equal(readEnvValue('AGENTX_LITELLM_ADMIN_KEY="sk abc"\n', ADMIN_KEY_ENV_VAR), 'sk abc')
    assert.equal(readEnvValue("AGENTX_LITELLM_ADMIN_KEY='sk-abc'\n", ADMIN_KEY_ENV_VAR), 'sk-abc')
    assert.equal(readEnvValue('AGENTX_LITELLM_ADMIN_KEY="say \\"hi\\""\n', ADMIN_KEY_ENV_VAR), 'say "hi"')
  })

  test('skips comments and near-misses', () => {
    assert.equal(readEnvValue('# AGENTX_LITELLM_ADMIN_KEY=sk-no\n', ADMIN_KEY_ENV_VAR), '')
    assert.equal(readEnvValue('AGENTX_LITELLM_ADMIN_KEY_OLD=sk-no\n', ADMIN_KEY_ENV_VAR), '')
  })

  test('handles CRLF and absent input', () => {
    assert.equal(readEnvValue('A=1\r\nAGENTX_LITELLM_ADMIN_KEY=sk-abc\r\n', ADMIN_KEY_ENV_VAR), 'sk-abc')
    assert.equal(readEnvValue(null, ADMIN_KEY_ENV_VAR), '')
    assert.equal(readEnvValue('', ADMIN_KEY_ENV_VAR), '')
  })
})

describe('resolveAdminKey', () => {
  test('prefers the environment, so CI can pass a repo secret', () => {
    const resolved = resolveAdminKey({
      env: { [ADMIN_KEY_ENV_VAR]: 'sk-from-ci' },
      readFile: () => 'AGENTX_LITELLM_ADMIN_KEY=sk-from-disk\n',
      agentxHome: '/home/.agentx'
    })

    assert.deepEqual(resolved, { key: 'sk-from-ci', source: 'env' })
  })

  test('falls back to the build machine .env', () => {
    const resolved = resolveAdminKey({
      env: {},
      readFile: () => 'AGENTX_LITELLM_ADMIN_KEY=sk-from-disk\n',
      agentxHome: '/home/.agentx'
    })

    assert.equal(resolved.key, 'sk-from-disk')
    assert.equal(resolved.source, path.join('/home/.agentx', '.env'))
  })

  test('reports nothing found rather than guessing', () => {
    const resolved = resolveAdminKey({ env: {}, readFile: () => null, agentxHome: '/home/.agentx' })

    assert.deepEqual(resolved, { key: '', source: null })
  })

  test('an empty or whitespace value counts as absent', () => {
    assert.equal(resolveAdminKey({ env: { [ADMIN_KEY_ENV_VAR]: '   ' }, readFile: () => null }).key, '')
  })
})

describe('buildDeploymentConfig', () => {
  test('stamps the schema the reader checks', () => {
    assert.deepEqual(buildDeploymentConfig('sk-abc', '2026-01-01T00:00:00.000Z'), {
      schemaVersion: 1,
      litellmAdminKey: 'sk-abc',
      builtAt: '2026-01-01T00:00:00.000Z'
    })
  })

  test('a keyless build is still a valid stamp', () => {
    assert.equal(buildDeploymentConfig('', '2026-01-01T00:00:00.000Z').litellmAdminKey, '')
  })
})

describe('maskKey', () => {
  test('shows enough to identify, not enough to use', () => {
    const masked = maskKey('sk-1234567890abcdef')

    assert.equal(masked.includes('1234567890'), false)
    assert.match(masked, /^sk-1…cdef/)
  })

  test('refuses to reveal a short key at all', () => {
    assert.equal(maskKey('sk-12'), '****')
    assert.equal(maskKey(''), '(none)')
  })
})
