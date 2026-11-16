import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { sandboxShellEnv } from './sandbox-env.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

test.skipIf(process.platform === 'win32')('Bash installer children have a private home while native processes keep Keychain access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentx-sandbox's home with spaces-"))
  roots.push(root)
  const hostHome = os.homedir()
  // Match a GUI launch, without an inherited shell level or shell setup.
  const env = { HOME: hostHome, ...sandboxShellEnv(root, '/usr/bin:/bin') }
  const actual = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], {
    env,
    encoding: 'utf8'
  })
  assert.equal(actual, hostHome)
  const probe = path.join(root, 'install.sh')
  fs.writeFileSync(probe, 'exec "$1" -e \'process.stdout.write(require("node:os").homedir())\'\n')
  const isolated = execFileSync('bash', [probe, process.execPath], { env, encoding: 'utf8' })
  assert.ok(isolated.startsWith(root + path.sep))
  assert.ok(fs.statSync(isolated).isDirectory())
  assert.notEqual(isolated, hostHome)
  // The updater is a Bash script too, and launches the next native app. It
  // must keep the private PATH without applying the installer's HOME to that app.
  const swap = path.join(root, 'agentx-update-test.sh')
  fs.copyFileSync(probe, swap)
  assert.equal(execFileSync('/bin/bash', [swap, process.execPath], { env, encoding: 'utf8' }), hostHome)
  assert.equal(os.homedir(), hostHome, 'constructing a child environment must not mutate the parent')
})

test.skipIf(process.platform === 'win32')('deleting one sandbox cannot remove another concurrent test home', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-sandbox-first-'))
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-sandbox-second-'))
  roots.push(first, second)
  const firstEnv = sandboxShellEnv(first)
  const secondEnv = sandboxShellEnv(second)
  const probe = path.join(second, 'install-cached.sh')
  fs.writeFileSync(probe, 'printf "other test" > "$HOME/keep"; printf "%s" "$HOME/keep"\n')
  const retained = execFileSync('bash', [probe], { env: { ...process.env, ...secondEnv }, encoding: 'utf8' })
  fs.rmSync(first, { recursive: true, force: true })
  assert.equal(fs.existsSync(firstEnv.PATH.split(path.delimiter)[0]), false)
  assert.equal(fs.readFileSync(retained, 'utf8'), 'other test')
})
