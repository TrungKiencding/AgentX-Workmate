import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, test } from 'vitest'

import { classifyActiveRuntime } from './active-runtime-state'
import { resolveMarkerPinnedCommit, runBootstrap } from './bootstrap-runner'
import { defaultExecGit, probeCheckoutPin, readCheckoutVersion, resolveCheckoutPin } from './checkout-pin'

const roots: string[] = []
const repoRoot = path.resolve(import.meta.dirname, '../../..')
const windows = process.platform === 'win32'
const installer = path.join(repoRoot, 'scripts', windows ? 'install.ps1' : 'install.sh')
const runGit = defaultExecGit('git', windows)
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Regression Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function fixture(versions = ['1.0.1', '1.0.4', '1.0.5']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-install-regression-'))
  roots.push(root)

  const origin = path.join(root, 'origin'),
    home = path.join(root, 'home'),
    active = path.join(home, 'agentx-agent')

  fs.mkdirSync(origin)
  fs.mkdirSync(home)
  const globalConfig = path.join(root, 'git-global-config')
  fs.writeFileSync(globalConfig, windows ? '[core]\n  autocrlf = true\n' : '')
  git(origin, 'init', '-b', 'main')

  const commits = versions.map((version, i) => {
    fs.writeFileSync(path.join(origin, 'pyproject.toml'), `[project]\nversion = "${version}"\n`)
    fs.writeFileSync(path.join(origin, 'revision'), String(i))
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', `release ${version}, revision ${i}`)

    return git(origin, 'rev-parse', 'HEAD')
  })

  const env = {
    ...process.env,
    AGENTX_HOME: home,
    AGENTX_REPO_URL: pathToFileURL(origin).href,
    GIT_CONFIG_GLOBAL: globalConfig
  }

  const install = (pin: string, force = false, stage = 'repository') => {
    const args = windows
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          installer,
          '-Stage',
          stage,
          '-NonInteractive',
          '-Json',
          '-Commit',
          pin,
          ...(force ? ['-ForceCommit'] : [])
        ]
      : [
          installer,
          '--stage',
          stage,
          '--non-interactive',
          '--json',
          '--dir',
          active,
          '--agentx-home',
          home,
          '--commit',
          pin,
          ...(force ? ['--force-commit'] : [])
        ]

    const result = spawnSync(windows ? 'powershell.exe' : '/bin/bash', args, { env, encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.ok(
      result.stdout.split(/\r?\n/).some(line => {
        try {
          return JSON.parse(line).ok === true
        } catch {
          return false
        }
      })
    )

    return result.stdout
  }

  return { root, origin, home, active, commits, env, install }
}

// The tests that run on Windows spawn real git, so they get 60 s rather than
// vitest's 5 s default: a slow Windows runner took 7 s for one that takes 0.4 s here.
test('shallow updated agent under an old desktop never triggers replacement across repeated launches', () => {
  const f = fixture()
  git(f.root, 'clone', '--depth', '1', f.env.AGENTX_REPO_URL, f.active)
  assert.equal(git(f.active, 'rev-parse', '--is-shallow-repository'), 'true')
  assert.equal(probeCheckoutPin(f.active, f.commits[0], runGit).relation, 'unknown')

  for (let launch = 0; launch < 3; launch++) {
    const relation = resolveCheckoutPin(f.active, f.commits[0], '1.0.1', runGit, f.commits[0])
    assert.equal(relation.relation, 'ahead')
    assert.equal(classifyActiveRuntime(null, 1, true, relation.relation).shouldUseActiveRuntime, true)
    assert.equal(git(f.active, 'rev-parse', 'HEAD'), f.commits[2])
  }
}, 60000)
test('fresh pinned install and an older shallow install reach the new release once and preserve user data', () => {
  const f = fixture()
  f.install(f.commits[0])
  assert.equal(readCheckoutVersion(f.active), '1.0.1')
  assert.equal(git(f.active, 'status', '--porcelain'), '')
  fs.writeFileSync(path.join(f.home, 'config.yaml'), 'user data must survive\n')
  fs.writeFileSync(path.join(f.home, '.env'), 'TEST_KEY=keep\n')
  assert.equal(resolveCheckoutPin(f.active, f.commits[2], '1.0.5', runGit).relation, 'behind')
  f.install(f.commits[2])

  for (let launch = 0; launch < 3; launch++) {
    assert.equal(resolveCheckoutPin(f.active, f.commits[2], '1.0.5', runGit).relation, 'at-pin')
    assert.equal(readCheckoutVersion(f.active), '1.0.5')
  }

  assert.equal(fs.readFileSync(path.join(f.home, 'config.yaml'), 'utf8'), 'user data must survive\n')
  assert.equal(fs.readFileSync(path.join(f.home, '.env'), 'utf8'), 'TEST_KEY=keep\n')
}, 60000)
test('a pinned upgrade completes before restoring local changes and preserves conflicts in a stash', () => {
  const f = fixture()
  f.install(f.commits[0])
  fs.writeFileSync(path.join(f.active, 'revision'), 'user edit that conflicts with the new revision')
  fs.writeFileSync(path.join(f.active, 'keep-user-file'), 'user-created file')
  f.install(f.commits[2])
  assert.equal(git(f.active, 'rev-parse', 'HEAD'), f.commits[2])
  assert.equal(readCheckoutVersion(f.active), '1.0.5')
  assert.match(git(f.active, 'stash', 'show', '-p', '--include-untracked'), /user edit that conflicts/)
  assert.match(git(f.active, 'stash', 'show', '-p', '--include-untracked'), /user-created file/)
}, 60000)
test('installers refuse a stale pin without ancestry, but an explicit rollback works', () => {
  const f = fixture()
  git(f.root, 'clone', '--depth', '1', f.env.AGENTX_REPO_URL, f.active)
  f.install(f.commits[0])
  assert.equal(readCheckoutVersion(f.active), '1.0.5')
  assert.equal(git(f.active, 'rev-parse', 'HEAD'), f.commits[2])
  assert.equal(resolveMarkerPinnedCommit({ commit: f.commits[0] }, f.active), f.commits[2])

  if (windows) {
    f.install(f.commits[0], false, 'bootstrap-marker')
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.active, '.agentx-bootstrap-complete'), 'utf8')).pinnedCommit,
      f.commits[2]
    )
  }

  f.install(f.commits[0], true)
  assert.equal(readCheckoutVersion(f.active), '1.0.1')
}, 60000)
test('same release with shallow history is not declared old; only matching provenance settles it', () => {
  const f = fixture(['1.0.5', '1.0.5'])
  git(f.root, 'clone', '--depth', '1', f.env.AGENTX_REPO_URL, f.active)
  assert.equal(resolveCheckoutPin(f.active, f.commits[0], '1.0.5', runGit, f.commits[0]).relation, 'at-pin')
  assert.equal(resolveCheckoutPin(f.active, f.commits[0], '1.0.5', runGit, f.commits[1]).relation, 'unknown')
}, 60000)
test('full history distinguishes behind and ahead without relying on release numbers', () => {
  const f = fixture(['1.0.5', '1.0.5'])
  git(f.root, 'clone', f.env.AGENTX_REPO_URL, f.active)
  assert.equal(probeCheckoutPin(f.active, f.commits[0], runGit).relation, 'ahead')
  git(f.active, 'checkout', '--detach', f.commits[0])
  assert.equal(probeCheckoutPin(f.active, f.commits[1], runGit).relation, 'behind')
}, 60000)
test('unavailable Git and a stale marker cannot downgrade a newer ZIP install', () => {
  const f = fixture()
  fs.mkdirSync(f.active)
  fs.writeFileSync(path.join(f.active, 'pyproject.toml'), '[project]\nversion = "1.0.5"\n')
  const absent = defaultExecGit(path.join(f.root, 'missing-git'), windows)
  assert.equal(resolveCheckoutPin(f.active, f.commits[0], '1.0.1', absent, f.commits[0]).relation, 'ahead')
}, 60000)
test.skipIf(windows)('bootstrap success frames cannot conceal an older installed release', async () => {
  const f = fixture()
  fs.mkdirSync(f.active)
  fs.writeFileSync(path.join(f.active, 'pyproject.toml'), '[project]\nversion = "1.0.1"\n')
  fs.mkdirSync(path.join(f.root, 'scripts'))
  fs.writeFileSync(
    path.join(f.root, 'scripts', 'install.sh'),
    '#!/bin/bash\nif [ "$1" = "--manifest" ]; then echo \'{"stages":[]}\'; fi\n'
  )
  let markerWritten = false

  const result = await runBootstrap({
    installStamp: { commit: f.commits[2] },
    activeRoot: f.active,
    sourceRepoRoot: f.root,
    hermesHome: f.home,
    expectedVersion: '1.0.5',
    writeMarker: () => {
      markerWritten = true
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /did not reach desktop/)
  assert.equal(markerWritten, false)
})
