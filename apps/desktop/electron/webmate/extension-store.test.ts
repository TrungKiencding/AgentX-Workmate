import assert from 'node:assert/strict'
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import {
  ensureExtensionFolder,
  extensionIdFromPublicKey,
  locateBundledExtension,
  readInstalledVersion,
  renameWithRetry,
  verifyBundledPackage
} from './extension-store'
import { WEBMATE_EXTENSION_ID, webmatePaths } from './paths'
import { sha256Hex, signingPayload } from './release-feed'
import { buildZip } from './zip-writer.test-helper'

// The real manifest key from WebMate's brand.config.json: its ID is the one
// Workmate is compiled against, so this doubles as a contract check.
const REAL_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAspeiZ2IcJ5uERe4tbeiXPMFPnJum+RWgvhGTj2z1c+TpZ1rzp8Movs7jrksZfmLLgAi9LlggNBDDp99T5l0/l3Qztn5OPGVRHAsBvNdHwjLPHyH7d3cBkueBKVAd5v4+AVWUM56/kJoAWipClvJgx0mN3OiBz8ArR+YRcAIshHIJVNqLWB3KbVDjKCApdlShmt9urzZX6sg3KzH/eaA8BTjuTedDzMQxa8Qgz/zuzbNYXRt6OePaQN2AXTIFnjhNh1yMFBvZBtnDk8WryC/Uia6p3JLJYSohkNtoIVt6Kgk4N/zOQs1EqgWxBE61hM6hv5p4cXOl/y0H9qFagqX7yQIDAQAB'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webmate-store-'))

  dirs.push(dir)

  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })))
})

function extensionZip(version: string, key: string = REAL_KEY): Buffer {
  return buildZip([
    { name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'AgentX WebMate', version, key }) },
    { name: 'src/', data: '' },
    { name: 'src/background.js', data: `// ${version}` }
  ])
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')

  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string
  }
}

function releaseFor(zip: Buffer, version: string, privatePem?: string) {
  const manifest: Record<string, unknown> = {
    schema: 1,
    version,
    publishedAt: '2026-09-09T00:00:00.000Z',
    chrome: {
      url: `https://github.com/astralxkienlt/agentx-webmate/releases/download/v${version}/agentx-webmate-chrome-${version}.zip`,
      sha256: sha256Hex(zip),
      bytes: zip.length
    },
    minWorkmate: '0.21.0',
    minProtocol: 3,
    notes: { vi: 'x', en: 'x' }
  }

  if (!privatePem) {
    return manifest
  }

  return { ...manifest, signature: `ed25519:${sign(null, signingPayload(manifest), createPrivateKey(privatePem)).toString('base64')}` }
}

async function bundleDir(dir: string, version: string, { zip, release }: { zip: Buffer; release?: Record<string, unknown> | null }) {
  const bundled = path.join(dir, 'bundled')

  await fsp.mkdir(bundled, { recursive: true })
  await fsp.writeFile(path.join(bundled, `agentx-webmate-chrome-${version}.zip`), zip)

  if (release) {
    await fsp.writeFile(path.join(bundled, 'release.json'), JSON.stringify(release))
  }

  return bundled
}

describe('extension store', () => {
  test('the real manifest key derives to the pinned extension ID', () => {
    assert.equal(extensionIdFromPublicKey(REAL_KEY), WEBMATE_EXTENSION_ID)
    assert.throws(() => extensionIdFromPublicKey(''), /empty/)
  })

  test('locateBundledExtension prefers the first directory with a Chrome zip and the newest version in it', async () => {
    const dir = await tempDir()
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')

    await fsp.mkdir(a)
    await fsp.mkdir(b)
    await fsp.writeFile(path.join(b, 'agentx-webmate-chrome-1.0.4.zip'), 'x')
    await fsp.writeFile(path.join(b, 'agentx-webmate-chrome-1.0.10.zip'), 'x')
    await fsp.writeFile(path.join(b, 'release.json'), '{}')

    assert.equal(locateBundledExtension([null, undefined, path.join(dir, 'missing'), a]), null, 'no zip anywhere')
    assert.deepEqual(locateBundledExtension([a, b]), {
      zipPath: path.join(b, 'agentx-webmate-chrome-1.0.10.zip'),
      releaseJsonPath: path.join(b, 'release.json'),
      version: '1.0.10'
    })
  })

  test('installs a fresh folder from a signed bundle and is a no-op afterwards', async () => {
    const dir = await tempDir()
    const paths = webmatePaths(path.join(dir, 'root'))
    const keys = keyPair()
    const zip = extensionZip('1.0.4')
    const bundled = await bundleDir(dir, '1.0.4', { zip, release: releaseFor(zip, '1.0.4', keys.privatePem) })
    const located = locateBundledExtension([bundled])!

    // The signature is checked against the embedded key; a test key signs as a
    // stranger, so a packaged app must refuse it while a source build may not.
    await assert.rejects(() => ensureExtensionFolder(paths, located, { isPackaged: true }), /signature does not verify/)
    assert.equal(fs.existsSync(paths.installDir), false, 'a refused package leaves nothing behind')
  })

  test('a source build installs an unsigned local bundle, verifies the sha256, and swaps versions by rename', async () => {
    const dir = await tempDir()
    const paths = webmatePaths(path.join(dir, 'root'))
    const logs: string[] = []
    const zip = extensionZip('1.0.4')
    const bundled = await bundleDir(dir, '1.0.4', { zip, release: releaseFor(zip, '1.0.4') })
    const first = await ensureExtensionFolder(paths, locateBundledExtension([bundled])!, { isPackaged: false, log: m => logs.push(m) })

    assert.equal(first.action, 'installed')
    assert.equal(first.installedVersion, '1.0.4')
    assert.deepEqual(first.verified, { sha256: true, signature: 'unsigned' })
    assert.equal(readInstalledVersion(paths.installDir), '1.0.4')
    assert.equal(await fsp.readFile(path.join(paths.installDir, 'src', 'background.js'), 'utf8'), '// 1.0.4')
    assert.equal(fs.existsSync(path.join(paths.versionsDir, '1.0.4')), false, 'the staged folder was renamed, not copied')

    const again = await ensureExtensionFolder(paths, locateBundledExtension([bundled])!, { isPackaged: false })

    assert.equal(again.action, 'kept')

    // A newer bundle replaces the folder; the old one is parked for rollback.
    const zip2 = extensionZip('1.0.5')
    const bundled2 = await bundleDir(path.join(dir, 'two'), '1.0.5', { zip: zip2, release: releaseFor(zip2, '1.0.5') })
    const updated = await ensureExtensionFolder(paths, locateBundledExtension([bundled2])!, { isPackaged: false, log: m => logs.push(m) })

    assert.equal(updated.action, 'updated')
    assert.equal(readInstalledVersion(paths.installDir), '1.0.5')
    assert.equal(readInstalledVersion(paths.prevDir), '1.0.4')
    assert.ok(logs.some(m => /updated 1\.0\.4 → 1\.0\.5/.test(m)))

    // An older bundle never downgrades.
    const older = await ensureExtensionFolder(paths, locateBundledExtension([bundled])!, { isPackaged: false })

    assert.equal(older.action, 'kept')
    assert.equal(readInstalledVersion(paths.installDir), '1.0.5')
  })

  test('refuses a bundle whose zip does not match release.json, whose key is wrong, or whose version lies', async () => {
    const dir = await tempDir()
    const paths = webmatePaths(path.join(dir, 'root'))
    const zip = extensionZip('1.0.4')

    const mismatched = await bundleDir(path.join(dir, 'm'), '1.0.4', { zip, release: releaseFor(extensionZip('1.0.4', 'AAAA'), '1.0.4') })

    await assert.rejects(() => ensureExtensionFolder(paths, locateBundledExtension([mismatched])!, { isPackaged: false }), /sha256/)

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const strangerKey = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const strangerSpki = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    void strangerKey
    const wrongKeyZip = extensionZip('1.0.4', strangerSpki)
    const wrongKey = await bundleDir(path.join(dir, 'k'), '1.0.4', { zip: wrongKeyZip, release: releaseFor(wrongKeyZip, '1.0.4') })

    await assert.rejects(() => ensureExtensionFolder(paths, locateBundledExtension([wrongKey])!, { isPackaged: false }), /expected extension ID/)
    assert.equal(fs.existsSync(path.join(paths.versionsDir, '1.0.4')), false, 'a refused stage is removed')

    const lyingZip = extensionZip('9.9.9')
    const lying = await bundleDir(path.join(dir, 'l'), '1.0.4', { zip: lyingZip, release: releaseFor(lyingZip, '1.0.4') })

    await assert.rejects(() => ensureExtensionFolder(paths, locateBundledExtension([lying])!, { isPackaged: false }), /version 9\.9\.9, expected 1\.0\.4/)

    const unsignedInPackagedApp = await bundleDir(path.join(dir, 'u'), '1.0.4', { zip, release: null })

    await assert.rejects(() => ensureExtensionFolder(paths, locateBundledExtension([unsignedInPackagedApp])!, { isPackaged: true }), /no release.json/)
    assert.equal(fs.existsSync(paths.installDir), false)
  })

  test('verifyBundledPackage accepts a manifest signed by the embedded key only', async () => {
    const dir = await tempDir()
    const zip = extensionZip('1.0.4')
    const keys = keyPair()
    const bundled = await bundleDir(dir, '1.0.4', { zip, release: releaseFor(zip, '1.0.4', keys.privatePem) })
    const located = locateBundledExtension([bundled])!

    await assert.rejects(() => verifyBundledPackage(located, zip, { isPackaged: false }), /signature does not verify/, 'a present-but-foreign signature is refused even in a source build')
    const unsigned = await bundleDir(path.join(dir, 'x'), '1.0.4', { zip, release: releaseFor(zip, '1.0.4') })
    const result = await verifyBundledPackage(locateBundledExtension([unsigned])!, zip, { isPackaged: false })

    assert.equal(result.signature, 'unsigned')
    assert.equal(result.release?.version, '1.0.4')
  })

  test('with no bundled package the folder is left alone', async () => {
    const dir = await tempDir()
    const paths = webmatePaths(path.join(dir, 'root'))
    const outcome = await ensureExtensionFolder(paths, null, { isPackaged: true })

    assert.equal(outcome.action, 'skipped')
    assert.equal(outcome.reason, 'no bundled package')
  })

  test('renameWithRetry retries only the busy-folder errors and gives up after the budget', async () => {
    const dir = await tempDir()

    await fsp.mkdir(path.join(dir, 'a'))
    await renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'), 2, 1)
    assert.equal(fs.existsSync(path.join(dir, 'b')), true)
    await assert.rejects(() => renameWithRetry(path.join(dir, 'nope'), path.join(dir, 'c'), 2, 1), /ENOENT/, 'non-busy errors surface at once')
  })
})
