import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import { bootstrapWebmate, readLocalWebmateStatus } from './bootstrap'
import { sha256Hex } from './release-feed'
import { buildZip } from './zip-writer.test-helper'

const REAL_KEY = fs
  .readFileSync(path.join(__dirname, 'extension-store.test.ts'), 'utf8')
  .match(/const REAL_KEY =\s*\n\s*'([^']+)'/)![1]

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webmate-boot-'))

  dirs.push(dir)

  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })))
})

async function stageBundle(appRoot: string, version: string) {
  const zip = buildZip([
    {
      name: 'manifest.json',
      data: JSON.stringify({ manifest_version: 3, name: 'AgentX WebMate', version, key: REAL_KEY })
    },
    { name: 'src/background.js', data: '// bg' }
  ])

  const dir = path.join(appRoot, 'build', 'webmate')

  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `agentx-webmate-chrome-${version}.zip`), zip)
  await fsp.writeFile(
    path.join(dir, 'release.json'),
    JSON.stringify({
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
    })
  )
}

describe('bootstrapWebmate', () => {
  test('a fresh machine ends up with the folder, workmate.json and pairing.json; a second boot changes nothing', async () => {
    const dir = await tempDir()
    const appRoot = path.join(dir, 'app')
    const home = path.join(dir, 'home', '.agentx', 'accounts', 'kien')
    const logs: string[] = []

    await stageBundle(appRoot, '1.0.4')

    const first = await bootstrapWebmate({
      agentxHome: home,
      resourcesPath: null,
      appRoot,
      appVersion: '0.21.0',
      isPackaged: false,
      log: m => logs.push(m)
    })

    assert.equal(first.error, null)
    assert.equal(first.bundledVersion, '1.0.4')
    assert.equal(first.extension?.action, 'installed')
    assert.equal(first.installedVersion, '1.0.4')
    assert.deepEqual(first.pairing, { pairingWritten: true, workmateJsonWritten: true, extensionPresent: true })
    assert.equal(
      first.paths.root,
      path.join(dir, 'home', '.agentx', 'webmate'),
      'anchored at the install root, not the account home'
    )

    const workmate = JSON.parse(await fsp.readFile(first.paths.workmateJson, 'utf8'))
    const pairing = JSON.parse(await fsp.readFile(first.paths.pairingFile, 'utf8'))

    assert.equal(workmate.token, pairing.token)
    assert.equal(workmate.wsUrl, 'ws://127.0.0.1:17374/extension')
    assert.equal(workmate.workmateVersion, '0.21.0')
    assert.equal(workmate.minServerVersion, '1.1.0')
    assert.equal(pairing.port, 17374)

    const second = await bootstrapWebmate({
      agentxHome: home,
      resourcesPath: null,
      appRoot,
      appVersion: '0.21.0',
      isPackaged: false
    })

    assert.equal(second.extension?.action, 'kept')
    assert.deepEqual(second.pairing, { pairingWritten: false, workmateJsonWritten: false, extensionPresent: true })
    assert.equal(JSON.parse(await fsp.readFile(first.paths.pairingFile, 'utf8')).token, pairing.token)

    const status = readLocalWebmateStatus(home)

    assert.equal(status.installedVersion, '1.0.4')
    assert.equal(status.pairingPresent, true)
    assert.equal(status.bridge, null, 'no MCP server has written state.json yet')
  })

  test('without a bundled package the pairing is still prepared and the missing folder is reported, not thrown', async () => {
    const dir = await tempDir()
    const appRoot = path.join(dir, 'app')
    const home = path.join(dir, 'home')

    const result = await bootstrapWebmate({
      agentxHome: home,
      resourcesPath: path.join(dir, 'resources'),
      appRoot,
      appVersion: '0.21.0',
      isPackaged: true
    })

    assert.equal(result.error, null)
    assert.equal(result.bundledVersion, null)
    assert.equal(result.extension?.action, 'skipped')
    assert.equal(result.installedVersion, null)
    assert.deepEqual(result.pairing, { pairingWritten: true, workmateJsonWritten: false, extensionPresent: false })
    assert.equal(fs.existsSync(result.paths.pairingFile), true)
  })

  test('a packaged app refuses an unsigned bundle and says so without failing the boot', async () => {
    const dir = await tempDir()
    const appRoot = path.join(dir, 'app')
    const resources = path.join(dir, 'resources')

    await stageBundle(appRoot, '1.0.4')
    await fsp.mkdir(path.join(resources, 'webmate'), { recursive: true })
    await fsp.cp(path.join(appRoot, 'build', 'webmate'), path.join(resources, 'webmate'), { recursive: true })

    const result = await bootstrapWebmate({
      agentxHome: path.join(dir, 'home'),
      resourcesPath: resources,
      appRoot: path.join(dir, 'elsewhere'),
      appVersion: '0.21.0',
      isPackaged: true
    })

    assert.match(String(result.error), /unsigned/)
    assert.equal(result.installedVersion, null)
    assert.equal(result.pairing?.pairingWritten, true, 'the pairing is still prepared for a later install')
  })
})
