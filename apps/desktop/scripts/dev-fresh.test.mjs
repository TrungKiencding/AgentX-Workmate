import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'

import { freshEnv, liveSandboxPid, resetSandbox, sandboxPaths } from './dev-fresh.mjs'

const roots = []
const children = []

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-dev-fresh-test-'))
  roots.push(root)

  return sandboxPaths(root)
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill()
  }

  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('reset wipes the last run but keeps its device id', () => {
  const paths = makeSandbox()
  write(path.join(paths.agentxHome, 'accounts', 'someone', 'state.db'), 'history')
  write(path.join(paths.userDataDir, 'Local Storage', 'leveldb', 'CURRENT'), 'onboarding done')
  write(path.join(paths.userDataDir, 'native-oauth-tokens.json'), '{}')
  write(path.join(paths.userDataDir, 'device.json'), '{"id":"kept"}')

  resetSandbox(paths)

  assert.deepEqual(fs.readdirSync(paths.userDataDir), ['device.json'])
  assert.equal(fs.readFileSync(path.join(paths.userDataDir, 'device.json'), 'utf8'), '{"id":"kept"}')
  assert.deepEqual(fs.readdirSync(paths.agentxHome), ['config.yaml'])
})

test('the saved device id comes back even when the run directory is gone', () => {
  const paths = makeSandbox()
  write(paths.savedDeviceId, '{"id":"saved"}')

  resetSandbox(paths)

  assert.equal(fs.readFileSync(path.join(paths.userDataDir, 'device.json'), 'utf8'), '{"id":"saved"}')
})

test('the very first reset has no device id to restore', () => {
  const paths = makeSandbox()

  resetSandbox(paths)

  assert.equal(fs.existsSync(path.join(paths.userDataDir, 'device.json')), false)
  assert.equal(fs.existsSync(paths.savedDeviceId), false)
})

test('history sync is switched off unless asked for', () => {
  const off = makeSandbox()
  resetSandbox(off)
  assert.match(
    fs.readFileSync(path.join(off.agentxHome, 'config.yaml'), 'utf8'),
    /^accounts:\n {2}second_brain:\n {4}sync:\n {6}enabled: false\n/m
  )

  const on = makeSandbox()
  resetSandbox(on, { sync: true })
  assert.deepEqual(fs.readdirSync(on.agentxHome), [])
})

test('reset leaves everything outside the run directory alone', () => {
  const paths = makeSandbox()
  write(path.join(paths.root, 'unrelated.txt'), 'keep')

  resetSandbox(paths)

  assert.equal(fs.readFileSync(path.join(paths.root, 'unrelated.txt'), 'utf8'), 'keep')
})

test.skipIf(process.platform === 'win32')('reset refuses while the last sandbox app is still running', async () => {
  const paths = makeSandbox()
  // Stands in for the dev app: a live process whose command line is the dev Electron's.
  const app = spawn(process.execPath, [
    '-e',
    'console.log("up"); setInterval(() => {}, 1000)',
    '/repo/node_modules/electron/dist/Electron'
  ])
  children.push(app)
  await new Promise(resolve => app.stdout.once('data', resolve))
  write(path.join(paths.userDataDir, 'accounts.json'), '{}')
  fs.symlinkSync(`${os.hostname()}-${app.pid}`, path.join(paths.userDataDir, 'SingletonLock'))

  assert.equal(liveSandboxPid(paths.userDataDir), app.pid)
  assert.throws(() => resetSandbox(paths), /still running \(pid \d+\)/)
  assert.equal(fs.existsSync(path.join(paths.userDataDir, 'accounts.json')), true)
})

test.skipIf(process.platform === 'win32')('a lock left behind by a killed app does not block a reset', () => {
  const paths = makeSandbox()
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  fs.mkdirSync(paths.userDataDir, { recursive: true })
  fs.symlinkSync(`${os.hostname()}-${pid}`, path.join(paths.userDataDir, 'SingletonLock'))

  assert.equal(liveSandboxPid(paths.userDataDir), null)

  resetSandbox(paths)

  assert.deepEqual(fs.readdirSync(paths.userDataDir), [])
})

test.skipIf(process.platform === 'win32')('a lock whose pid now belongs to another process does not block a reset', () => {
  const paths = makeSandbox()
  fs.mkdirSync(paths.userDataDir, { recursive: true })
  fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(paths.userDataDir, 'SingletonLock'))

  assert.equal(liveSandboxPid(paths.userDataDir), null)

  resetSandbox(paths)

  assert.deepEqual(fs.readdirSync(paths.userDataDir), [])
})

test('the app gets the sandbox home and none of the shell credentials', () => {
  const paths = makeSandbox()

  const env = freshEnv(
    {
      AGENTX_DESKTOP_AGENTX_ROOT: '/src/agentx',
      AGENTX_HOME: '/Users/someone/.agentx',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      OPENAI_API_KEY: 'sk-test',
      PATH: '/usr/bin'
    },
    paths
  )

  assert.deepEqual(env, {
    AGENTX_DESKTOP_AGENTX_ROOT: '/src/agentx',
    AGENTX_DESKTOP_USER_DATA_DIR: paths.userDataDir,
    AGENTX_HOME: paths.agentxHome,
    PATH: '/usr/bin'
  })
})
