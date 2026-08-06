/**
 * Tests for electron/keycloak-session-store.ts.
 *
 * The property this file exists to protect: the storage key must be stable
 * across launches. The desktop's local backend is spawned with `--port 0`, so
 * its base URL carries a different ephemeral port every time — keying on it (as
 * the gateway-brokered store does) would ask the user to sign in on every
 * single app start.
 */

import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { keycloakStorageKey, loadKeycloakSession, persistKeycloakSession } from './keycloak-session-store'
import type { NativeTokenStoreIo } from './native-token-store'

const CONFIG = { issuer: 'https://agentx.example.com/auth/realms/agent-hub', clientId: 'agentx-workmate' }

const TOKENS = {
  accessToken: 'the-id-token',
  refreshToken: 'rt-1',
  expiresAt: 1_800_000_000,
  provider: 'keycloak',
  userId: 'kien-uuid'
}

/**
 * An in-memory stand-in for the encrypted store. `encrypt`/`decrypt` are
 * reversible marker wrappers, not real crypto — production injects safeStorage.
 */
function makeIo(initialText = ''): NativeTokenStoreIo & { text: string; logs: string[] } {
  const io: any = {
    text: initialText,
    logs: [],
    encrypt: (plaintext: string) => ({ encoding: 'test', value: `enc:${plaintext}` }),
    decrypt: (secret: any) => String(secret?.value || '').replace(/^enc:/, ''),
    readStoreText: () => io.text,
    writeStoreText: (text: string) => {
      io.text = text
    },
    rememberLog: (line: string) => io.logs.push(line)
  }

  return io
}

describe('keycloakStorageKey', () => {
  test('is derived from issuer and client id', () => {
    assert.equal(
      keycloakStorageKey(CONFIG),
      'keycloak:https://agentx.example.com/auth/realms/agent-hub:agentx-workmate'
    )
  })

  test('is invariant across backend ports', () => {
    // The whole point: two launches, two ephemeral backend ports, one session.
    assert.equal(keycloakStorageKey(CONFIG), keycloakStorageKey({ ...CONFIG }))
  })

  test('tolerates a trailing slash on the issuer', () => {
    assert.equal(keycloakStorageKey({ ...CONFIG, issuer: `${CONFIG.issuer}/` }), keycloakStorageKey(CONFIG))
  })

  test('separates realms and clients', () => {
    assert.notEqual(keycloakStorageKey(CONFIG), keycloakStorageKey({ ...CONFIG, clientId: 'other-client' }))
    assert.notEqual(
      keycloakStorageKey(CONFIG),
      keycloakStorageKey({ ...CONFIG, issuer: 'https://agentx.example.com/auth/realms/other' })
    )
  })

  test('is namespaced away from the gateway-URL keys sharing the file', () => {
    assert.ok(keycloakStorageKey(CONFIG).startsWith('keycloak:'))
  })
})

describe('persist / load round trip', () => {
  test('a stored session comes back intact', () => {
    const io = makeIo()

    persistKeycloakSession(CONFIG, TOKENS, io)

    assert.deepEqual(loadKeycloakSession(CONFIG, io), TOKENS)
  })

  test('the refresh token is never written in plaintext', () => {
    const io = makeIo()

    persistKeycloakSession(CONFIG, TOKENS, io)

    // The encrypted marker is present; the raw value is not.
    assert.ok(io.text.includes('enc:'))
    assert.ok(!/"refreshToken":"rt-1"/.test(io.text))
  })

  test('null clears the session', () => {
    const io = makeIo()

    persistKeycloakSession(CONFIG, TOKENS, io)
    persistKeycloakSession(CONFIG, null, io)

    assert.equal(loadKeycloakSession(CONFIG, io), null)
  })

  test('nothing stored reads as null', () => {
    assert.equal(loadKeycloakSession(CONFIG, makeIo()), null)
  })

  test('another realm is not returned', () => {
    const io = makeIo()

    persistKeycloakSession(CONFIG, TOKENS, io)

    assert.equal(loadKeycloakSession({ ...CONFIG, clientId: 'other' }, io), null)
  })

  test('does not disturb entries written by the brokered flow', () => {
    const io = makeIo(JSON.stringify({ 'https://gw.example.com': { encoding: 'test', value: 'enc:{}' } }))

    persistKeycloakSession(CONFIG, TOKENS, io)

    const store = JSON.parse(io.text)

    assert.ok(store['https://gw.example.com'])
    assert.ok(store[keycloakStorageKey(CONFIG)])
  })

  test('an unusable keychain fails loudly rather than wiping the session', () => {
    const io = makeIo()

    persistKeycloakSession(CONFIG, TOKENS, io)

    io.encrypt = () => null

    assert.throws(() => persistKeycloakSession(CONFIG, TOKENS, io), /refusing to overwrite/i)
    // The good entry survived — a locked keychain must not cost the user their
    // refresh token.
    io.encrypt = (plaintext: string) => ({ encoding: 'test', value: `enc:${plaintext}` })
    assert.deepEqual(loadKeycloakSession(CONFIG, io), TOKENS)
  })

  test('an undecryptable blob reads as null and keeps the entry for retry', () => {
    const io = makeIo()

    persistKeycloakSession(CONFIG, TOKENS, io)
    io.decrypt = () => ''

    assert.equal(loadKeycloakSession(CONFIG, io), null)
    assert.ok(io.text.includes(keycloakStorageKey(CONFIG)))
  })

  test('a corrupt store file reads as empty rather than throwing', () => {
    assert.equal(loadKeycloakSession(CONFIG, makeIo('not json at all')), null)
  })
})
