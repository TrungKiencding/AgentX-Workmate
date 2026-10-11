// Upgrade the real 1.0.5 Electron app through its own IPC, with real Keychain crypto.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { _electron, chromium } from '@playwright/test'
import { build } from 'esbuild'
import { signEd25519 } from '../electron/signed-manifest'
import { signAppAdHoc } from './sign-mac-adhoc.mjs'

const desktop = path.resolve(import.meta.dirname, '..')
const repo = path.resolve(desktop, '../..')
const production = process.argv.includes('--production')
const oldVersion = production ? '1.0.10' : '1.0.5'
const newVersion = production
  ? JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version
  : '1.0.10'
const release = path.join(desktop, production ? 'release' : 'release/runtime-preview')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-real-upgrade-'))
const home = path.join(sandbox, 'old-home')
const userData = path.join(sandbox, 'desktop-data')
const bundle = path.join(sandbox, "Applications with spaces/It's Workmate.app")
const newBundle = path.join(sandbox, 'new/AgentX Workmate.app')
const executable = path.join(bundle, 'Contents/MacOS/AgentX Workmate')
const appName = `Workmate Upgrade Test ${randomUUID()}`
const baseUrl = 'https://migration-test.invalid'
const storeFile = path.join(userData, 'native-oauth-tokens.json')
const tokens = {
  accessToken: 'synthetic-access-' + randomUUID(),
  refreshToken: 'synthetic-refresh-' + randomUUID(),
  expiresAt: Date.now() + 86_400_000,
  provider: 'keycloak',
  userId: 'test-user',
  email: 'test@example.invalid',
  displayName: 'Migration Test'
}
const report: Record<string, any> = {
  checks: [],
  sandbox,
  keychainTestName: appName,
  oldVersion,
  newVersion,
  realOldProcess: true,
  syntheticCredentials: true
}
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.writeFileSync(
  path.join(home, 'config.yaml'),
  'dashboard:\n  require_auth: false\nsecurity:\n  tirith_enabled: false\n  allow_lazy_installs: false\n'
)
const env = {
  HOME: os.homedir(),
  USER: process.env.USER!,
  TMPDIR: sandbox,
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8',
  AGENTX_HOME: home,
  AGENTX_DESKTOP_USER_DATA_DIR: userData,
  AGENTX_DESKTOP_APP_NAME: appName,
  AGENTX_DESKTOP_AGENTX_ROOT: repo,
  AGENTX_DESKTOP_SKIP_QUIT_CONFIRM: '1'
}
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
let server: http.Server | undefined
const tokensModule = path.join(sandbox, 'token-store.cjs')
const moduleUrl = tokensModule
async function poll<T>(fn: () => Promise<T>, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  throw last
}
function stopApps(signal: NodeJS.Signals = 'SIGTERM') {
  const canonicalBundle = fs.existsSync(bundle) ? fs.realpathSync(bundle) : bundle
  const lines = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n')
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/)
    if (m && (m[2].includes(bundle + '/Contents/') || m[2].includes(canonicalBundle + '/Contents/'))) {
      try {
        process.kill(Number(m[1]), signal)
      } catch {}
    }
  }
}
async function readToken(app: any) {
  await app.evaluate('globalThis.__name = value => value; undefined')
  return app.evaluate(
    async ({ safeStorage }: any, args: any) => {
      const fs = process.getBuiltinModule('node:fs')
      const require = process.getBuiltinModule('node:module').createRequire(args.moduleUrl)
      const store = require(args.moduleUrl)
      const loaded = store.loadNativeTokenSet(args.baseUrl, {
        readStoreText: () => fs.readFileSync(args.file, 'utf8'),
        writeStoreText: () => {
          throw Error('Unexpected write')
        },
        encrypt: () => {
          throw Error('Unexpected encrypt')
        },
        decrypt: (s: any) => safeStorage.decryptString(Buffer.from(s.value, 'base64'))
      })
      return {
        available: safeStorage.isEncryptionAvailable(),
        matches: JSON.stringify(loaded) === JSON.stringify(args.tokens)
      }
    },
    { moduleUrl, file: storeFile, baseUrl, tokens }
  )
}
async function gateway(wsUrl: string, method: string, params = {}) {
  return new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(Error('RPC timeout'))
    }, 30_000)
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method, params }))
    ws.onmessage = ev => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id !== 3) return
      clearTimeout(timer)
      ws.close()
      msg.error ? reject(Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(Error('RPC connection failed'))
    }
  })
}
try {
  await build({
    entryPoints: [path.join(desktop, 'electron/native-token-store.ts')],
    outfile: tokensModule,
    bundle: true,
    platform: 'node',
    format: 'cjs'
  })
  const mount = path.join(sandbox, 'old-dmg')
  fs.mkdirSync(mount)
  execFileSync(
    'hdiutil',
    [
      'attach',
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mount,
      process.env.AGENTX_TEST_OLD_DMG || path.join(desktop, 'release/AgentXWorkmate-mac-arm64.dmg')
    ],
    { stdio: 'ignore' }
  )
  try {
    execFileSync('ditto', [path.join(mount, 'AgentX Workmate.app'), bundle])
  } finally {
    execFileSync('hdiutil', ['detach', mount], { stdio: 'ignore' })
  }
  const dmg =
    process.env.AGENTX_TEST_UPGRADE_DMG ||
    (production
      ? path.join(release, `AgentXWorkmate-${newVersion}-mac-arm64.dmg`)
      : path.join(sandbox, 'new-release.dmg'))
  if (!process.env.AGENTX_TEST_UPGRADE_DMG && !production) {
    execFileSync('ditto', [path.join(release, 'mac-arm64/AgentX Workmate Runtime Preview.app'), newBundle])
    const plist = path.join(newBundle, 'Contents/Info.plist')
    for (const [key, value] of Object.entries({
      CFBundleIdentifier: 'com.agentx.workmate',
      CFBundleExecutable: 'AgentX Workmate',
      CFBundleDisplayName: 'AgentX Workmate',
      CFBundleName: 'AgentX Workmate'
    })) {
      execFileSync('plutil', ['-replace', key, '-string', value, plist])
    }
    fs.renameSync(
      path.join(newBundle, 'Contents/MacOS/AgentX Workmate Runtime Preview'),
      path.join(newBundle, 'Contents/MacOS/AgentX Workmate')
    )
    // Electron locates helpers by the main executable's product name. Keep
    // helper directories, executables and plist identities consistent as well.
    const frameworks = path.join(newBundle, 'Contents/Frameworks')
    for (const name of fs
      .readdirSync(frameworks)
      .filter(name => name.endsWith('.app') && name.includes('Runtime Preview'))) {
      const helper = path.join(frameworks, name)
      const helperInfo = path.join(helper, 'Contents/Info.plist')
      const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', helperInfo], { encoding: 'utf8' }))
      const newExe = info.CFBundleExecutable.replace(' Runtime Preview', '')
      fs.renameSync(
        path.join(helper, 'Contents/MacOS', info.CFBundleExecutable),
        path.join(helper, 'Contents/MacOS', newExe)
      )
      for (const key of ['CFBundleExecutable', 'CFBundleName', 'CFBundleDisplayName', 'CFBundleIdentifier']) {
        if (typeof info[key] === 'string')
          execFileSync('plutil', [
            '-replace',
            key,
            '-string',
            info[key].replace(' Runtime Preview', '').replace('.runtime-preview', ''),
            helperInfo
          ])
      }
      fs.renameSync(helper, path.join(frameworks, name.replace(' Runtime Preview', '')))
    }
    await signAppAdHoc(newBundle, {
      entitlements: path.join(desktop, 'electron/entitlements.mac.plist'),
      inheritEntitlements: path.join(desktop, 'electron/entitlements.mac.inherit.plist')
    })
    execFileSync(
      'hdiutil',
      [
        'create',
        '-srcfolder',
        newBundle,
        '-volname',
        'Workmate Upgrade Test',
        '-format',
        'UDZO',
        '-imagekey',
        'zlib-level=1',
        dmg
      ],
      { stdio: 'ignore' }
    )
  }
  const keys = generateKeyPairSync('ed25519')
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  let feed: any
  let downloads = 0
  server = http.createServer((req, res) => {
    if (req.url === '/release.json') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(feed))
    } else if (req.url === '/new.dmg') {
      downloads++
      res.setHeader('content-length', fs.statSync(dmg).size)
      fs.createReadStream(dmg).pipe(res)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  const debug = http.createServer()
  await new Promise<void>(resolve => debug.listen(0, '127.0.0.1', resolve))
  const debugPort = (debug.address() as any).port
  await new Promise<void>(resolve => debug.close(() => resolve()))
  feed = {
    schema: 1,
    product: 'agentx-workmate',
    version: newVersion,
    publishedAt: new Date().toISOString(),
    notes: { vi: ['Kiểm tra nâng cấp'], en: ['Upgrade test'] },
    assets: {
      'darwin-arm64': {
        url: `http://127.0.0.1:${port}/new.dmg`,
        sha256: createHash('sha256').update(fs.readFileSync(dmg)).digest('hex'),
        bytes: fs.statSync(dmg).size
      }
    }
  }
  feed.signature = signEd25519(feed, privateKey)
  const launchEnv = {
    ...env,
    AGENTX_DESKTOP_UPDATE_FEED_URL: `http://127.0.0.1:${port}/release.json`,
    AGENTX_DESKTOP_UPDATE_PUBLIC_KEY: publicKey
  }
  application = await _electron.launch({
    executablePath: executable,
    env: launchEnv,
    args: [`--remote-debugging-port=${debugPort}`],
    timeout: 60_000
  })
  const oldPage = await application.firstWindow()
  await oldPage.waitForFunction(() => Boolean(window.agentxDesktop))
  assert.equal((await oldPage.evaluate(() => window.agentxDesktop.getVersion())).appVersion, oldVersion)
  const oldConnection = await poll(() => oldPage.evaluate(() => window.agentxDesktop.getConnection()))
  await gateway(oldConnection.wsUrl || oldConnection.url, 'session.list')
  report.checks.push(`real ${oldVersion} Electron app and source backend started successfully`)
  await application.evaluate('globalThis.__name = value => value; undefined')
  await application.evaluate(
    async ({ safeStorage }: any, args: any) => {
      const fs = process.getBuiltinModule('node:fs')
      const require = process.getBuiltinModule('node:module').createRequire(args.moduleUrl)
      const store = require(args.moduleUrl)
      if (!safeStorage.isEncryptionAvailable()) throw Error('Keychain encryption unavailable')
      store.persistNativeTokenSet(args.baseUrl, args.tokens, {
        encrypt: (value: string) => ({
          encoding: 'safeStorage',
          value: safeStorage.encryptString(value).toString('base64')
        }),
        decrypt: (s: any) => safeStorage.decryptString(Buffer.from(s.value, 'base64')),
        readStoreText: () => fs.readFileSync(args.file, 'utf8'),
        writeStoreText: (text: string) => fs.writeFileSync(args.file, text, { mode: 0o600 })
      })
    },
    { moduleUrl, file: storeFile, baseUrl, tokens }
  )
  const encrypted = fs.readFileSync(storeFile, 'utf8')
  assert(!encrypted.includes(tokens.accessToken) && !encrypted.includes(tokens.refreshToken))
  assert.deepEqual(await readToken(application), { available: true, matches: true })
  // Create history through SessionDB while the real old app/backend are running.
  execFileSync(
    path.join(repo, '.venv/bin/python'),
    [
      '-c',
      `from pathlib import Path; import os; from hermes_state import SessionDB; d=SessionDB(Path(os.environ['AGENTX_HOME'])/'state.db'); d.create_session('real-old-session','desktop'); d.append_message('real-old-session','user','Lịch sử trước cập nhật'); d.append_message('real-old-session','assistant','Giữ dữ liệu cũ'); d.close()`
    ],
    { cwd: repo, env: { ...env, PYTHONPATH: repo } }
  )
  assert(
    JSON.stringify(await gateway(oldConnection.wsUrl || oldConnection.url, 'session.list')).includes('real-old-session')
  )
  report.checks.push(
    'old app encrypts synthetic native OAuth tokens through real macOS Keychain; no plaintext tokens on disk'
  )
  await poll(async () => {
    const s = await oldPage.evaluate(() => window.agentxDesktop.appUpdate.get())
    assert.equal(s.phase, 'available')
    return s
  }, 30_000)
  assert.equal(downloads, 0)
  assert.equal((await oldPage.evaluate(() => window.agentxDesktop.appUpdate.download())).phase, 'ready')
  const oldProcess = application.process()
  assert.equal((await oldPage.evaluate(() => window.agentxDesktop.appUpdate.install())).started, true)
  await poll(async () => {
    const r = JSON.parse(fs.readFileSync(path.join(userData, 'app-update-result.json'), 'utf8'))
    assert.equal(r.ok, true)
    return r
  })
  // The old app closed itself via its production update IPC and installer.
  await poll(async () => {
    assert(oldProcess.exitCode !== null)
    return true
  })
  application = undefined
  browser = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1500 }))
  const newPage = await poll(async () => {
    const p = browser!.contexts()[0]?.pages()[0]
    assert(p)
    return p
  })
  await newPage.waitForFunction(() => Boolean(window.agentxDesktop))
  const version = await newPage.evaluate(() => window.agentxDesktop.getVersion())
  assert.equal(version.appVersion, newVersion)
  assert.equal(
    fs.realpathSync(version.hermesRoot),
    fs.realpathSync(
      path.join(
        bundle,
        production ? 'Contents/Resources/bundled-runtime/source' : 'Contents/Resources/runtime-preview/source'
      )
    )
  )
  const connection = await poll(() => newPage.evaluate(() => window.agentxDesktop.getConnection()))
  assert(JSON.stringify(await gateway(connection.wsUrl || connection.url, 'session.list')).includes('real-old-session'))
  assert.equal(fs.readFileSync(storeFile, 'utf8'), encrypted)
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle])
  report.checks.push(
    `real ${oldVersion} app detected/downloaded/installed ${newVersion} via its own IPC, quit, and reopened new packaged backend; old history retained`
  )
  await browser.close()
  browser = undefined
  stopApps()
  await new Promise(resolve => setTimeout(resolve, 2000))
  application = await _electron.launch({ executablePath: executable, env: launchEnv, args: [], timeout: 60_000 })
  await application.firstWindow()
  assert.deepEqual(await readToken(application), { available: true, matches: true })
  assert.equal(fs.readFileSync(storeFile, 'utf8'), encrypted)
  report.checks.push(
    'new app decrypts and parses old access/refresh/user identity after restart using real Keychain; encrypted file unchanged'
  )
  await application.close()
  application = undefined
  report.ok = true
} catch (e) {
  report.ok = false
  report.error = String((e as Error).stack)
  console.error(e)
  process.exitCode = 1
} finally {
  if (!report.ok) stopApps('SIGKILL')
  await application?.close().catch(() => {})
  await browser?.close().catch(() => {})
  stopApps()
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
  // Exact unique test service only; never remove the user's real application key.
  try {
    execFileSync('security', ['delete-generic-password', '-s', `${appName} Safe Storage`], { stdio: 'ignore' })
    report.testKeychainItemRemoved = true
  } catch {
    report.testKeychainItemRemoved = false
  }
  const log = path.join(home, 'logs/desktop.log')
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(release, 'mac-real-upgrade.log'))
  fs.writeFileSync(path.join(release, 'mac-real-upgrade.json'), JSON.stringify(report, null, 2))
  if (report.ok) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  console.log(JSON.stringify(report, null, 2))
}
