/* global window */
/** Actual old Electron update IPC -> signed local feed -> real NSIS installer. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { chromium } from '@playwright/test'
import { build } from 'esbuild'
assert.equal(process.platform, 'win32')
assert.equal(process.env.CI, 'true')
const [executable, installer, root] = process.argv.slice(2)
assert.ok(root && path.resolve(root).startsWith(path.resolve(process.env.RUNNER_TEMP) + path.sep))
const state = JSON.parse(fs.readFileSync(path.join(root, 'synthetic-state.json'), 'utf8'))
const signingModule = path.join(root, 'signed-manifest.cjs')
await build({ entryPoints: [path.resolve(import.meta.dirname, '../electron/signed-manifest.ts')], outfile: signingModule, bundle: true, format: 'cjs', platform: 'node' })
const { signEd25519 } = createRequire(import.meta.url)(signingModule)
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
let feed
let downloads = 0
const server = http.createServer((req, res) => {
  if (req.url === '/release.json') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(feed))
  } else if (req.url === '/update.exe') {
    downloads++
    res.setHeader('content-length', fs.statSync(installer).size)
    fs.createReadStream(installer).pipe(res)
  } else { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
feed = { schema: 1, product: 'agentx-workmate', version: '1.0.10', publishedAt: new Date().toISOString(), notes: { vi: ['Kiểm thử cập nhật Windows'], en: ['Windows update test'] }, assets: { 'win32-x64': { url: `http://127.0.0.1:${port}/update.exe`, sha256: createHash('sha256').update(fs.readFileSync(installer)).digest('hex'), bytes: fs.statSync(installer).size } } }
feed.signature = signEd25519(feed, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
async function poll(fn, milliseconds = 180000) {
  const until = Date.now() + milliseconds
  let last
  while (Date.now() < until) {
    try { const value = await fn(); if (value) return value } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw last || Error('Windows update timed out')
}
const debugServer = http.createServer()
await new Promise(resolve => debugServer.listen(0, '127.0.0.1', resolve))
const debugPort = debugServer.address().port
await new Promise(resolve => debugServer.close(resolve))
// Direct launch avoids Playwright's Windows cmd wrapper and Node debugger.
const oldProcess = spawn(executable, ['--disable-gpu', '--no-sandbox', `--remote-debugging-port=${debugPort}`], { stdio: 'ignore', env: {
  ...process.env,
  AGENTX_HOME: path.join(root, 'agent-data'),
  AGENTX_DESKTOP_USER_DATA_DIR: path.join(root, 'desktop-data'),
  AGENTX_DESKTOP_APP_NAME: state.appName,
  AGENTX_DESKTOP_BOOT_FAKE: '1',
  AGENTX_DESKTOP_BOOT_FAKE_STEP_MS: '20',
  AGENTX_DESKTOP_UPDATE_FEED_URL: `http://127.0.0.1:${port}/release.json`,
  AGENTX_DESKTOP_UPDATE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString()
} })
let browser
let lastVersion = ''
const phases = []
const originalHash = createHash('sha256').update(fs.readFileSync(executable)).digest('hex')
try {
  browser = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1500 }), 60000)
  console.log('IPC: old Electron launched; backend simulated, updater real')
  const page = await poll(async () => {
    for (const candidate of browser.contexts().flatMap(context => context.pages())) {
      if (await candidate.evaluate(() => Boolean(window.agentxDesktop?.appUpdate)).catch(() => false)) return candidate
    }
    return null
  }, 60000)
  console.log('IPC: desktop update bridge ready')
  const oldVersion = (await page.evaluate(() => window.agentxDesktop.getVersion())).appVersion
  assert.equal(oldVersion, '1.0.5')
  await poll(async () => (await page.evaluate(() => window.agentxDesktop.appUpdate.get())).phase === 'available', 45000)
  console.log('IPC: update automatically detected')
  assert.equal(downloads, 0, 'Application downloaded without user choice')
  assert.equal((await page.evaluate(() => window.agentxDesktop.appUpdate.download())).phase, 'ready')
  console.log('IPC: explicit download verified')
  assert.equal(downloads, 1)
  assert.equal((await page.evaluate(() => window.agentxDesktop.appUpdate.install())).started, true)
  console.log('IPC: explicit install started')
  await poll(() => oldProcess.exitCode !== null, 60000)
  console.log('IPC: old process exited')
  phases.push('old-process-exited')
  const quoted = executable.replaceAll("'", "''")
  function powershell(code) {
    const prepared = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); " + code
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(prepared, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 }).trim()
  }
  await poll(() => {
    const value = powershell(`(Get-Item -LiteralPath '${quoted}').VersionInfo.ProductVersion`)
    if (value !== lastVersion) console.log('IPC: executable ProductVersion=' + JSON.stringify(value))
    lastVersion = value
    return value === '1.0.10.0'
  })
  console.log('IPC: executable version advanced')
  // Wait for --force-run, so we prove the installer restarted the new app.
  await poll(() => powershell(`@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${quoted}' }).Count`) !== '0')
  powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${quoted}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`)
  const report = { oldVersion, newVersion: '1.0.10', automaticCheck: true, noAutomaticDownload: true, explicitDownload: true, explicitInstall: true, oldProcessExited: true, newProcessRestarted: true, installerDownloads: downloads, scope: 'Real Windows x64 Electron update IPC and detached installer handoff; backend simulated for this test only; signed loopback feed carrying the released NSIS installer' }
  fs.writeFileSync(path.join(root, 'ipc-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} catch (error) {
  const command = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*Workmate*' -or $_.Name -eq 'cmd.exe' -or $_.Name -eq 'tasklist.exe' -or $_.Name -eq 'findstr.exe' } | Select-Object Name,ProcessId,ExecutablePath | ConvertTo-Json -Compress"
  let processes
  try { processes = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 }).trim() } catch { processes = 'probe failed' }
  const helperFiles = fs.readdirSync(process.env.RUNNER_TEMP).filter(file => /^agentx-update-.*\.cmd$/.test(file)).map(file => ({ file, text: fs.readFileSync(path.join(process.env.RUNNER_TEMP, file), 'utf8') }))
  const report = { ok: false, error: String(error), phases, lastVersion, executableChanged: createHash('sha256').update(fs.readFileSync(executable)).digest('hex') !== originalHash, processes, helperFiles }
  fs.writeFileSync(path.join(root, 'ipc-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  throw error
} finally {
  if (oldProcess.exitCode === null) {
    try { execFileSync('taskkill.exe', ['/PID', String(oldProcess.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* The test process may already have exited. */ }
  }
  await Promise.race([browser?.close().catch(() => {}), new Promise(resolve => { const timer = setTimeout(resolve, 3000); timer.unref() })])
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
