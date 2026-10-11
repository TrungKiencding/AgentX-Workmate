/* global window */
// Native installed bundle, empty developer PATH, firewall blocks external IPv4.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron } from '@playwright/test'
assert.equal(process.platform, 'win32')
assert.equal(process.env.CI, 'true')
const production = process.argv.includes('--production')
const [executable, root, oldHome] = process.argv.slice(2).filter(value => !value.startsWith('--'))
assert.ok(path.resolve(root).startsWith(path.resolve(process.env.RUNNER_TEMP) + path.sep))
fs.mkdirSync(root, { recursive: true })
const home = path.join(root, 'user-home')
const runtime = path.join(path.dirname(executable), production ? 'resources/bundled-runtime' : 'resources/runtime-preview')
const source = path.join(runtime, 'source')
const python = path.join(runtime, 'python/python.exe')
const system = process.env.SystemRoot || process.env.SYSTEMROOT
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE'].includes(key.toUpperCase())))
Object.assign(env, { PATH: [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0'), system].join(';'), AGENTX_HOME: home, AGENTX_DESKTOP_USER_DATA_DIR: path.join(root, 'electron-data'), AGENTX_DESKTOP_SKIP_QUIT_CONFIRM: '1', AGENTX_DESKTOP_BOOT_FAKE: '0', PYTHONUTF8: '1' })
const backendEnv = { ...env, PYTHONHOME: path.join(runtime, 'python'), PYTHONPATH: source, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', AGENTX_LAZY_INSTALL_TARGET: path.join(home, 'runtime-preview-packages/python3.11-win32-x64'), PATH: [path.join(runtime,'bin'),path.join(runtime,'node'),path.join(runtime,'python'),path.join(runtime,'git/cmd'),path.join(runtime,'git/bin'),env.PATH].join(';') }
async function bounded(promise, label, milliseconds = 60000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function closeApplication() {
  const closing = app
  app = null
  if (!closing) return
  try { await bounded(closing.close(), 'Application shutdown', 15000) }
  catch (error) {
    try { execFileSync('taskkill.exe', ['/PID', String(closing.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    throw error
  }
}
function pythonRun(code) { return execFileSync(python, ['-c',code], { cwd: root, env: backendEnv, encoding:'utf8',timeout:60000 }) }
function cacheInventory(directory) {
  if (!fs.existsSync(directory)) return null
  const result = {}
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    result[entry.name] = entry.isDirectory() ? cacheInventory(file) : createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  }
  return result
}
const oldCache = oldHome ? cacheInventory(path.join(oldHome, 'bootstrap-cache')) : null
const report = { version: JSON.parse(fs.readFileSync(path.join(runtime,'runtime.json'),'utf8')).version, migrated: Boolean(oldHome), checks:[], launches:[] }
const rules = []
function powershell(script) {
  return execFileSync(path.join(system,'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {encoding:'utf8',timeout:30000})
}
async function gateway(url, method) {
  return new Promise((resolve,reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => { ws.close(); reject(Error('Gateway timed out')) },30000)
    ws.addEventListener('open',()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method,params:{}})))
    ws.addEventListener('message',event=>{
      const message=JSON.parse(String(event.data)); if(message.id!==1)return
      clearTimeout(timer);ws.close();message.error?reject(Error(JSON.stringify(message.error))):resolve(message.result)
    })
    ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Gateway connection failed'))})
  })
}
let app
try {
  for (const program of [executable, python, path.join(runtime,'node/node.exe'),path.join(runtime,'bin/uv.exe'),path.join(runtime,'bin/agent-browser.exe')]) {
    const name='WorkmateOffline-'+rules.length+'-'+path.basename(root)
    powershell(`New-NetFirewallRule -DisplayName '${name}' -Direction Outbound -Action Block -Program '${program.replaceAll("'","''")}' -RemoteAddress '0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','2000::/3','fc00::/7','fe80::/10' -ErrorAction Stop | Out-Null`)
    rules.push(name)
  }
  // Use literal IP so a DNS failure cannot masquerade as enforced offline mode.
  console.log(pythonRun("import socket; s=socket.socket(); s.settimeout(3); blocked=False\ntry: s.connect(('1.1.1.1',443))\nexcept OSError: blocked=True\nfinally: s.close()\nassert blocked, 'External network was not blocked'; print('offline enforcement verified')"))
  report.checks.push('external IPv4 and IPv6 blocked for packaged app/runtime and verified by socket probe')
  console.log(pythonRun('import ssl,sqlite3,ctypes,yaml,fastapi,uvicorn; import hermes_cli.main,run_agent; print("bundled backend imports OK")'))
  for (const tool of ['node/node.exe','bin/uv.exe','bin/agent-browser.exe','git/cmd/git.exe','git/bin/bash.exe']) {
    console.log(execFileSync(path.join(runtime,tool),['--version'],{env:backendEnv,encoding:'utf8',timeout:30000}).trim())
  }
  report.checks.push('Python/backend, Node, uv, browser CLI, Git and Bash run without developer PATH')
  if (!oldHome) {
    app=await _electron.launch({executablePath:executable,env,args:['--disable-gpu','--no-sandbox'],timeout:60000})
    const page=await app.firstWindow()
    await page.waitForFunction(()=>Boolean(window.agentxDesktop),{timeout:60000})
    await assert.rejects(bounded(page.evaluate(()=>window.agentxDesktop.getConnection()), 'Sign-in gate'),/sign-in required/)
    await page.screenshot({path:path.join(root,'sign-in.png')})
    await closeApplication()
    report.checks.push('fresh install reaches normal sign-in gate offline')
  } else {
    fs.cpSync(oldHome,home,{recursive:true})
  }
  fs.mkdirSync(home,{recursive:true})
  // Sandbox config only; packaged authentication policy is unchanged.
  fs.writeFileSync(path.join(home,'config.yaml'),'dashboard:\n  require_auth: false\ndisplay:\n  language: en\nsecurity:\n  tirith_enabled: false\nplugins:\n  enabled: []\n')
  console.log(pythonRun(`import json; from tools.terminal_tool import terminal_tool; r=json.loads(terminal_tool('echo runtime-preview-terminal-ok; node --version; git --version',workdir=${JSON.stringify(root)},timeout=20)); assert r.get('exit_code')==0,r; assert 'runtime-preview-terminal-ok' in r.get('output',''),r; print('real terminal tool OK')`))
  report.checks.push('real terminal tool runs bundled Node and Git')
  for (let launch=0;launch<3;launch++) {
    const started=Date.now()
    app=await _electron.launch({executablePath:executable,env,args:['--disable-gpu','--no-sandbox'],timeout:60000})
    const page=await app.firstWindow()
    await page.waitForFunction(()=>Boolean(window.agentxDesktop),{timeout:60000})
    const connection=await bounded(page.evaluate(()=>window.agentxDesktop.getConnection()), 'Backend connection')
    const sessions=await gateway(connection.wsUrl||connection.url,'session.list')
    if(oldHome) assert(JSON.stringify(sessions).includes('old-windows-session'),'Real gateway lost old session')
    const boot=await page.evaluate(()=>window.agentxDesktop.getBootstrapState())
    assert.equal(boot.active,false);assert.equal(boot.error,null);assert.deepEqual(Object.keys(boot.stages),[])
    const version=await page.evaluate(()=>window.agentxDesktop.getVersion())
    assert.equal(fs.realpathSync(version.hermesRoot),fs.realpathSync(source))
    assert.equal(version.appVersion,report.version)
    assert.equal((await page.evaluate(()=>window.agentxDesktop.appUpdate.get())).blocked,production ? null : 'dev-build')
    assert(!fs.existsSync(path.join(home,'agentx-agent')),'Downloaded managed backend')
    assert.deepEqual(cacheInventory(path.join(home,'bootstrap-cache')),oldCache,'Bundled launch created or changed bootstrap cache')
    const marker=path.join(home,'preview-data-marker.txt')
    if(launch===0) {fs.writeFileSync(marker,'keep user data');await page.screenshot({path:path.join(root,'running.png')})}
    else assert.equal(fs.readFileSync(marker,'utf8'),'keep user data')
    report.launches.push({launch:launch+1,backendReadyMs:Date.now()-started,bootstrapSkipped:true})
    await closeApplication()
  }
  report.checks.push('real gateway ready offline across three launches; data retained; updater eligibility verified')
  report.ok=true
} catch(error) {report.ok=false;report.error=error.stack;console.error(error);process.exitCode=1}
finally {
  await closeApplication().catch(error => { report.ok=false;report.shutdownError=String(error);process.exitCode=1 })
  for(const name of rules) powershell(`Remove-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue`)
  fs.writeFileSync(path.join(root,'runtime-smoke-report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
}
