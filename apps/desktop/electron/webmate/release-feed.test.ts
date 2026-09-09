import assert from 'node:assert/strict'
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'

import { describe, test } from 'vitest'

import {
  canonicalJson,
  compareVersions,
  parseReleaseManifest,
  sha256Hex,
  signingPayload,
  verifyReleaseManifest,
  WEBMATE_RELEASE_PUBLIC_KEY
} from './release-feed'

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')

  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string
  }
}

/** Sign the way WebMate's scripts/sign-release.mjs does. */
function signManifest(manifest: Record<string, any>, privatePem: string): Record<string, any> {
  const { signature: _old, ...rest } = manifest
  const signature = sign(null, signingPayload(rest), createPrivateKey(privatePem)).toString('base64')

  return { ...rest, signature: `ed25519:${signature}` }
}

function sampleManifest() {
  return {
    schema: 1,
    version: '1.0.4',
    publishedAt: '2026-09-09T00:00:00.000Z',
    chrome: {
      url: 'https://github.com/astralxkienlt/agentx-webmate/releases/download/v1.0.4/agentx-webmate-chrome-1.0.4.zip',
      sha256: sha256Hex(Buffer.from('zip bytes')),
      bytes: 9
    },
    minWorkmate: '0.21.0',
    minProtocol: 3,
    notes: { vi: 'Cài từ Workmate', en: 'Workmate install' }
  }
}

describe('release feed', () => {
  test('canonical JSON matches the WebMate signer byte for byte', () => {
    // Same vector as test/workmate-install.test.mjs in the WebMate repo.
    assert.equal(
      canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, u: undefined }),
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}'
    )
    assert.equal(canonicalJson([undefined]), '[null]')
    assert.equal(canonicalJson('x'), '"x"')
  })

  test('parses a good manifest and names what is wrong with a bad one', () => {
    const manifest = parseReleaseManifest(sampleManifest())

    assert.equal(manifest.version, '1.0.4')
    assert.equal(manifest.chrome.bytes, 9)
    assert.equal(manifest.notes.vi, 'Cài từ Workmate')

    const broken: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...sampleManifest(), schema: 2 }, /schema/],
      [{ ...sampleManifest(), version: '1.0' }, /MAJOR\.MINOR\.PATCH/],
      [{ ...sampleManifest(), chrome: { ...sampleManifest().chrome, url: 'http://insecure/x.zip' } }, /https/],
      [{ ...sampleManifest(), chrome: { ...sampleManifest().chrome, sha256: 'nope' } }, /sha256/],
      [{ ...sampleManifest(), chrome: { ...sampleManifest().chrome, bytes: 0 } }, /bytes/],
      [{ ...sampleManifest(), minWorkmate: 'latest' }, /minWorkmate/],
      [{ ...sampleManifest(), minProtocol: 0 }, /minProtocol/],
      [{ ...sampleManifest(), notes: null }, /notes/]
    ]

    for (const [raw, pattern] of broken) {
      assert.throws(() => parseReleaseManifest(raw), pattern)
    }
  })

  test('verifies a signed manifest and rejects every tampering', () => {
    const keys = keyPair()
    const other = keyPair()
    const signed = signManifest(sampleManifest(), keys.privatePem)

    assert.equal(verifyReleaseManifest(signed, keys.publicPem), true)
    assert.equal(verifyReleaseManifest(sampleManifest(), keys.publicPem), false, 'unsigned never verifies')
    assert.equal(verifyReleaseManifest(signed, other.publicPem), false, 'another key must not verify')

    // Key order in the file is irrelevant.
    const reordered = JSON.parse(
      JSON.stringify({
        signature: signed.signature,
        notes: signed.notes,
        minProtocol: 3,
        minWorkmate: '0.21.0',
        chrome: { bytes: 9, url: signed.chrome.url, sha256: signed.chrome.sha256 },
        publishedAt: signed.publishedAt,
        version: '1.0.4',
        schema: 1
      })
    )

    assert.equal(verifyReleaseManifest(reordered, keys.publicPem), true)

    const tampers: Array<(m: any) => void> = [
      m => {
        m.chrome.sha256 = sha256Hex(Buffer.from('other'))
      },
      m => {
        m.chrome.url = m.chrome.url.replace('astralxkienlt', 'attacker')
      },
      m => {
        m.version = '1.0.5'
      },
      m => {
        m.minWorkmate = '0.0.1'
      },
      m => {
        m.extra = 'smuggled field'
      },
      m => {
        m.signature = 'ed25519:' + Buffer.alloc(64).toString('base64')
      },
      m => {
        m.signature = m.signature.replace('ed25519:', 'rsa:')
      },
      m => {
        delete m.signature
      }
    ]

    for (const tamper of tampers) {
      const copy = JSON.parse(JSON.stringify(signed))

      tamper(copy)
      assert.equal(verifyReleaseManifest(copy, keys.publicPem), false)
    }
  })

  test('the embedded public key is a usable Ed25519 key that does not accept a stranger', () => {
    assert.match(
      WEBMATE_RELEASE_PUBLIC_KEY,
      /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----\n$/
    )
    const stranger = keyPair()
    const signed = signManifest(sampleManifest(), stranger.privatePem)

    assert.equal(verifyReleaseManifest(signed), false)
    assert.equal(verifyReleaseManifest(signed, WEBMATE_RELEASE_PUBLIC_KEY), false)
    assert.equal(verifyReleaseManifest('garbage'), false)
  })

  test('compareVersions orders semver and sinks junk', () => {
    assert.ok(compareVersions('1.0.4', '1.0.3') > 0)
    assert.ok(compareVersions('1.0.10', '1.0.9') > 0)
    assert.equal(compareVersions('1.0.4', '1.0.4'), 0)
    assert.ok(compareVersions('0.21.0', '1.0.0') < 0)
    assert.ok(compareVersions('nope', '0.0.1') < 0)
  })
})
