import { generateKeyPairSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  canonicalJson,
  compareVersions,
  isSemver,
  sha256Hex,
  signEd25519,
  signingPayload,
  verifyEd25519Signature
} from './signed-manifest'

function ed25519Pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')

  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string
  }
}

describe('signed manifests', () => {
  it('produces the canonical form the external signers produce, byte for byte', () => {
    // Same vector as WebMate's test/workmate-install.test.mjs.
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, u: undefined })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}'
    )
    expect(canonicalJson([undefined])).toBe('[null]')
    expect(canonicalJson('x')).toBe('"x"')
  })

  it('signs over everything but the signature, and verifies what it signed', () => {
    const { privatePem, publicPem } = ed25519Pair()
    const manifest: Record<string, unknown> = { version: '1.0.4', notes: { vi: ['Mới'] } }

    manifest.signature = signEd25519(manifest, privatePem)

    expect(String(manifest.signature)).toMatch(/^ed25519:[A-Za-z0-9+/]+=*$/)
    expect(signingPayload(manifest).toString('utf8')).toBe('{"notes":{"vi":["Mới"]},"version":"1.0.4"}')
    expect(verifyEd25519Signature(manifest, publicPem)).toBe(true)
  })

  it('rejects a manifest changed after signing, including one with a field added', () => {
    const { privatePem, publicPem } = ed25519Pair()
    const manifest: Record<string, unknown> = { version: '1.0.4' }

    manifest.signature = signEd25519(manifest, privatePem)

    expect(verifyEd25519Signature({ ...manifest, version: '9.9.9' }, publicPem)).toBe(false)
    expect(verifyEd25519Signature({ ...manifest, extra: true }, publicPem)).toBe(false)
  })

  it('rejects another key, a malformed signature, and a key that is not Ed25519', () => {
    const signer = ed25519Pair()
    const other = ed25519Pair()
    const manifest: Record<string, unknown> = { version: '1.0.4' }

    manifest.signature = signEd25519(manifest, signer.privatePem)

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rsaPublic = rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string
    const rsaPrivate = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

    expect(verifyEd25519Signature(manifest, other.publicPem)).toBe(false)
    expect(verifyEd25519Signature({ ...manifest, signature: 'ed25519:AAAA' }, signer.publicPem)).toBe(false)
    expect(verifyEd25519Signature({ ...manifest, signature: 'rsa:abc' }, signer.publicPem)).toBe(false)
    expect(verifyEd25519Signature({ version: '1.0.4' }, signer.publicPem)).toBe(false)
    expect(verifyEd25519Signature(manifest, rsaPublic)).toBe(false)
    expect(verifyEd25519Signature(manifest, 'not a key')).toBe(false)
    expect(verifyEd25519Signature(null, signer.publicPem)).toBe(false)
    expect(() => signEd25519(manifest, rsaPrivate)).toThrow(/not an Ed25519/)
  })

  it('compares MAJOR.MINOR.PATCH numerically and sorts anything else lowest', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.4', '1.0.4')).toBe(0)
    expect(compareVersions('1.0.4-beta', '0.0.1')).toBeLessThan(0)
    expect(isSemver('1.0.4')).toBe(true)
    expect(isSemver('v1.0.4')).toBe(false)
    expect(isSemver(104)).toBe(false)
  })

  it('hashes with sha256', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
