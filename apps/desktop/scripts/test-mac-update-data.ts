// Real macOS update service + DMG swap + bundled backend, entirely in a temporary home.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { chromium, _electron } from '@playwright/test'

import { createAppUpdateService } from '../electron/app-update/service'
import { signEd25519 } from '../electron/signed-manifest'

assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
const desktop = path.resolve(import.meta.dirname, '..')
const repo = path.resolve(desktop, '../..')
const release = path.join(desktop, 'release/runtime-preview')
const dmg = path.join(release, 'AgentXWorkmate-RuntimePreview-1.0.10-mac-arm64.dmg')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-update-data-'))
const home = path.join(sandbox, 'old user home')
const userData = path.join(sandbox, 'old desktop data')
const bundle = path.join(sandbox, "Applications with spaces/It's Workmate.app")
const executable = path.join(bundle, 'Contents/MacOS/AgentX Workmate Runtime Preview')
const report: Record<string, any> = {
  checks: [],
  sandbox,
  scope:
    'Real update service; old app process simulated; new packaged app and backend real. Synthetic legacy data, no real user credentials.'
}
fs.mkdirSync(path.dirname(executable), { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(home, { recursive: true })
fs.writeFileSync(
  path.join(bundle, 'Contents/Info.plist'),
  `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.agentx.workmate.runtime-preview</string><key>CFBundleShortVersionString</key><string>1.0.9</string></dict></plist>`
)
fs.writeFileSync(executable, '#!/bin/sh\nexec /bin/sleep 120\n', { mode: 0o755 })
const env = {
  HOME: sandbox,
  USER: process.env.USER!,
  TMPDIR: process.env.TMPDIR || '/tmp',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8',
  AGENTX_HOME: home,
  AGENTX_DESKTOP_USER_DATA_DIR: userData,
  AGENTX_DESKTOP_SKIP_QUIT_CONFIRM: '1'
}
const retained = new Map<string, string>()
function retain(file: string, value: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
  retained.set(file, value)
}
retain(
  path.join(home, 'config.yaml'),
  'dashboard:\n  require_auth: false\ndisplay:\n  language: en\nsecurity:\n  tirith_enabled: false\n'
)
retain(path.join(home, '.env'), '# synthetic credentials only\nMIGRATION_TEST_TOKEN=synthetic-test-value\n')
retain(path.join(home, 'memories/MEMORY.md'), 'Old memory: Tiếng Việt — dữ liệu phải được giữ.\n')
retain(
  path.join(home, 'skills/my-old-skill/SKILL.md'),
  '---\nname: my-old-skill\ndescription: migration test\n---\nKeep my skill.\n'
)
retain(path.join(home, 'plugins/migration-sentinel/notes.txt'), 'Keep user plugin files.\n')
retain(path.join(home, 'profiles/work/config.yaml'), 'display:\n  language: vi\n')
retain(path.join(home, 'profiles/work/.env'), 'MIGRATION_TEST_TOKEN=profile-synthetic\n')
retain(path.join(userData, 'zoom-state.json'), JSON.stringify({ zoomLevel: 0 }))
// Generate state through the source-install Python path, before replacing the shell.
execFileSync(
  path.join(repo, '.venv/bin/python'),
  [
    '-c',
    `
from pathlib import Path
import os
from hermes_state import SessionDB
for profile, sid in [('', 'migration-old-default'), ('profiles/work', 'migration-old-profile')]:
    db = SessionDB(Path(os.environ['AGENTX_HOME']) / profile / 'state.db')
    db.create_session(sid, 'desktop', model='test-model')
    db.set_session_title(sid, 'Lịch sử cũ — ' + sid)
    db.append_message(sid, 'user', 'Tin nhắn cũ tiếng Việt')
    db.append_message(sid, 'assistant', 'Câu trả lời được giữ nguyên')
    db.close()
`
  ],
  { env: { ...process.env, AGENTX_HOME: home }, cwd: repo }
)
retain(path.join(home, 'agentx-agent/.old-install-sentinel'), 'Old managed runtime remains untouched.\n')
const hash = createHash('sha256').update(fs.readFileSync(dmg)).digest('hex')
const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
let feed: Record<string, any>
let downloads = 0
const server = http.createServer((req, res) => {
  if (req.url === '/release.json') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(feed))
  } else if (req.url === '/preview.dmg') {
    downloads++
    res.setHeader('content-length', fs.statSync(dmg).size)
    fs.createReadStream(dmg).pipe(res)
  } else {
    res.writeHead(404)
    res.end()
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const url = `http://127.0.0.1:${port}`
feed = {
  schema: 1,
  product: 'agentx-workmate',
  version: '1.0.10',
  publishedAt: new Date().toISOString(),
  notes: { vi: ['Kiểm tra cập nhật'], en: ['Update test'] },
  assets: { 'darwin-arm64': { url: `${url}/preview.dmg`, sha256: hash, bytes: fs.statSync(dmg).size } }
}
feed.signature = signEd25519(feed, privateKey)
const debugServer = http.createServer()
await new Promise<void>(resolve => debugServer.listen(0, '127.0.0.1', resolve))
const debugPort = (debugServer.address() as { port: number }).port
await new Promise<void>(resolve => debugServer.close(() => resolve()))
let activeCount = 0
let quitCalled = false
const holder = spawn(executable, [], { stdio: 'ignore', env })
const service = createAppUpdateService({
  appVersion: '1.0.9',
  isPackaged: true,
  platform: 'darwin',
  arch: 'arm64',
  execPath: executable,
  userDataDir: userData,
  tempDir: sandbox,
  pid: holder.pid!,
  cwd: sandbox,
  argv: [`--remote-debugging-port=${debugPort}`],
  env: { ...env, AGENTX_DESKTOP_UPDATE_FEED_URL: `${url}/release.json`, AGENTX_DESKTOP_UPDATE_PUBLIC_KEY: publicKey },
  fetch,
  broadcast: () => {},
  log: line => console.log(line),
  activeWork: () => ({ count: activeCount, titles: activeCount ? ['Test running task'] : [] }),
  quitForHandoff: () => {
    quitCalled = true
    holder.kill('SIGTERM')
  },
  fileExists: fs.existsSync,
  isWritable: dir => {
    try {
      fs.accessSync(dir, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }
})
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
async function poll<T>(fn: () => Promise<T>, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    try {
      return await fn()
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  throw last
}
async function gateway(wsUrl: string, method: string, params = {}) {
  return new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`${method} timeout`))
    }, 30_000)
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method, params }))
    ws.onmessage = event => {
      const data = JSON.parse(String(event.data))
      if (data.id !== 9) return
      clearTimeout(timer)
      ws.close()
      if (data.error) reject(new Error(JSON.stringify(data.error)))
      else resolve(data.result)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('Gateway connection failed'))
    }
  })
}
async function verifyData(page: any) {
  await page.waitForFunction(() => Boolean(window.agentxDesktop), { timeout: 60_000 })
  const connection = await poll(() => page.evaluate(() => window.agentxDesktop.getConnection()))
  const sessions = await gateway(connection.wsUrl || connection.url, 'session.list')
  assert(JSON.stringify(sessions).includes('migration-old-default'), 'Old conversation missing from real gateway')
  const profileSessions = await gateway(connection.wsUrl || connection.url, 'session.list', { profile: 'work' })
  assert(
    JSON.stringify(profileSessions).includes('migration-old-profile'),
    'Named profile history missing from real gateway'
  )
  const version = await page.evaluate(() => window.agentxDesktop.getVersion())
  assert.equal(
    fs.realpathSync(version.hermesRoot),
    fs.realpathSync(path.join(bundle, 'Contents/Resources/runtime-preview/source'))
  )
  const bootstrap = await page.evaluate(() => window.agentxDesktop.getBootstrapState())
  assert.equal(bootstrap.active, false)
  assert.equal(bootstrap.error, null)
  for (const [file, value] of retained) assert.equal(fs.readFileSync(file, 'utf8'), value, `Changed user data: ${file}`)
  const runtime = path.join(bundle, 'Contents/Resources/runtime-preview')
  execFileSync(
    path.join(runtime, 'python/bin/python3.11'),
    [
      '-c',
      `
from pathlib import Path
import os, sqlite3
from hermes_state import SessionDB
for profile, sid in [('', 'migration-old-default'), ('profiles/work', 'migration-old-profile')]:
    db = SessionDB(Path(os.environ['AGENTX_HOME']) / profile / 'state.db')
    assert db.get_session(sid)['title'] == 'Lịch sử cũ — ' + sid
    messages = db.get_messages(sid)
    assert [m['content'] for m in messages] == ['Tin nhắn cũ tiếng Việt', 'Câu trả lời được giữ nguyên']
    db.close()
    conn = sqlite3.connect(Path(os.environ['AGENTX_HOME']) / profile / 'state.db')
    assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    conn.close()
`
    ],
    {
      env: {
        ...env,
        PYTHONHOME: path.join(runtime, 'python'),
        PYTHONPATH: path.join(runtime, 'source'),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1'
      },
      cwd: sandbox
    }
  )
}
function stopSandboxApps() {
  const ps = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
  for (const line of ps.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (match && match[2].includes(bundle + '/Contents/')) {
      try {
        process.kill(Number(match[1]), 'SIGTERM')
      } catch {}
    }
  }
}
try {
  await service.start()
  const bad = { ...feed, notes: { vi: ['Tampered'], en: ['Tampered'] } }
  const good = feed
  feed = bad
  assert((await service.updater.check()).checkError?.includes('signature'))
  feed = good
  assert.equal((await service.updater.check()).phase, 'available')
  const checkedAt = service.updater.getState().checkedAt!
  // Exercise the production 15-second startup check, without clicking Check.
  await poll(async () => {
    assert(service.updater.getState().checkedAt! > checkedAt)
    assert.equal(service.updater.getState().phase, 'available')
    return true
  }, 25_000)
  assert.equal(downloads, 0)
  assert.equal(quitCalled, false)
  report.checks.push(
    'scheduled startup check detects new version; tampered feed rejected; no download/install without user action'
  )
  await service.updater.download()
  assert.equal(service.updater.getState().phase, 'ready')
  activeCount = 1
  assert.equal((await service.updater.install()).started, false)
  assert.equal(quitCalled, false)
  activeCount = 0
  report.checks.push('real HTTP DMG download verified; installation deferred while work is active')
  assert.equal((await service.updater.install()).started, true)
  await poll(async () => {
    const outcome = JSON.parse(fs.readFileSync(path.join(userData, 'app-update-result.json'), 'utf8'))
    assert.equal(outcome.ok, true)
    return outcome
  })
  service.stop()
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
  browser = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1500 }))
  const page = await poll(async () => {
    const page = browser!.contexts()[0]?.pages()[0]
    assert(page)
    return page
  })
  await verifyData(page)
  // The renderer acknowledges the notice after showing it; durable state/logs
  // prove initialization consumed the pending result even after that acknowledgement.
  const settled = JSON.parse(fs.readFileSync(path.join(userData, 'app-update.json'), 'utf8'))
  assert.equal(settled.lastRunVersion, '1.0.10')
  assert.equal(settled.pendingInstall, undefined)
  assert(fs.readFileSync(path.join(home, 'logs/desktop.log'), 'utf8').includes('updated 1.0.9 → 1.0.10'))
  report.checks.push('real DMG mounted/staged/swapped and new Electron app relaunched; signature still valid')
  report.checks.push(
    'source-install conversation titles/messages and named-profile database readable by packaged backend; SQLite integrity OK'
  )
  await page.screenshot({ path: path.join(release, 'mac-update-data.png') })
  await browser.close()
  browser = undefined
  stopSandboxApps()
  await new Promise(resolve => setTimeout(resolve, 2000))
  application = await _electron.launch({ executablePath: executable, env, args: [], timeout: 60_000 })
  await verifyData(await application.firstWindow())
  await application.close()
  application = undefined
  const next = createAppUpdateService({
    appVersion: '1.0.10',
    isPackaged: true,
    platform: 'darwin',
    arch: 'arm64',
    execPath: executable,
    userDataDir: userData,
    tempDir: sandbox,
    pid: process.pid,
    cwd: sandbox,
    argv: [],
    env,
    fetch,
    broadcast: () => {},
    log: () => {},
    activeWork: () => ({ count: 0, titles: [] }),
    quitForHandoff: () => assert.fail('Unexpected quit'),
    fileExists: fs.existsSync,
    isWritable: () => true
  })
  await next.updater.initialize()
  assert.equal(next.updater.getState().lastInstallFailed, null)
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'app-update.json'), 'utf8')).lastRunVersion, '1.0.10')
  report.checks.push(
    'restart preserves config, synthetic secrets, memories, skills, plugin files, desktop preference and both histories; update outcome consumed successfully'
  )
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = String((error as Error).stack)
  console.error(error)
  process.exitCode = 1
} finally {
  service.stop()
  holder.kill('SIGTERM')
  await application?.close().catch(() => {})
  await browser?.close().catch(() => {})
  stopSandboxApps()
  await new Promise<void>(resolve => server.close(() => resolve()))
  const log = path.join(home, 'logs/desktop.log')
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(release, 'mac-update-data.log'))
  fs.writeFileSync(path.join(release, 'mac-update-data.json'), JSON.stringify(report, null, 2))
  if (report.ok) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  console.log(JSON.stringify(report, null, 2))
}
