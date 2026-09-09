import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import type { WebmateCommandAction, WebmateLastCommand } from './commands'
import { readInstalledVersion } from './extension-store'
import { defaultPairingIo, type PairingFile } from './pairing'
import { webmatePaths } from './paths'
import { parseReleaseManifest, type ReleaseManifest, sha256Hex, signingPayload } from './release-feed'
import { readWebmateStatus, type WebmateLocalStatus } from './status'
import {
  applyPendingSwap,
  applyWebmateUpdate,
  checkWebmateUpdate,
  evaluateFeed,
  parseUpdateCheck,
  readUpdateCheck
} from './updater'
import { buildZip } from './zip-writer.test-helper'

// The real manifest key (its ID is the one Workmate is compiled against).
const REAL_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAspeiZ2IcJ5uERe4tbeiXPMFPnJum+RWgvhGTj2z1c+TpZ1rzp8Movs7jrksZfmLLgAi9LlggNBDDp99T5l0/l3Qztn5OPGVRHAsBvNdHwjLPHyH7d3cBkueBKVAd5v4+AVWUM56/kJoAWipClvJgx0mN3OiBz8ArR+YRcAIshHIJVNqLWB3KbVDjKCApdlShmt9urzZX6sg3KzH/eaA8BTjuTedDzMQxa8Qgz/zuzbNYXRt6OePaQN2AXTIFnjhNh1yMFBvZBtnDk8WryC/Uia6p3JLJYSohkNtoIVt6Kgk4N/zOQs1EqgWxBE61hM6hv5p4cXOl/y0H9qFagqX7yQIDAQAB'

const dirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webmate-updater-'))

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

const keys = generateKeyPairSync('ed25519')
const PUBLIC_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

function signedRelease(
  zip: Buffer,
  version: string,
  extra: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    schema: 1,
    version,
    publishedAt: '2026-09-09T00:00:00.000Z',
    chrome: {
      url: `https://example.com/agentx-webmate-chrome-${version}.zip`,
      sha256: sha256Hex(zip),
      bytes: zip.length
    },
    minWorkmate: '0.21.0',
    minProtocol: 3,
    notes: { vi: 'Bản mới', en: 'New release' },
    ...extra
  }

  doc.signature = `ed25519:${sign(null, signingPayload(doc), keys.privateKey).toString('base64')}`

  return doc
}

const PAIRING: PairingFile = {
  schema: 1,
  token: 't'.repeat(44),
  port: 17374,
  installId: 'install-1',
  createdAt: '2026-09-09T00:00:00.000Z'
}
const PAIRING_OPTIONS = { port: 17374, workmateVersion: '0.21.0' }

async function installFolder(root: string, version: string) {
  const paths = webmatePaths(root)

  await fsp.mkdir(paths.installDir, { recursive: true })
  await fsp.writeFile(path.join(paths.installDir, 'manifest.json'), JSON.stringify({ version, key: REAL_KEY }))
  await fsp.writeFile(path.join(paths.installDir, 'workmate.json'), '{}')

  return paths
}

/** A fake MCP server: answers commands by rewriting state.json like the real one. */
class FakeServer {
  connected: boolean
  extensionVersion: string
  commands: WebmateCommandAction[] = []
  busy = 0
  /** When true, the extension never comes back after a reload. */
  dieOnReload = false
  /** When true, commands are never acknowledged (server not running). */
  silent = false
  private seq = 0

  constructor(
    private readonly paths: ReturnType<typeof webmatePaths>,
    options: { connected: boolean; extensionVersion: string }
  ) {
    this.connected = options.connected
    this.extensionVersion = options.extensionVersion
    this.writeState(null)
  }

  writeState(lastCommand: WebmateLastCommand | null) {
    fs.mkdirSync(this.paths.root, { recursive: true })
    fs.writeFileSync(
      this.paths.stateFile,
      JSON.stringify({
        schema: 1,
        pid: process.pid,
        port: 17374,
        serverVersion: '1.1.0',
        listening: true,
        connected: this.connected,
        pairingRequired: true,
        browser: this.connected ? 'Chrome 152' : null,
        extensionVersion: this.connected ? this.extensionVersion : null,
        installType: this.connected ? 'workmate' : null,
        signedIn: this.connected ? true : null,
        protocolVersion: this.connected ? 3 : null,
        lastHelloAt: null,
        error: null,
        lastCommand,
        updatedAt: new Date().toISOString()
      })
    )
  }

  sendCommand = (action: WebmateCommandAction): string => {
    const id = `cmd-${++this.seq}`

    this.commands.push(action)

    if (this.silent) {
      return id
    }

    let outcome: Partial<WebmateLastCommand>

    if (!this.connected) {
      outcome = { ok: false, busy: 0, error: 'WEBMATE_NOT_CONNECTED' }
    } else if (action === 'prepare_update') {
      outcome =
        this.busy > 0
          ? { ok: false, busy: this.busy, error: `still ${this.busy} run(s) busy after 60000ms` }
          : { ok: true, busy: 0 }
    } else if (action === 'reload') {
      outcome = { ok: true }

      if (this.dieOnReload) {
        this.connected = false
      } else {
        // The extension reloads from the folder now in place.
        this.extensionVersion = readInstalledVersion(this.paths.installDir) ?? this.extensionVersion
      }
    } else {
      outcome = { ok: true, busy: 0 }
    }

    this.writeState({ id, action, ok: false, error: null, startedAt: 's', finishedAt: 'f', ...outcome })

    return id
  }

  waitForCommand = async (id: string): Promise<WebmateLastCommand | null> => {
    if (this.silent) {
      return null
    }

    const status = readWebmateStatus(this.paths)

    return status.lastCommand?.id === id ? status.lastCommand : null
  }

  readStatus = (): WebmateLocalStatus => readWebmateStatus(this.paths)
}

function applyDeps(
  paths: ReturnType<typeof webmatePaths>,
  server: FakeServer,
  release: ReleaseManifest,
  zip: Buffer,
  downloads: string[] = []
) {
  return {
    paths,
    release,
    pairing: PAIRING,
    pairingOptions: PAIRING_OPTIONS,
    download: async (url: string) => {
      downloads.push(url)

      return zip
    },
    readStatus: server.readStatus,
    sendCommand: server.sendCommand,
    waitForCommand: server.waitForCommand,
    sleep: async () => {},
    helloTimeoutMs: 50,
    helloPollMs: 1,
    renameRetries: 1,
    renameRetryDelayMs: 0
  }
}

describe('evaluateFeed', () => {
  const release = parseReleaseManifest(signedRelease(Buffer.from('x'), '1.0.5'))

  test('newer, not blocked, not failed → available; the floors are reported separately', () => {
    assert.deepEqual(
      evaluateFeed({
        release,
        installedVersion: '1.0.4',
        appVersion: '0.21.0',
        protocolVersion: 3,
        failedVersions: []
      }),
      {
        available: true,
        blockedByMinWorkmate: false,
        belowMinProtocol: false
      }
    )
    assert.equal(
      evaluateFeed({ release, installedVersion: '1.0.5', appVersion: '0.21.0', protocolVersion: 3, failedVersions: [] })
        .available,
      false
    )
    assert.equal(
      evaluateFeed({ release, installedVersion: null, appVersion: '0.21.0', protocolVersion: null, failedVersions: [] })
        .available,
      true
    )
    assert.equal(
      evaluateFeed({ release, installedVersion: '1.0.4', appVersion: '0.20.0', protocolVersion: 3, failedVersions: [] })
        .blockedByMinWorkmate,
      true
    )
    assert.equal(
      evaluateFeed({ release, installedVersion: '1.0.4', appVersion: '0.20.0', protocolVersion: 3, failedVersions: [] })
        .available,
      false
    )
    assert.equal(
      evaluateFeed({ release, installedVersion: '1.0.4', appVersion: '0.21.0', protocolVersion: 2, failedVersions: [] })
        .belowMinProtocol,
      true
    )
    assert.equal(
      evaluateFeed({
        release,
        installedVersion: '1.0.4',
        appVersion: '0.21.0',
        protocolVersion: 3,
        failedVersions: ['1.0.5']
      }).available,
      false
    )
  })
})

describe('checkWebmateUpdate', () => {
  test('caches a verified newer release as available, and an unreachable feed as an error without losing pending state', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const zip = extensionZip('1.0.5')
    const feed = signedRelease(zip, '1.0.5')

    const check = await checkWebmateUpdate({
      paths,
      appVersion: '0.21.0',
      fetchText: async () => JSON.stringify(feed),
      publicKeyPem: PUBLIC_PEM,
      protocolVersion: 3
    })

    assert.equal(check.ok, true)
    assert.equal(check.available, true)
    assert.equal(check.feed?.version, '1.0.5')
    assert.deepEqual(check.feed?.notes, { vi: 'Bản mới', en: 'New release' })
    assert.equal(check.installedVersion, '1.0.4')
    assert.equal(readUpdateCheck(paths).feed?.version, '1.0.5')

    const offline = await checkWebmateUpdate({
      paths,
      appVersion: '0.21.0',
      fetchText: async () => Promise.reject(new Error('ENOTFOUND')),
      publicKeyPem: PUBLIC_PEM
    })

    assert.equal(offline.ok, false)
    assert.match(offline.error ?? '', /ENOTFOUND/)
    assert.equal(offline.available, false)
    // The last good feed stays readable for the UI.
    assert.equal(offline.feed?.version, '1.0.5')
  })

  test('a feed signed by another key, or tampered, is "no feed"', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const zip = extensionZip('1.0.5')
    const feed = signedRelease(zip, '1.0.5')

    const wrongKey = await checkWebmateUpdate({
      paths,
      appVersion: '0.21.0',
      fetchText: async () => JSON.stringify(feed)
    })

    assert.equal(wrongKey.ok, false)
    assert.equal(wrongKey.available, false)
    assert.equal(wrongKey.feed, null)
    assert.match(wrongKey.error ?? '', /signature/)

    const tampered = { ...feed, version: '9.9.9' }
    const bad = await checkWebmateUpdate({
      paths,
      appVersion: '0.21.0',
      fetchText: async () => JSON.stringify(tampered),
      publicKeyPem: PUBLIC_PEM
    })

    assert.equal(bad.ok, false)
    assert.equal(bad.available, false)

    const notJson = await checkWebmateUpdate({
      paths,
      appVersion: '0.21.0',
      fetchText: async () => '<html>',
      publicKeyPem: PUBLIC_PEM
    })

    assert.equal(notJson.error, 'feed is not JSON')
  })

  test('a release this Workmate is too old for is reported blocked, and an old attached extension as mandatory', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const zip = extensionZip('1.0.5')
    const feed = signedRelease(zip, '1.0.5', { minWorkmate: '0.30.0' })

    const check = await checkWebmateUpdate({
      paths,
      appVersion: '0.21.0',
      fetchText: async () => JSON.stringify(feed),
      publicKeyPem: PUBLIC_PEM,
      protocolVersion: 2
    })

    assert.equal(check.blockedByMinWorkmate, true)
    assert.equal(check.available, false)
    assert.equal(check.belowMinProtocol, true)
  })

  test('parseUpdateCheck never throws', () => {
    assert.equal(parseUpdateCheck('nope').available, false)
    assert.deepEqual(parseUpdateCheck(JSON.stringify({ failedVersions: ['1.0.2', 3] })).failedVersions, ['1.0.2'])
  })
})

describe('applyWebmateUpdate', () => {
  test('browser closed: download, verify, extract, swap; previous folder kept for rollback', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const server = new FakeServer(paths, { connected: false, extensionVersion: '1.0.4' })
    const zip = extensionZip('1.0.5')
    const release = parseReleaseManifest(signedRelease(zip, '1.0.5'))
    const stages: string[] = []
    const downloads: string[] = []

    const outcome = await applyWebmateUpdate({
      ...applyDeps(paths, server, release, zip, downloads),
      onProgress: stage => void stages.push(stage)
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.live, false)
    assert.deepEqual(downloads, [release.chrome.url])
    assert.deepEqual(stages, ['download', 'verify', 'extract', 'swap', 'done'])
    assert.equal(readInstalledVersion(paths.installDir), '1.0.5')
    assert.equal(readInstalledVersion(paths.prevDir), '1.0.4')
    assert.deepEqual(server.commands, [])

    const workmateJson = JSON.parse(await fsp.readFile(paths.workmateJson, 'utf8'))

    assert.equal(workmateJson.token, PAIRING.token)
    assert.equal(fs.existsSync(path.join(paths.versionsDir, '1.0.5.zip')), false)

    const check = readUpdateCheck(paths)

    assert.equal(check.installedVersion, '1.0.5')
    assert.equal(check.lastApply?.ok, true)
    assert.equal(check.pendingVersion, null)
  })

  test('browser attached: drain, swap, reload, confirmed by a hello with the new version', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const server = new FakeServer(paths, { connected: true, extensionVersion: '1.0.4' })
    const zip = extensionZip('1.0.5')
    const release = parseReleaseManifest(signedRelease(zip, '1.0.5'))
    const stages: string[] = []

    const outcome = await applyWebmateUpdate({
      ...applyDeps(paths, server, release, zip),
      onProgress: stage => void stages.push(stage)
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.live, true)
    assert.deepEqual(server.commands, ['prepare_update', 'reload'])
    assert.deepEqual(stages, ['download', 'verify', 'extract', 'drain', 'swap', 'reload', 'confirm', 'done'])
    assert.equal(readInstalledVersion(paths.installDir), '1.0.5')
    assert.equal(readWebmateStatus(paths).extensionVersion, '1.0.5')
  })

  test('no hello after the reload: swap back, reload again, remember the version as failed', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const server = new FakeServer(paths, { connected: true, extensionVersion: '1.0.4' })

    server.dieOnReload = true
    const zip = extensionZip('1.0.5')
    const release = parseReleaseManifest(signedRelease(zip, '1.0.5'))

    const outcome = await applyWebmateUpdate(applyDeps(paths, server, release, zip))

    assert.equal(outcome.ok, false)
    assert.equal(outcome.stage, 'rollback')
    assert.equal(outcome.rolledBack, true)
    assert.deepEqual(server.commands, ['prepare_update', 'reload', 'reload'])
    assert.equal(readInstalledVersion(paths.installDir), '1.0.4')
    assert.equal(readInstalledVersion(path.join(paths.versionsDir, '1.0.5')), '1.0.5')
    assert.equal(fs.existsSync(paths.prevDir), false)

    const check = readUpdateCheck(paths)

    assert.deepEqual(check.failedVersions, ['1.0.5'])
    assert.equal(check.lastApply?.rolledBack, true)

    // The failed version is no longer offered.
    const recheck = await checkWebmateUpdate({
      paths,
      appVersion: '0.21.0',
      fetchText: async () => JSON.stringify(signedRelease(zip, '1.0.5')),
      publicKeyPem: PUBLIC_PEM
    })

    assert.equal(recheck.available, false)
    assert.equal(recheck.feed?.version, '1.0.5')
  })

  test('a zip whose sha256 differs from release.json is refused before anything is written', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const server = new FakeServer(paths, { connected: false, extensionVersion: '1.0.4' })
    const release = parseReleaseManifest(signedRelease(extensionZip('1.0.5'), '1.0.5'))
    const tampered = extensionZip('1.0.5', REAL_KEY.replace('A', 'B'))

    const outcome = await applyWebmateUpdate(applyDeps(paths, server, release, tampered))

    assert.equal(outcome.ok, false)
    assert.equal(outcome.stage, 'verify')
    assert.match(outcome.error ?? '', /sha256 mismatch/)
    assert.equal(readInstalledVersion(paths.installDir), '1.0.4')
    assert.equal(fs.existsSync(paths.versionsDir), false)
    assert.equal(readUpdateCheck(paths).lastApply?.ok, false)
  })

  test('a manifest whose key is not ours is refused after extraction', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const server = new FakeServer(paths, { connected: false, extensionVersion: '1.0.4' })
    const zip = extensionZip('1.0.5', REAL_KEY.replace('A', 'B'))
    const release = parseReleaseManifest(signedRelease(zip, '1.0.5'))

    const outcome = await applyWebmateUpdate(applyDeps(paths, server, release, zip))

    assert.equal(outcome.stage, 'extract')
    assert.match(outcome.error ?? '', /extension ID/)
    assert.equal(readInstalledVersion(paths.installDir), '1.0.4')
    assert.equal(fs.existsSync(path.join(paths.versionsDir, '1.0.5')), false)
  })

  test('a browser still busy after the drain deadline is left alone: resume, no swap', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const server = new FakeServer(paths, { connected: true, extensionVersion: '1.0.4' })

    server.busy = 2
    const zip = extensionZip('1.0.5')
    const release = parseReleaseManifest(signedRelease(zip, '1.0.5'))

    const outcome = await applyWebmateUpdate(applyDeps(paths, server, release, zip))

    assert.equal(outcome.ok, false)
    assert.equal(outcome.stage, 'drain')
    assert.deepEqual(server.commands, ['prepare_update', 'resume'])
    assert.equal(readInstalledVersion(paths.installDir), '1.0.4')
    assert.equal(fs.existsSync(path.join(paths.versionsDir, '1.0.5')), false)
  })

  test('a server that never acknowledges is treated as a closed browser', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const server = new FakeServer(paths, { connected: true, extensionVersion: '1.0.4' })

    server.silent = true
    const zip = extensionZip('1.0.5')
    const release = parseReleaseManifest(signedRelease(zip, '1.0.5'))

    const outcome = await applyWebmateUpdate(applyDeps(paths, server, release, zip))

    assert.equal(outcome.ok, true)
    assert.equal(outcome.live, false)
    assert.deepEqual(server.commands, ['prepare_update'])
    assert.equal(readInstalledVersion(paths.installDir), '1.0.5')
  })

  test('a fresh machine with no folder yet installs without a prev copy', async () => {
    const root = await tempRoot()
    const paths = webmatePaths(root)
    const server = new FakeServer(paths, { connected: false, extensionVersion: '' })
    const zip = extensionZip('1.0.5')
    const release = parseReleaseManifest(signedRelease(zip, '1.0.5'))

    const outcome = await applyWebmateUpdate(applyDeps(paths, server, release, zip))

    assert.equal(outcome.ok, true)
    assert.equal(readInstalledVersion(paths.installDir), '1.0.5')
    assert.equal(fs.existsSync(paths.prevDir), false)
  })
})

describe('applyPendingSwap', () => {
  test('finishes a deferred swap from the staged folder and clears pendingVersion', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const staged = path.join(paths.versionsDir, '1.0.5')

    await fsp.mkdir(staged, { recursive: true })
    await fsp.writeFile(path.join(staged, 'manifest.json'), JSON.stringify({ version: '1.0.5', key: REAL_KEY }))
    const io = defaultPairingIo()

    fs.mkdirSync(paths.root, { recursive: true })
    io.writeTextAtomic(paths.updateCheckFile, JSON.stringify({ schema: 1, pendingVersion: '1.0.5' }))

    assert.equal(await applyPendingSwap(webmatePaths(await tempRoot())), null, 'nothing pending elsewhere')

    const outcome = await applyPendingSwap(paths)

    assert.equal(outcome?.ok, true)
    assert.equal(readInstalledVersion(paths.installDir), '1.0.5')
    assert.equal(readInstalledVersion(paths.prevDir), '1.0.4')
    assert.equal(readUpdateCheck(paths).pendingVersion, null)
  })

  test('a pending version whose staged folder vanished is forgotten', async () => {
    const root = await tempRoot()
    const paths = await installFolder(root, '1.0.4')
    const io = defaultPairingIo()

    io.writeTextAtomic(paths.updateCheckFile, JSON.stringify({ schema: 1, pendingVersion: '1.0.5' }))
    assert.equal(await applyPendingSwap(paths), null)
    assert.equal(readUpdateCheck(paths).pendingVersion, null)
    assert.equal(readInstalledVersion(paths.installDir), '1.0.4')
  })
})
