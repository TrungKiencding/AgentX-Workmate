import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import fs, { promises as fsp } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { test } from 'vitest'
import WebSocket from 'ws'

import { WorkmateBrowserWindow } from './browser-window'
import { readInstalledVersion } from './extension-store'
import { ensurePairing } from './pairing'
import { webmatePaths } from './paths'
import { sha256Hex, signingPayload } from './release-feed'
import { WebmateService } from './service'
import { checkWebmateUpdate, readUpdateCheck } from './updater'
import { buildZip } from './zip-writer.test-helper'

const repo = path.resolve(__dirname, '../../../..')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const key = fs
  .readFileSync(path.join(__dirname, 'extension-store.test.ts'), 'utf8')
  .match(/const REAL_KEY =\s*\n\s*'([^']+)'/)![1]

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (condition()) {return}
    await sleep(50)
  }

  throw new Error(`timed out: ${label}`)
}

// Native smoke test, also run in the regular suite on macOS Chrome hosts.
// All credentials, profiles, files and sockets belong to this temporary home.
test.skipIf(!fs.existsSync(chrome))(
  'real Chrome and bundled MCP: reset, bundled live update, failed hello rollback',
  async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'workmate-webmate-e2e-'))
    const paths = webmatePaths(root)
    const appRoot = path.join(root, 'app')
    const probe = createServer().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const logs: string[] = []

    const manifest = (version: string) => ({
      manifest_version: 3,
      name: 'WebMate lifecycle test',
      version,
      key,
      permissions: ['storage'],
      background: { service_worker: 'background.js' }
    })

    const background = `
    (async () => {
      const stored = await chrome.storage.local.get('webbrainBridgeInstanceId');
      const instanceId = stored.webbrainBridgeInstanceId || crypto.randomUUID();
      await chrome.storage.local.set({ webbrainBridgeInstanceId: instanceId });
      const config = await (await fetch(chrome.runtime.getURL('workmate.json'))).json();
      const ws = new WebSocket(config.wsUrl);
      ws.onopen = () => ws.send(JSON.stringify({ type:'hello', client:'webbrain-extension', protocolVersion:3,
        version:chrome.runtime.getManifest().version, instanceId, browser:'Chrome test', installType:'workmate',
        signedIn:false, token:config.token, capabilities:['workmate_update_v1'] }));
      ws.onmessage = event => {
        const msg = JSON.parse(event.data);
        if (!msg.action) return;
        ws.send(JSON.stringify({ id:msg.id, ok:true, result:{busy:0} }));
        if (msg.action === 'workmate_reload') setTimeout(() => chrome.runtime.reload(), 50);
      };
    })();
  `

    await fsp.mkdir(paths.installDir, { recursive: true })
    await fsp.writeFile(path.join(paths.installDir, 'manifest.json'), JSON.stringify(manifest('1.0.10')))
    await fsp.writeFile(path.join(paths.installDir, 'background.js'), background)
    ensurePairing(paths, { port, workmateVersion: '1.1.0' })

    const bridge = spawn(process.execPath, [path.join(repo, 'optional-mcps/webmate/server/agentx-webmate-mcp.mjs')], {
      env: {
        ...process.env,
        WEBMATE_DIR: paths.root,
        WEBMATE_BRIDGE_PORT: String(port),
        WEBMATE_HEARTBEAT_INTERVAL_MS: '0',
        WEBMATE_PREPARE_UPDATE_TIMEOUT_MS: '100'
      },
      stdio: ['pipe', 'ignore', 'pipe']
    })

    bridge.stderr.on('data', chunk => logs.push(chunk.toString()))

    const window = new WorkmateBrowserWindow({
      spawn: (file, args) =>
        spawn(file, ['--headless=new', ...args], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }),
      log: message => logs.push(message)
    })

    const service = new WebmateService({
      agentxHome: root,
      appRoot,
      appVersion: '1.1.0',
      resourcesPath: null,
      isPackaged: false,
      bridgePort: port,
      browserWindow: window,
      helloTimeoutMs: 3_000,
      broadcast: () => {},
      openPath: async () => '',
      writeClipboard: () => {},
      log: message => logs.push(message)
    })

    let external: WebSocket | null = null
    let stopped = false
    let busy = 0
    const seen: string[] = []

    function dialExternal() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`)
      external = ws
      ws.on('error', () => {})
      ws.on('open', () => {
        const token = JSON.parse(fs.readFileSync(paths.pairingFile, 'utf8')).token
        ws.send(
          JSON.stringify({
            type: 'hello',
            client: 'webbrain-extension',
            protocolVersion: 3,
            version: readInstalledVersion(paths.installDir),
            browser: 'Edge test',
            instanceId: 'external',
            token,
            installType: 'workmate',
            signedIn: true,
            capabilities: ['workmate_update_v1']
          })
        )
      })
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString())

        if (!msg.action) {return}
        seen.push(msg.action)
        ws.send(JSON.stringify({ id: msg.id, ok: true, result: { busy: msg.payload?.resume ? 0 : busy } }))

        if (msg.action === 'workmate_reload') {setTimeout(() => ws.close(), 50)}
      })
      ws.on('close', () => {
        if (!stopped) {setTimeout(dialExternal, 100)}
      })
    }

    try {
      await until(() => service.status().serverRunning, 'bridge listener')
      const opened = await service.openWindow({ browserId: 'chrome' })
      assert.equal(opened.ok, true, opened.error ?? undefined)
      await until(() => service.status().connections.length === 1, 'CDP extension hello')
      const windowId = await window.instanceId()
      assert.ok(windowId)
      dialExternal()
      await until(() => service.status().connections.length === 2, 'external browser hello')
      const oldToken = JSON.parse(fs.readFileSync(paths.pairingFile, 'utf8')).token
      assert.deepEqual(await service.resetToken(), { ok: true, reloaded: true })
      assert.notEqual(JSON.parse(fs.readFileSync(paths.pairingFile, 'utf8')).token, oldToken)
      assert.equal(await window.instanceId(), windowId, 'same profile identity survives relaunch')
      assert.equal(window.isOpen(), true)
      assert.ok(service.status().connections.some(c => c.instanceId === windowId && c.paired))

      // Bootstrap the real signed extension shipped by the app while both
      // browser connections are live. This exercises the production zip.
      await fsp.mkdir(path.join(appRoot, 'build'), { recursive: true })
      await fsp.cp(path.join(repo, 'apps/desktop/build/webmate'), path.join(appRoot, 'build/webmate'), {
        recursive: true
      })
      busy = 2
      const blocked = await service.bootstrap()
      assert.equal(blocked.extension?.action, 'skipped')
      assert.equal(blocked.installedVersion, '1.0.10')
      assert.equal(window.isOpen(), true, 'a busy external browser must also protect the CDP window')
      busy = 0
      const boot = await service.bootstrap()
      assert.equal(boot.error, null)
      assert.equal(boot.extension?.action, 'updated', boot.extension?.reason)
      assert.equal(service.status().connections.length, 2)
      assert.ok(service.status().connections.every(c => c.extensionVersion === boot.bundledVersion))
      assert.ok(seen.includes('workmate_prepare_update') && seen.includes('workmate_reload'))

      // A different active browser saying hello must not mask our broken worker.
      const badVersion = '1.0.99'

      const zip = buildZip([
        { name: 'manifest.json', data: JSON.stringify(manifest(badVersion)) },
        { name: 'background.js', data: 'throw new Error("broken worker")' }
      ])

      const zipFile = path.join(root, 'broken.zip')
      await fsp.writeFile(zipFile, zip)
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')

      const release = {
        schema: 1,
        version: badVersion,
        publishedAt: new Date().toISOString(),
        chrome: { url: pathToFileURL(zipFile).href, sha256: sha256Hex(zip), bytes: zip.length },
        minWorkmate: '0.21.0',
        minProtocol: 3,
        notes: { en: 'test' }
      }

      const signature = `ed25519:${sign(null, signingPayload(release), privateKey).toString('base64')}`
      await checkWebmateUpdate({
        paths,
        appVersion: '1.1.0',
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        parseOptions: { allowFileUrls: true },
        fetchText: async () => JSON.stringify({ ...release, signature })
      })
      const failed = await service.applyUpdate()
      assert.equal(failed.ok, false)
      assert.equal(failed.rolledBack, true, failed.error ?? undefined)
      await until(
        () =>
          service.status().connections.length === 2 &&
          service.status().connections.every(c => c.extensionVersion === boot.bundledVersion),
        'rollback reconnects both browsers'
      )
      assert.equal(window.isOpen(), true)
      assert.ok(readUpdateCheck(paths).failedVersions.includes(badVersion))
      assert.equal(readInstalledVersion(paths.installDir), boot.bundledVersion)
    } catch (error) {
      throw new Error(`${String(error)}\n${logs.join('\n')}`)
    } finally {
      stopped = true
      external?.terminate()
      await service.stop()

      if (bridge.exitCode === null && bridge.signalCode === null) {
        const exited = once(bridge, 'exit')
        bridge.stdin.end()
        await exited
      }

      await fsp.rm(root, { recursive: true, force: true })
    }
  },
  60_000
)
