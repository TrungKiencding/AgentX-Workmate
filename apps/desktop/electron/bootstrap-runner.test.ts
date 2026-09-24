import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import {
  buildPinArgs,
  buildPosixPinArgs,
  cachedScriptPath,
  decidePinCommit,
  hasExistingGitCheckout,
  installedAgentInstallScript,
  installRefForStamp,
  isPinnedCommit,
  pendingInstallerTeardown,
  resolveInstallScript,
  resolveMarkerPinnedCommit,
  runBootstrap
} from './bootstrap-runner'

const SCRIPT_NAME = process.platform === 'win32' ? 'install.ps1' : 'install.sh'
const ZERO_COMMIT = '0000000000000000000000000000000000000000'

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-bootstrap-test-'))
}

test('runBootstrap bails immediately when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()

  const events = []

  const result = await runBootstrap({
    installStamp: null,
    activeRoot: '/tmp/agentx-runner-test',
    sourceRepoRoot: null,
    hermesHome: '/tmp/agentx-runner-test',
    logRoot: '/tmp/agentx-runner-test',
    onEvent: ev => events.push(ev),
    abortSignal: controller.signal
  })

  // Cancelled before any install script is spawned.
  assert.deepEqual(result, { ok: false, cancelled: true })
  assert.ok(
    events.some(ev => ev.type === 'failed' && /cancelled/i.test(ev.error)),
    'should emit a cancelled failure event'
  )
})

test('installedAgentInstallScript resolves the installer in the agent checkout', () => {
  const home = mkTmpHome()

  try {
    assert.equal(installedAgentInstallScript(home), null, 'absent before the checkout exists')

    const scriptsDir = path.join(home, 'agentx-agent', 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    const scriptPath = path.join(scriptsDir, SCRIPT_NAME)
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hi\n')

    assert.equal(installedAgentInstallScript(home), scriptPath)
    assert.equal(installedAgentInstallScript(null), null, 'null home -> null')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('existing checkout detection requires git metadata', () => {
  const home = mkTmpHome()

  try {
    const activeRoot = path.join(home, 'agentx-agent')
    assert.equal(hasExistingGitCheckout(activeRoot), false)

    fs.mkdirSync(path.join(activeRoot, '.git'), { recursive: true })
    assert.equal(hasExistingGitCheckout(activeRoot), true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('fresh bootstrap args include the packaged commit pin', () => {
  const installStamp = { commit: 'a'.repeat(40), branch: 'main' }

  assert.deepEqual(buildPinArgs(installStamp), ['-Commit', installStamp.commit, '-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp,
      activeRoot: '/tmp/agentx-agent',
      hermesHome: '/tmp/agentx'
    }),
    ['--dir', '/tmp/agentx-agent', '--agentx-home', '/tmp/agentx', '--branch', 'main', '--commit', installStamp.commit]
  )
})

test('existing-checkout bootstrap args keep branch but skip the packaged commit pin', () => {
  const installStamp = { commit: 'a'.repeat(40), branch: 'main' }

  assert.deepEqual(buildPinArgs(installStamp, { pinCommit: false }), ['-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp,
      activeRoot: '/tmp/agentx-agent',
      hermesHome: '/tmp/agentx',
      pinCommit: false
    }),
    ['--dir', '/tmp/agentx-agent', '--agentx-home', '/tmp/agentx', '--branch', 'main']
  )
})

test('decidePinCommit pins a fresh clone, follows the branch on an existing checkout, and pins it when asked to move forward', () => {
  assert.equal(decidePinCommit({ existingCheckout: false }), true)
  assert.equal(decidePinCommit({ existingCheckout: true }), false)
  // A checkout behind the packaged stamp (checkout-pin.ts) is brought forward;
  // install.ps1/sh still skip a pin that is already an ancestor of HEAD.
  assert.equal(decidePinCommit({ existingCheckout: true, pinExistingCheckout: true }), true)
})

test('fallback install stamps use an unpinned branch ref', () => {
  const stamp = { commit: ZERO_COMMIT, branch: 'main' }

  assert.equal(isPinnedCommit(ZERO_COMMIT), false)
  assert.deepEqual(installRefForStamp(stamp), {
    ref: 'main',
    cacheKey: 'fallback-main',
    pinned: false
  })
  // Must NOT pass -Commit / --commit for the all-zero placeholder.
  assert.deepEqual(buildPinArgs(stamp), ['-Branch', 'main'])
  assert.deepEqual(
    buildPosixPinArgs({
      installStamp: stamp,
      activeRoot: '/tmp/agentx',
      hermesHome: '/tmp/home'
    }),
    ['--dir', '/tmp/agentx', '--agentx-home', '/tmp/home', '--branch', 'main']
  )
})

test('resolveMarkerPinnedCommit prefers real HEAD over fallback stamp zeros', () => {
  const realHead = 'c'.repeat(40)
  assert.equal(
    resolveMarkerPinnedCommit({ commit: ZERO_COMMIT, branch: 'main' }, '/tmp/checkout', {
      resolveHead: () => realHead
    }),
    realHead
  )
  assert.equal(
    resolveMarkerPinnedCommit({ commit: 'd'.repeat(40), branch: 'main' }, '/tmp/checkout', {
      resolveHead: () => realHead
    }),
    'd'.repeat(40),
    'packaged real pin wins over checkout HEAD'
  )
  assert.equal(
    resolveMarkerPinnedCommit({ commit: ZERO_COMMIT, branch: 'main' }, '/tmp/missing', {
      resolveHead: () => null
    }),
    null
  )
})

test('resolveInstallScript downloads fallback stamps by branch instead of zero commit', async () => {
  const home = mkTmpHome()

  try {
    const logs = []
    const refs = []

    const result = await resolveInstallScript({
      installStamp: { commit: ZERO_COMMIT, branch: 'main' },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => logs.push(ev),
      _download: async (ref, destPath) => {
        refs.push(ref)
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(destPath, '#!/bin/sh\necho fallback branch\n')

        return destPath
      }
    })

    assert.deepEqual(refs, ['main'])
    assert.equal(result.source, 'download')
    assert.equal(result.commit, null)
    assert.equal(result.path, cachedScriptPath(home, 'fallback-main'))
    assert.ok(
      logs.some(ev => /fallback, unpinned/.test(ev.line || '')),
      'emits an unpinned fallback log line'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript falls back to the build checkout when the pinned SHA 404s', async () => {
  // A packaged build made from a local branch pins a commit that exists on no
  // remote, so the GitHub fetch can never succeed for it. On a machine that
  // has not completed an install yet there is no installed agent to fall back
  // to either — which left a self-built desktop app dead on arrival with a 404
  // for a SHA only that machine had.
  const home = mkTmpHome()
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-buildroot-'))

  try {
    fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true })
    const shipped = path.join(repoRoot, 'scripts', process.platform === 'win32' ? 'install.ps1' : 'install.sh')
    fs.writeFileSync(shipped, '#!/bin/sh\necho from the build checkout\n')

    const logs = []
    const commit = 'b'.repeat(40)

    const result = await resolveInstallScript({
      installStamp: { commit, branch: 'rebrand/x', source: 'local', repoRoot },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => logs.push(ev),
      _download: async () => {
        throw new Error('HTTP 404')
      }
    })

    assert.equal(result.source, 'build-checkout')
    assert.equal(result.commit, commit)
    // The installer must clone from the same checkout it came from: the
    // commit exists on no remote, so GitHub has nothing to give it.
    assert.equal(result.repoRoot, repoRoot)
    assert.equal(fs.readFileSync(result.path, 'utf8'), '#!/bin/sh\necho from the build checkout\n')
    assert.ok(
      logs.some(ev => /falling back to build checkout/.test(ev.line || '')),
      'says which fallback it took'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('resolveInstallScript ignores a build root that a CI stamp did not record', async () => {
  // CI stamps pin a commit that IS fetchable and carry no repoRoot; a runner
  // path would mean nothing on a user's machine anyway.
  const home = mkTmpHome()

  try {
    const commit = 'c'.repeat(40)
    let attempts = 0

    await assert.rejects(
      resolveInstallScript({
        installStamp: { commit, branch: 'main', source: 'ci' },
        sourceRepoRoot: null,
        hermesHome: home,
        emit: () => {},
        _download: async () => {
          attempts += 1
          throw new Error('HTTP 404')
        }
      })
    )

    assert.equal(attempts, 1, 'still tried the network exactly once')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript reports no repo root when the installed agent is the fallback', async () => {
  // An installed-agent fallback says nothing about where to clone from, so the
  // installer keeps its own default rather than being pointed somewhere wrong.
  const home = mkTmpHome()

  try {
    const shipped = path.join(home, 'agentx-agent', 'scripts')
    fs.mkdirSync(shipped, { recursive: true })
    fs.writeFileSync(path.join(shipped, process.platform === 'win32' ? 'install.ps1' : 'install.sh'), '#!/bin/sh\n')

    const result = await resolveInstallScript({
      installStamp: { commit: 'd'.repeat(40), branch: 'main', source: 'ci' },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: () => {},
      _download: async () => {
        throw new Error('HTTP 404')
      }
    })

    assert.equal(result.source, 'installed-agent')
    assert.equal(result.repoRoot, null)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript prefers a cached script without touching the network', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    const cached = cachedScriptPath(home, commit)
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.writeFileSync(cached, '#!/bin/sh\necho cached\n')

    const logs = []

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => logs.push(ev)
    })

    assert.equal(result.source, 'cache')
    assert.equal(result.path, cached)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript falls back to the installed agent checkout on a 404', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    // Seed the installed agent checkout so the fallback has something to resolve.
    const scriptsDir = path.join(home, 'agentx-agent', 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    const installed = path.join(scriptsDir, SCRIPT_NAME)
    fs.writeFileSync(installed, '#!/bin/sh\necho fallback\n')

    const logs = []

    const result = await resolveInstallScript({
      installStamp: { commit },
      sourceRepoRoot: null,
      hermesHome: home,
      emit: ev => logs.push(ev),
      // Simulate GitHub returning a 404 for the pinned commit.
      _download: async () => {
        throw new Error('Failed to download install.sh: HTTP 404')
      }
    })

    assert.equal(result.source, 'installed-agent')
    // It should have copied the installer into the bootstrap cache.
    assert.equal(result.path, cachedScriptPath(home, commit))
    assert.ok(fs.existsSync(result.path), 'fallback script copied into cache')
    assert.ok(
      logs.some(ev => /falling back to installed agent/.test(ev.line || '')),
      'emits a fallback log line'
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveInstallScript rethrows when the 404 fallback is unavailable', async () => {
  const home = mkTmpHome()

  try {
    const commit = 'a'.repeat(40)
    // No installed agent checkout seeded -> nothing to fall back to.
    await assert.rejects(
      resolveInstallScript({
        installStamp: { commit },
        sourceRepoRoot: null,
        hermesHome: home,
        emit: () => {},
        _download: async () => {
          throw new Error('Failed to download install.sh: HTTP 404')
        }
      }),
      /HTTP 404|Failed to download/
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Aborting a stage stops the installer's whole process tree
// ---------------------------------------------------------------------------

const INSTALL_SH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'install.sh')

// Lift one function out of scripts/install.sh so a stand-in installer runs the
// real thing (tests/test_install_sh_browser_install.py does the same).
function installShFunction(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(fs.readFileSync(INSTALL_SH, 'utf8'))
  assert.ok(match, `could not extract ${name}() from scripts/install.sh`)

  return match[0]
}

// A repo root whose scripts/install.sh lists one stage and runs `stageBody`
// for it. The body can call the real run_with_timeout, and `note PID` records
// a process it started in $AGENTX_HOME/started.
function fakeInstallerRepo(stageBody: string[]): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-fake-installer-'))
  fs.mkdirSync(path.join(repoRoot, 'scripts'))
  fs.writeFileSync(
    path.join(repoRoot, 'scripts', 'install.sh'),
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "--manifest" ]; then',
      `  echo '{"protocol_version":1,"stages":[{"name":"deps","title":"Deps","category":"core","needs_user_input":false}]}'`,
      '  exit 0',
      'fi',
      'note() { echo "$1" >> "$AGENTX_HOME/started"; }',
      installShFunction('run_with_timeout'),
      ...stageBody
    ].join('\n') + '\n'
  )

  return repoRoot
}

function bootstrapWith(repoRoot: string, home: string, abortSignal?: AbortSignal, onEvent: (ev) => void = () => {}) {
  return runBootstrap({
    installStamp: null,
    activeRoot: path.join(home, 'agentx-agent'),
    sourceRepoRoot: repoRoot,
    hermesHome: home,
    logRoot: path.join(home, 'logs'),
    onEvent,
    abortSignal
  })
}

async function waitFor<T>(what: string, probe: () => T, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const value = probe()

    if (value) {
      return value
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

// Fail with `what` instead of hanging the file until vitest's own timeout,
// which would skip the cleanup and leave the test's processes running.
function within<T>(what: string, promise: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

function notedPids(home: string): number[] {
  try {
    return fs.readFileSync(path.join(home, 'started'), 'utf8').split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function isRunning(target: number): boolean {
  try {
    process.kill(target, 0)

    return true
  } catch {
    return false
  }
}

function processGroupOf(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
}

// SIGKILL whatever a failed run left behind, never this test's own group.
function killLeftovers(pids: number[], groups: number[]) {
  const ownGroup = processGroupOf(process.pid)

  for (const target of [...groups.filter(group => group !== ownGroup).map(group => -group), ...pids]) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

test.skipIf(process.platform === 'win32')(
  'aborting a stage stops everything the installer started, including a job in its own process group',
  async () => {
    // What quitting mid-install used to leave running: a child in the
    // script's own group (git, uv, pip), and the Playwright download going
    // through run_with_timeout's `set -m` watchdog, a job in a process group
    // of its own that a signal to the script's group does not reach. That
    // job's subshell also holds the stage's stdout, so the stage could not
    // even finish until it exited.
    const repoRoot = fakeInstallerRepo([
      'sleep 300 >/dev/null 2>&1 &',
      'note $!',
      'download() { sleep 300 >/dev/null 2>&1 & note $!; wait; }',
      'run_with_timeout 600 download'
    ])

    const home = mkTmpHome()
    const controller = new AbortController()
    let pids: number[] = []
    let groups: number[] = []

    try {
      const run = bootstrapWith(repoRoot, home, controller.signal)

      pids = await waitFor('the installer to start its children', () => {
        const noted = notedPids(home)

        return noted.length === 2 ? noted : null
      })
      groups = pids.map(processGroupOf)

      assert.notEqual(groups[1], groups[0], 'run_with_timeout runs the download in a process group of its own')
      assert.notEqual(groups[0], processGroupOf(process.pid), "the installer does not share the app's process group")

      controller.abort()
      const teardown = pendingInstallerTeardown()
      assert.ok(teardown, 'an abort leaves a teardown to wait for')

      const result = await within('the aborted stage to finish', run)
      assert.equal(result.ok, false)
      assert.match(String(result.error), /cancelled/)

      await within('the installer tree to go down', teardown)
      assert.deepEqual(pids.filter(isRunning), [], 'no process the installer started is still running')
      assert.deepEqual(
        groups.filter(group => isRunning(-group)),
        [],
        'no process is left in either group'
      )
      assert.equal(pendingInstallerTeardown(), null, 'nothing left to wait for once the tree is gone')
    } finally {
      killLeftovers(pids, groups)
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  },
  30_000
)

test.skipIf(process.platform === 'win32')(
  "run_with_timeout still kills its own job's group when the installer runs in a session of its own",
  async () => {
    // The installer runs detached: a session of its own, with no controlling
    // terminal. Its watchdog's `set -m` job and `kill -TERM/-KILL -$cmd_pid`
    // on timeout must work the same there, or a wedged Playwright download
    // would hang the stage for good.
    const repoRoot = fakeInstallerRepo([
      'download() { sleep 300 >/dev/null 2>&1 & note $!; wait; }',
      'run_with_timeout 1 download',
      'echo "{\\"ok\\":true,\\"stage\\":\\"deps\\",\\"rc\\":$?}"'
    ])

    const home = mkTmpHome()
    const events = []

    try {
      const result = await within(
        'the timed-out stage to finish',
        bootstrapWith(repoRoot, home, undefined, ev => events.push(ev)),
        20_000
      )

      assert.equal(result.ok, true)
      const stage = events.find(ev => ev.type === 'stage' && ev.name === 'deps' && ev.state === 'succeeded')
      assert.equal(stage?.json?.rc, 124, 'run_with_timeout reports the timeout')
      assert.deepEqual(notedPids(home).filter(isRunning), [], 'the timed-out download was killed')
    } finally {
      killLeftovers(notedPids(home), [])
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  },
  30_000
)
