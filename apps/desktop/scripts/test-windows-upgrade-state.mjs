/** Real Windows DPAPI round trip across two published Electron executables.
 * Runs only on an ephemeral CI runner; credentials are synthetic.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron } from '@playwright/test'
import { build } from 'esbuild'

assert.equal(process.platform, 'win32', 'Requires real Windows, not Wine or a platform mock')
assert.equal(process.env.CI, 'true', 'Run only on an ephemeral CI runner')
const [mode, executable, root] = process.argv.slice(2)
assert.ok(['before', 'after', 'restart'].includes(mode))
assert.ok(root && path.resolve(root).startsWith(path.resolve(process.env.RUNNER_TEMP) + path.sep))
const userData = path.join(root, 'desktop-data')
const home = path.join(root, 'agent-data')
const stateFile = path.join(root, 'synthetic-state.json')
const storeFile = path.join(userData, 'native-oauth-tokens.json')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(home, { recursive: true })
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function inventory(directory, prefix = '') {
  const result = {}
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(result, inventory(full, relative))
    else if (entry.isFile()) result[relative] = digest(full)
  }
  return result
}
let state
if (mode === 'before') {
  fs.cpSync(path.join(root, 'legacy-plugins'), path.join(home, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(home, 'config.yaml'), 'plugins:\n  enabled: []\n')
  fs.writeFileSync(path.join(home, '.env'), 'TEST_TOKEN=synthetic-only\n')
  fs.mkdirSync(path.join(home, 'memories'), { recursive: true })
  fs.writeFileSync(path.join(home, 'memories', 'MEMORY.md'), 'Old user memory — dữ liệu cũ\n')
  // A real SQLite file exercises binary preservation, not just a text marker.
  execFileSync('python', ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE migration_fixture(id TEXT PRIMARY KEY, message TEXT)'); c.execute('INSERT INTO migration_fixture VALUES(?,?)', ('old-session', 'Lịch sử cũ')); c.commit(); c.close()", path.join(home, 'history.sqlite')])
  state = {
    appName: 'Workmate Windows Upgrade ' + randomUUID(),
    baseUrl: 'https://migration-test.invalid',
    tokens: { accessToken: 'synthetic-access-' + randomUUID(), refreshToken: 'synthetic-refresh-' + randomUUID(), expiresAt: Date.now() + 86400000, provider: 'keycloak', userId: 'test-user', email: 'test@example.invalid', displayName: 'Migration Test' },
    files: inventory(home)
  }
} else {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  for (const [file, hash] of Object.entries(state.files)) assert.equal(digest(path.join(home, file)), hash, `Lost/changed ${file}`)
  assert.equal(digest(storeFile), state.storeHash, 'Encrypted credentials changed during upgrade')
}
const moduleFile = path.join(root, 'token-store.cjs')
await build({ entryPoints: [path.resolve(import.meta.dirname, '../electron/native-token-store.ts')], outfile: moduleFile, bundle: true, platform: 'node', format: 'cjs' })
const app = await _electron.launch({ executablePath: executable, args: ['--disable-gpu', '--no-sandbox'], env: {
  ...process.env,
  AGENTX_HOME: home,
  AGENTX_DESKTOP_USER_DATA_DIR: userData,
  AGENTX_DESKTOP_APP_NAME: state.appName,
  AGENTX_DESKTOP_REQUIRE_AUTH: '1',
  AGENTX_DESKTOP_BOOT_FAKE: '0'
} })
try {
  const result = await app.evaluate(async ({ app, safeStorage }, args) => {
    const fs = process.getBuiltinModule('node:fs')
    const require = process.getBuiltinModule('node:module').createRequire(args.moduleFile)
    const store = require(args.moduleFile)
    if (!safeStorage.isEncryptionAvailable()) throw Error('Windows native encryption unavailable')
    const io = {
      readStoreText: () => fs.readFileSync(args.storeFile, 'utf8'),
      writeStoreText: text => fs.writeFileSync(args.storeFile, text),
      encrypt: text => ({ encoding: 'safeStorage', value: safeStorage.encryptString(text).toString('base64') }),
      decrypt: secret => safeStorage.decryptString(Buffer.from(secret.value, 'base64'))
    }
    if (args.mode === 'before') store.persistNativeTokenSet(args.state.baseUrl, args.state.tokens, io)
    const restored = store.loadNativeTokenSet(args.state.baseUrl, io)
    return { version: app.getVersion(), nativeEncryption: true, tokensMatch: JSON.stringify(restored) === JSON.stringify(args.state.tokens), pid: process.pid }
  }, { mode, state, storeFile, moduleFile })
  assert.ok(result.tokensMatch, 'Saved login failed to decrypt/parse')
  assert.ok(!fs.readFileSync(storeFile, 'utf8').includes(state.tokens.refreshToken), 'Plaintext refresh token on disk')
  if (mode === 'before') {
    state.oldVersion = result.version
    state.storeHash = digest(storeFile)
    fs.writeFileSync(stateFile, JSON.stringify(state))
  } else {
    assert.notEqual(result.version, state.oldVersion, 'The old executable is still running')
    execFileSync('python', ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'; assert c.execute('SELECT message FROM migration_fixture WHERE id=?', ('old-session',)).fetchone()[0]=='Lịch sử cũ'; c.close()", path.join(home, 'history.sqlite')])
  }
  const report = { mode, ...result, preservedFiles: Object.keys(state.files).length, pluginFiles: Object.keys(state.files).filter(p => p.startsWith('plugins' + path.sep)).length, scope: 'Real published Electron process and Windows native safeStorage; synthetic login; old plugin bytes and SQLite fixture preserved. No live OAuth or external plugin service calls.' }
  fs.writeFileSync(path.join(root, mode + '-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await app.close()
}
