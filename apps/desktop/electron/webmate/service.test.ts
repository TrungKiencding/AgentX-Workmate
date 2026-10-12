import assert from 'node:assert/strict'
import fs, { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { readInstalledVersion } from './extension-store'
import { ensurePairing } from './pairing'
import { parseReleaseManifest, sha256Hex } from './release-feed'
import { WebmateService } from './service'
import { feedSummary, writeUpdateCheck } from './updater'
import { buildZip } from './zip-writer.test-helper'

const key = fs
  .readFileSync(path.join(__dirname, 'extension-store.test.ts'), 'utf8')
  .match(/const REAL_KEY =\s*\n\s*'([^']+)'/)![1]

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fsp.rm(root, { recursive: true, force: true })))
})

async function setup(fetchImpl?: typeof fetch) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'webmate-service-'))
  roots.push(root)

  const service = new WebmateService({
    agentxHome: root,
    appRoot: root,
    appVersion: '1.1.0',
    resourcesPath: null,
    isPackaged: false,
    broadcast: () => {},
    openPath: async () => '',
    writeClipboard: () => {},
    commandWaitMs: 5,
    fetchImpl
  })

  await fsp.mkdir(service.paths.installDir, { recursive: true })
  await fsp.writeFile(path.join(service.paths.installDir, 'manifest.json'), JSON.stringify({ version: '1.0.4', key }))
  const { pairing } = ensurePairing(service.paths, { port: 17374, workmateVersion: '1.1.0' })

  return { service, pairing }
}

test('a timed-out reset keeps the token and cancels the unclaimed reload operation', async () => {
  const { service, pairing } = await setup()
  await fsp.writeFile(
    service.paths.stateFile,
    JSON.stringify({
      pid: process.pid,
      listening: true,
      connected: true,
      extensionVersion: '1.0.4',
      installType: 'workmate'
    })
  )
  await assert.rejects(service.resetToken(), /not acknowledged/)
  assert.equal(JSON.parse(await fsp.readFile(service.paths.pairingFile, 'utf8')).token, pairing.token)
  const queued = await fsp.readdir(service.paths.commandsDir)

  const actions = await Promise.all(
    queued.map(async file => JSON.parse(await fsp.readFile(path.join(service.paths.commandsDir, file), 'utf8')).action)
  )

  assert.deepEqual(actions, ['resume'], 'a late drain/reload must not run against a reopened window')
})

test('reset waits behind an update download and writes its token into the final folder', async () => {
  let releaseDownload!: (response: Response) => void
  let enteredDownload!: () => void

  const downloading = new Promise<void>(resolve => {
    enteredDownload = resolve
  })

  const fetchImpl: typeof fetch = async () => {
    enteredDownload()

    return new Promise<Response>(resolve => {
      releaseDownload = resolve
    })
  }

  const { service, pairing } = await setup(fetchImpl)

  const zip = buildZip([
    { name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, version: '1.0.5', key }) }
  ])

  // This is the already-verified feed cache seam; signature verification is
  // independently exercised in updater.test.ts and the native integration.
  const release = parseReleaseManifest({
    schema: 1,
    version: '1.0.5',
    publishedAt: new Date().toISOString(),
    chrome: { url: 'https://example.test/webmate.zip', sha256: sha256Hex(zip), bytes: zip.length },
    minWorkmate: '0.21.0',
    minProtocol: 3,
    notes: {}
  })

  writeUpdateCheck(service.paths, { feed: feedSummary(release), available: true })
  const update = service.applyUpdate()
  await downloading
  let resetFinished = false

  const reset = service.resetToken().then(result => {
    resetFinished = true

    return result
  })

  await Promise.resolve()
  assert.equal(resetFinished, false)
  assert.equal(JSON.parse(await fsp.readFile(service.paths.pairingFile, 'utf8')).token, pairing.token)
  releaseDownload(new Response(Uint8Array.from(zip).buffer))
  assert.equal((await update).ok, true)
  assert.deepEqual(await reset, { ok: true, reloaded: false })
  const finalPairing = JSON.parse(await fsp.readFile(service.paths.pairingFile, 'utf8'))
  assert.notEqual(finalPairing.token, pairing.token)
  assert.equal(JSON.parse(await fsp.readFile(service.paths.workmateJson, 'utf8')).token, finalPairing.token)
  assert.equal(readInstalledVersion(service.paths.installDir), release.version)
})
