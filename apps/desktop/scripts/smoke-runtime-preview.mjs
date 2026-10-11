#!/usr/bin/env node
// Exercises the actual copied .app and real backend with a fresh home and no dev tool PATH.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron } from '@playwright/test'

const desktop = path.resolve(import.meta.dirname, '..')
const production = process.argv.includes('--production')
const product = production ? 'AgentX Workmate' : 'AgentX Workmate Runtime Preview'
const release = path.join(desktop, production ? 'release' : 'release/runtime-preview')
const original = path.join(release, `mac-arm64/${product}.app`)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-preview-smoke-'))
const copied = path.join(sandbox, `Moved app with spaces/${product}.app`)
fs.mkdirSync(path.dirname(copied), { recursive: true })
const dmg = fs.readdirSync(release).find(name => name.endsWith('-mac-arm64.dmg'))
const mount = path.join(sandbox, 'mounted-dmg')
fs.mkdirSync(mount)
execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, path.join(release, dmg)], { stdio: 'ignore' })
try {
  execFileSync('/usr/bin/ditto', [path.join(mount, path.basename(original)), copied])
} finally {
  execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'ignore' })
}
const resources = path.join(copied, 'Contents/Resources')
const runtime = path.join(resources, production ? 'bundled-runtime' : 'runtime-preview')
const home = path.join(sandbox, 'agentx-home')
const userData = path.join(sandbox, 'desktop-data')
const env = {
  HOME: sandbox,
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR || '/tmp',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8',
  AGENTX_HOME: home,
  AGENTX_DESKTOP_USER_DATA_DIR: userData,
  AGENTX_DESKTOP_SKIP_QUIT_CONFIRM: '1'
}
const backendEnv = {
  ...env,
  PYTHONHOME: path.join(runtime, 'python'),
  PYTHONPATH: path.join(runtime, 'source'),
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  PATH: `${runtime}/bin:${runtime}/node/bin:${runtime}/python/bin:${env.PATH}`,
  AGENTX_LAZY_INSTALL_TARGET: path.join(home, 'runtime-preview-packages/python3.11-arm64')
}
let application
const report = { relocated: copied, checks: [], launches: [] }
try {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', copied])
  report.checks.push('relocated app signature verified')
  execFileSync(path.join(runtime, 'python/bin/python3.11'), ['-c', 'import ssl, sqlite3, ctypes, yaml, fastapi, uvicorn, ptyprocess; import hermes_cli.main, run_agent; print("backend imports OK")'], { cwd: sandbox, env: backendEnv, stdio: 'inherit' })
  execFileSync(path.join(runtime, 'node/bin/node'), ['--version'], { env, stdio: 'inherit' })
  execFileSync(path.join(runtime, 'bin/agent-browser'), ['--version'], { env, stdio: 'inherit' })
  report.checks.push('bundled Python/backend, Node, browser CLI run without developer PATH')
  if (production) {
    execFileSync(path.join(runtime, 'python/bin/python3.11'), ['-c', "from agent.i18n import t; from pathlib import Path; assert t('approval.denied', lang='vi') != 'approval.denied'; assert t('approval.denied', lang='vi') != t('approval.denied', lang='en'); assert Path('cli-config.yaml.example').is_file(); print('bundled translations and config template OK')"], { cwd: path.join(runtime, 'source'), env: backendEnv, stdio: 'inherit' })
    report.checks.push('real bundled backend loads Vietnamese translations and the config recovery template')
  }

  // First prove the untouched install reaches its normal sign-in gate.
  application = await _electron.launch({ executablePath: path.join(copied, `Contents/MacOS/${product}`), env, args: [], timeout: 60_000 })
  const firstPage = await application.firstWindow()
  await firstPage.waitForFunction(() => Boolean(window.agentxDesktop), { timeout: 60_000 })
  await assert.rejects(firstPage.evaluate(() => window.agentxDesktop.getConnection()), /sign-in required/)
  await firstPage.screenshot({ path: path.join(release, 'runtime-preview-sign-in.png') })
  report.checks.push('unconfigured fresh install starts bundled backend and reaches the normal sign-in gate')
  await application.close()
  application = null

  // Same sandbox-only config used by the existing E2E fixtures. No login bypass ships.
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'config.yaml'), 'dashboard:\n  require_auth: false\ndisplay:\n  language: en\nsecurity:\n  tirith_enabled: false\n')
  execFileSync(path.join(runtime, 'python/bin/python3.11'), ['-c', 'import json; from tools.terminal_tool import terminal_tool; r=json.loads(terminal_tool("printf runtime-preview-terminal-ok; node --version", workdir="/tmp", timeout=10)); assert r.get("exit_code") == 0, r; assert "runtime-preview-terminal-ok" in r.get("output", ""), r; print("real backend terminal tool OK")'], { cwd: sandbox, env: backendEnv, stdio: 'inherit', timeout: 30_000 })
  report.checks.push('real backend terminal tool executes commands with the bundled Node')

  for (let launch = 0; launch < 2; launch++) {
    const started = Date.now()
    application = await _electron.launch({ executablePath: path.join(copied, `Contents/MacOS/${product}`), env, args: [], timeout: 60_000 })
    const page = await application.firstWindow()
    await page.waitForFunction(() => Boolean(window.agentxDesktop), { timeout: 60_000 })
    const connection = await page.evaluate(() => window.agentxDesktop.getConnection())
    assert(connection?.url || connection?.wsUrl || connection?.port, `No real backend connection: ${JSON.stringify(connection)}`)
    const wsUrl = connection.wsUrl || connection.url
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => { ws.close(); reject(new Error('Real gateway session.list timed out')) }, 30_000)
      ws.addEventListener('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'session.list', params: {} })))
      ws.addEventListener('message', event => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 77) return
        clearTimeout(timer)
        ws.close()
        if (message.error) reject(new Error(`session.list failed: ${JSON.stringify(message.error)}`))
        else resolve()
      })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Real gateway WebSocket failed')) })
    })
    const bootstrap = await page.evaluate(() => window.agentxDesktop.getBootstrapState())
    assert.equal(bootstrap.active, false)
    assert.equal(bootstrap.error, null)
    assert.deepEqual(Object.keys(bootstrap.stages), [])
    const version = await page.evaluate(() => window.agentxDesktop.getVersion())
    assert.equal(fs.realpathSync(version.hermesRoot), fs.realpathSync(path.join(runtime, 'source')), 'Backend escaped the bundle')
    const updates = await page.evaluate(() => window.agentxDesktop.appUpdate.get())
    assert.equal(updates.blocked, production ? null : 'dev-build')
    if (launch === 0) {
      fs.writeFileSync(path.join(home, 'preview-retained-data.txt'), 'retain me')
      await page.screenshot({ path: path.join(release, 'runtime-preview-smoke.png') })
    } else {
      assert.equal(fs.readFileSync(path.join(home, 'preview-retained-data.txt'), 'utf8'), 'retain me')
    }
    assert(!fs.existsSync(path.join(home, 'agentx-agent')), 'Old installer ran')
    assert(!fs.existsSync(path.join(home, 'bootstrap-cache')), 'Old installer fetched a script')
    report.launches.push({ launch: launch + 1, backendReadyMs: Date.now() - started, backendInBundle: true, bootstrapSkipped: true })
    console.log(`Launch ${launch + 1}: real backend ready; no bootstrap`)
    await application.close()
    application = null
  }
  report.checks.push('fresh launch and restart retain user data; updater eligibility verified')
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = error.stack
  console.error(error)
  process.exitCode = 1
} finally {
  await application?.close().catch(() => undefined)
  // Retain diagnostics for a failure; a successful sandbox can be safely removed.
  const log = path.join(home, 'logs/desktop.log')
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(release, 'runtime-preview-smoke.log'))
  fs.writeFileSync(path.join(release, 'runtime-preview-smoke.json'), JSON.stringify(report, null, 2))
  if (report.ok) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
