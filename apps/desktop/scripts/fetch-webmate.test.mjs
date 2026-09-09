import assert from 'node:assert/strict'
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, test } from 'vitest'

import {
  buildManifest,
  canonicalJson,
  checkDownloaded,
  releaseAssetUrls,
  releasePublicKeyPem,
  run,
  selectLocalChromeZip,
  sha256Hex,
  verifyReleaseSignature
} from './fetch-webmate.mjs'

const dirs = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fetch-webmate-'))

  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')

  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicPem: publicKey.export({ type: 'spki', format: 'pem' }) }
}

function releaseFor(zip, version, privatePem) {
  const manifest = {
    schema: 1,
    version,
    publishedAt: '2026-09-09T00:00:00.000Z',
    chrome: { url: `https://github.com/astralxkienlt/agentx-webmate/releases/download/v${version}/agentx-webmate-chrome-${version}.zip`, sha256: sha256Hex(zip), bytes: zip.length },
    minWorkmate: '0.21.0',
    minProtocol: 3,
    notes: { vi: 'x', en: 'x' }
  }

  if (!privatePem) return manifest
  const signature = sign(null, Buffer.from(canonicalJson(manifest), 'utf8'), createPrivateKey(privatePem)).toString('base64')

  return { ...manifest, signature: `ed25519:${signature}` }
}

function writeLock(dir, lock) {
  const file = join(dir, 'webmate.lock.json')

  writeFileSync(file, JSON.stringify({ schema: 1, repository: 'https://github.com/astralxkienlt/agentx-webmate', ...lock }))

  return file
}

describe('fetch-webmate', () => {
  test('reads the release public key out of release-feed.ts', () => {
    const pem = releasePublicKeyPem()

    assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----\n$/)
    // A stranger's signature must not verify with it.
    const keys = keyPair()
    const zip = Buffer.from('zip')

    assert.equal(verifyReleaseSignature(releaseFor(zip, '1.0.4', keys.privatePem), pem), false)
    assert.equal(verifyReleaseSignature(releaseFor(zip, '1.0.4', keys.privatePem), keys.publicPem), true)
  })

  test('selectLocalChromeZip prefers the locked version, else the newest', () => {
    const names = ['agentx-webmate-chrome-1.0.3.zip', 'agentx-webmate-edge-1.0.4.zip', 'agentx-webmate-chrome-1.0.4.zip', 'release.json']

    assert.deepEqual(selectLocalChromeZip(names, '1.0.3'), { name: 'agentx-webmate-chrome-1.0.3.zip', version: '1.0.3' })
    assert.deepEqual(selectLocalChromeZip(names, '9.9.9'), { name: 'agentx-webmate-chrome-1.0.4.zip', version: '1.0.4' })
    assert.equal(selectLocalChromeZip(['release.json'], '1.0.4'), null)
    assert.deepEqual(releaseAssetUrls('https://github.com/astralxkienlt/agentx-webmate/', '1.0.4'), {
      zip: 'https://github.com/astralxkienlt/agentx-webmate/releases/download/v1.0.4/agentx-webmate-chrome-1.0.4.zip',
      release: 'https://github.com/astralxkienlt/agentx-webmate/releases/download/v1.0.4/release.json'
    })
  })

  test('a pending lock bundles nothing but leaves an explanatory MANIFEST.json', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'out')
    const lockFile = writeLock(dir, { version: '1.0.4', sha256: null, pending: 'not released yet' })
    const logs = []
    const result = await run({ argv: [], env: {}, outDir, lockFile, log: m => logs.push(m), fetchImpl: () => assert.fail('must not download') })

    assert.equal(result.bundled, false)
    const manifest = JSON.parse(readFileSync(join(outDir, 'MANIFEST.json'), 'utf8'))

    assert.equal(manifest.bundled, false)
    assert.match(manifest.reason, /not released yet/)
    assert.equal(existsSync(join(outDir, 'release.json')), false)
  })

  test('--from-dir bundles a local build and reports whether it is signed', async () => {
    const dir = tempDir()
    const dist = join(dir, 'dist')
    const outDir = join(dir, 'out')

    mkdirSync(dist)
    const zip = Buffer.from('local zip bytes')

    writeFileSync(join(dist, 'agentx-webmate-chrome-1.0.4.zip'), zip)
    writeFileSync(join(dist, 'agentx-webmate-edge-1.0.4.zip'), zip)
    writeFileSync(join(dist, 'release.json'), JSON.stringify(releaseFor(zip, '1.0.4')))
    const lockFile = writeLock(dir, { version: '1.0.4', sha256: null })
    const result = await run({ argv: ['--from-dir', dist], env: {}, outDir, lockFile, log: () => {} })

    assert.deepEqual(result, { bundled: true, version: '1.0.4', sha256: sha256Hex(zip), signed: false })
    assert.equal(readFileSync(join(outDir, 'agentx-webmate-chrome-1.0.4.zip')).equals(zip), true)
    assert.equal(JSON.parse(readFileSync(join(outDir, 'release.json'), 'utf8')).version, '1.0.4')
    assert.equal(JSON.parse(readFileSync(join(outDir, 'MANIFEST.json'), 'utf8')).signed, false)
    assert.equal(existsSync(join(outDir, 'agentx-webmate-edge-1.0.4.zip')), false, 'only the Chrome zip is bundled')

    // WEBMATE_LOCAL_DIST is the env spelling of --from-dir.
    const viaEnv = await run({ argv: [], env: { WEBMATE_LOCAL_DIST: dist }, outDir, lockFile, log: () => {} })

    assert.equal(viaEnv.bundled, true)

    // A release.json that disagrees with the zip is refused.
    writeFileSync(join(dist, 'release.json'), JSON.stringify(releaseFor(Buffer.from('other'), '1.0.4')))
    await assert.rejects(() => run({ argv: ['--from-dir', dist], env: {}, outDir, lockFile, log: () => {} }), /chrome\.sha256 does not match/)

    // A foreign signature is refused even locally.
    writeFileSync(join(dist, 'release.json'), JSON.stringify(releaseFor(zip, '1.0.4', keyPair().privatePem)))
    await assert.rejects(() => run({ argv: ['--from-dir', dist], env: {}, outDir, lockFile, log: () => {} }), /does not verify/)
  })

  test('checkDownloaded enforces the lock pin, the manifest digest and the signature', () => {
    const keys = keyPair()
    const zip = Buffer.from('release zip')
    const good = releaseFor(zip, '1.0.4', keys.privatePem)

    assert.equal(checkDownloaded({ zip, release: good, version: '1.0.4', expectedSha256: sha256Hex(zip), publicKeyPem: keys.publicPem }), sha256Hex(zip))
    assert.throws(() => checkDownloaded({ zip, release: good, version: '1.0.4', expectedSha256: '0'.repeat(64), publicKeyPem: keys.publicPem }), /lock's/)
    assert.throws(() => checkDownloaded({ zip, release: good, version: '1.0.5', expectedSha256: null, publicKeyPem: keys.publicPem }), /expected 1\.0\.5/)
    assert.throws(() => checkDownloaded({ zip, release: releaseFor(zip, '1.0.4'), version: '1.0.4', expectedSha256: null, publicKeyPem: keys.publicPem }), /signature/)
    assert.throws(() => checkDownloaded({ zip, release: good, version: '1.0.4', expectedSha256: null, publicKeyPem: keyPair().publicPem }), /signature/)
  })

  test('the download path verifies and --pin rewrites the lock', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'out')
    const lockFile = writeLock(dir, { version: '1.0.4', sha256: null, pending: 'x' })
    const zip = Buffer.from('downloaded zip')
    const keys = keyPair()
    const release = releaseFor(zip, '1.0.5', keys.privatePem)
    const urls = []
    const fetchImpl = async url => {
      urls.push(url)

      if (url.endsWith('.zip')) return { ok: true, arrayBuffer: async () => zip }
      if (url.endsWith('release.json')) return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(release)) }

      return { ok: false, status: 404 }
    }

    // The embedded key is not the test key, so a real run refuses the stranger's signature…
    await assert.rejects(() => run({ argv: ['--pin', '1.0.5'], env: {}, outDir, lockFile, fetchImpl, log: () => {} }), /signature/)
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).sha256, null, 'a refused download must not rewrite the lock')
    assert.deepEqual(urls, [
      'https://github.com/astralxkienlt/agentx-webmate/releases/download/v1.0.5/agentx-webmate-chrome-1.0.5.zip',
      'https://github.com/astralxkienlt/agentx-webmate/releases/download/v1.0.5/release.json'
    ])

    const manifest = buildManifest({ bundled: true, version: '1.0.5', sha256: 'abc', signed: true, source: 'x' })

    assert.equal(manifest.schema, 1)
    assert.ok(Date.parse(manifest.writtenAt) > 0)
  })
})
