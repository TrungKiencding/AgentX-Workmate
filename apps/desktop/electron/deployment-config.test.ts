import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import {
  type DeploymentSeedIo,
  envLineDefinesKey,
  LITELLM_ADMIN_KEY_ENV_VAR,
  parseDeploymentConfig,
  quoteEnvValue,
  seedDeploymentSecrets,
  upsertEnvAssignment
} from './deployment-config'

function memoryIo(initial: string | null = null): DeploymentSeedIo & { text: string | null; logs: string[] } {
  const io: any = {
    text: initial,
    logs: [],
    readText: () => io.text,
    writeText: (_path: string, value: string) => {
      io.text = value
    },
    rememberLog: (message: string) => io.logs.push(message)
  }

  return io
}

describe('parseDeploymentConfig', () => {
  test('reads a well-formed stamp', () => {
    const config = parseDeploymentConfig(JSON.stringify({ schemaVersion: 1, litellmAdminKey: 'sk-abc' }))

    assert.deepEqual(config, { litellmAdminKey: 'sk-abc' })
  })

  test('trims surrounding whitespace off the key', () => {
    const config = parseDeploymentConfig(JSON.stringify({ schemaVersion: 1, litellmAdminKey: '  sk-abc\n' }))

    assert.equal(config?.litellmAdminKey, 'sk-abc')
  })

  test('a build with no key parses to an empty key, not to null', () => {
    // Distinguishing "no stamp at all" from "a stamp carrying nothing" is what
    // lets the caller stay silent for a dev build and warn for a release one.
    const config = parseDeploymentConfig(JSON.stringify({ schemaVersion: 1, litellmAdminKey: '' }))

    assert.deepEqual(config, { litellmAdminKey: '' })
  })

  test('rejects a schema version this build does not understand', () => {
    assert.equal(parseDeploymentConfig(JSON.stringify({ schemaVersion: 2, litellmAdminKey: 'sk-abc' })), null)
  })

  test('rejects malformed and absent input', () => {
    assert.equal(parseDeploymentConfig('{not json'), null)
    assert.equal(parseDeploymentConfig(''), null)
    assert.equal(parseDeploymentConfig(null), null)
    assert.equal(parseDeploymentConfig('[]'), null)
  })
})

describe('envLineDefinesKey', () => {
  test('matches plain, exported, and indented assignments', () => {
    assert.equal(envLineDefinesKey('AGENTX_LITELLM_ADMIN_KEY=sk-1', LITELLM_ADMIN_KEY_ENV_VAR), true)
    assert.equal(envLineDefinesKey('export AGENTX_LITELLM_ADMIN_KEY=sk-1', LITELLM_ADMIN_KEY_ENV_VAR), true)
    assert.equal(envLineDefinesKey('   AGENTX_LITELLM_ADMIN_KEY=sk-1  ', LITELLM_ADMIN_KEY_ENV_VAR), true)
    assert.equal(envLineDefinesKey('export    AGENTX_LITELLM_ADMIN_KEY=sk-1', LITELLM_ADMIN_KEY_ENV_VAR), true)
  })

  test('an empty assignment still counts as the machine having spoken', () => {
    assert.equal(envLineDefinesKey('AGENTX_LITELLM_ADMIN_KEY=', LITELLM_ADMIN_KEY_ENV_VAR), true)
  })

  test('does not match a comment, a prefix, or another key', () => {
    assert.equal(envLineDefinesKey('# AGENTX_LITELLM_ADMIN_KEY=sk-1', LITELLM_ADMIN_KEY_ENV_VAR), false)
    assert.equal(envLineDefinesKey('AGENTX_LITELLM_ADMIN_KEY_OLD=sk-1', LITELLM_ADMIN_KEY_ENV_VAR), false)
    assert.equal(envLineDefinesKey('OTHER=sk-1', LITELLM_ADMIN_KEY_ENV_VAR), false)
  })
})

describe('quoteEnvValue', () => {
  test('leaves an ordinary key alone', () => {
    assert.equal(quoteEnvValue('sk-1234567890abcdef'), 'sk-1234567890abcdef')
  })

  test('quotes what dotenv would otherwise read as syntax', () => {
    assert.equal(quoteEnvValue('has space'), '"has space"')
    assert.equal(quoteEnvValue('trailing#comment'), '"trailing#comment"')
    assert.equal(quoteEnvValue('say "hi"'), '"say \\"hi\\""')
    assert.equal(quoteEnvValue(' padded '), '" padded "')
  })

  test('empty stays empty', () => {
    assert.equal(quoteEnvValue(''), '')
  })
})

describe('upsertEnvAssignment', () => {
  test('creates the first line of an absent file', () => {
    assert.equal(upsertEnvAssignment(null, 'K', 'v'), 'K=v\n')
  })

  test('appends without disturbing what is there', () => {
    assert.equal(upsertEnvAssignment('A=1\nB=2\n', 'K', 'v'), 'A=1\nB=2\nK=v\n')
  })

  test('adds the missing newline before appending', () => {
    assert.equal(upsertEnvAssignment('A=1', 'K', 'v'), 'A=1\nK=v\n')
  })

  test('refuses to touch a key the machine already assigns', () => {
    assert.equal(upsertEnvAssignment('K=mine\n', 'K', 'theirs'), null)
    assert.equal(upsertEnvAssignment('export K=mine\n', 'K', 'theirs'), null)
  })
})

describe('seedDeploymentSecrets', () => {
  test('writes the baked key into an empty home', () => {
    const io = memoryIo(null)

    const outcome = seedDeploymentSecrets({
      config: { litellmAdminKey: 'sk-baked' },
      envPath: '/home/.agentx/.env',
      io
    })

    assert.equal(outcome, 'seeded')
    assert.equal(io.text, 'AGENTX_LITELLM_ADMIN_KEY=sk-baked\n')
  })

  test('never overwrites a key the user already has', () => {
    const io = memoryIo('AGENTX_LITELLM_ADMIN_KEY=sk-mine\n')

    const outcome = seedDeploymentSecrets({
      config: { litellmAdminKey: 'sk-baked' },
      envPath: '/home/.agentx/.env',
      io
    })

    assert.equal(outcome, 'already-set')
    assert.equal(io.text, 'AGENTX_LITELLM_ADMIN_KEY=sk-mine\n')
  })

  test('a dev build with no baked key does nothing at all', () => {
    const io = memoryIo('A=1\n')

    const outcome = seedDeploymentSecrets({
      config: { litellmAdminKey: '' },
      envPath: '/home/.agentx/.env',
      io
    })

    assert.equal(outcome, 'no-secret')
    assert.equal(io.text, 'A=1\n')
    assert.deepEqual(io.logs, [])
  })

  test('a missing stamp is the same no-op', () => {
    const io = memoryIo('A=1\n')

    assert.equal(seedDeploymentSecrets({ config: null, envPath: '/x/.env', io }), 'no-secret')
    assert.equal(io.text, 'A=1\n')
  })

  test('a failed write is reported without leaking the value', () => {
    const io: any = memoryIo(null)

    io.writeText = () => {
      throw new Error('EACCES: permission denied')
    }

    const outcome = seedDeploymentSecrets({
      config: { litellmAdminKey: 'sk-baked' },
      envPath: '/home/.agentx/.env',
      io
    })

    assert.equal(outcome, 'failed')
    assert.equal(io.logs.length, 1)
    assert.match(io.logs[0], /could not seed/)
    assert.equal(io.logs.some((line: string) => line.includes('sk-baked')), false)
  })

  test('nothing logged on success carries the value either', () => {
    const io = memoryIo(null)

    seedDeploymentSecrets({ config: { litellmAdminKey: 'sk-baked' }, envPath: '/home/.agentx/.env', io })

    assert.equal(io.logs.some(line => line.includes('sk-baked')), false)
  })
})
