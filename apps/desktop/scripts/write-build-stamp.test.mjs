import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

import {
  FALLBACK_BRANCH,
  FALLBACK_COMMIT,
  fromCI,
  fromFallback,
  fromLocalGit,
  isFallbackCommit,
  resolveStamp
} from './write-build-stamp.mjs'

test('fromCI reads GITHUB_SHA / GITHUB_REF_NAME', () => {
  assert.deepEqual(
    fromCI({ GITHUB_SHA: 'a'.repeat(40), GITHUB_REF_NAME: 'release' }),
    { commit: 'a'.repeat(40), branch: 'release', dirty: false, source: 'ci' }
  )
  assert.equal(fromCI({}), null)
})

test('fromLocalGit returns null when git rev-parse fails', () => {
  const stamp = fromLocalGit('/tmp/not-a-repo', () => null)
  assert.equal(stamp, null)
})

test('fromLocalGit reads HEAD + branch + dirty status', () => {
  const calls = []
  const execFn = (cmd) => {
    calls.push(cmd)
    if (cmd === 'git rev-parse HEAD') return 'b'.repeat(40)
    if (cmd === 'git rev-parse --abbrev-ref HEAD') return 'main'
    if (cmd === 'git status --porcelain -uno') return ' M apps/desktop/package.json'
    return null
  }
  assert.deepEqual(fromLocalGit('/repo', execFn), {
    commit: 'b'.repeat(40),
    branch: 'main',
    dirty: true,
    source: 'local',
    // The checkout is recorded because a local commit exists on no remote:
    // the desktop bootstrap cannot fetch install.sh for it from GitHub and
    // reads it off disk instead. A CI stamp has no repoRoot — its commit IS
    // fetchable, and a runner path means nothing on a user's machine.
    repoRoot: '/repo'
  })
  assert.ok(calls.includes('git rev-parse HEAD'))
})

test('fromCI does not record a repo root', () => {
  const stamp = fromCI({ GITHUB_SHA: 'a'.repeat(40), GITHUB_REF_NAME: 'main' })
  assert.equal(stamp.source, 'ci')
  assert.ok(!('repoRoot' in stamp), 'a CI runner path is meaningless downstream')
})

test('fromFallback uses the all-zero placeholder commit', () => {
  assert.deepEqual(fromFallback(), {
    commit: FALLBACK_COMMIT,
    branch: FALLBACK_BRANCH,
    dirty: false,
    source: 'fallback'
  })
  assert.equal(isFallbackCommit(FALLBACK_COMMIT), true)
  assert.equal(isFallbackCommit('a'.repeat(40)), false)
})

test('resolveStamp prefers CI over local git over fallback', () => {
  const ci = resolveStamp({
    env: { GITHUB_SHA: 'c'.repeat(40), GITHUB_REF_NAME: 'main' },
    execFn: () => 'should-not-run'
  })
  assert.equal(ci.source, 'ci')
  assert.equal(ci.commit, 'c'.repeat(40))

  const local = resolveStamp({
    env: {},
    execFn: (cmd) => {
      if (cmd === 'git rev-parse HEAD') return 'd'.repeat(40)
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return 'main'
      if (cmd === 'git status --porcelain -uno') return ''
      return null
    }
  })
  assert.equal(local.source, 'local')
  assert.equal(local.commit, 'd'.repeat(40))
  assert.equal(local.dirty, false)
})

test('resolveStamp falls back when neither CI nor git is available', () => {
  const stamp = resolveStamp({ env: {}, execFn: () => null })
  assert.deepEqual(stamp, {
    commit: FALLBACK_COMMIT,
    branch: FALLBACK_BRANCH,
    dirty: false,
    source: 'fallback'
  })
})

test('every field the writer emits survives loadInstallStamp in main.ts', () => {
  // main.ts is the electron entry point and exports nothing, so this reads it
  // as source. It is a blunt check, but it guards a real failure: the parser's
  // returned object literal is an ALLOWLIST, and a field added to the writer
  // without being added there is dropped silently. That is exactly how
  // `repoRoot` reached the packaged stamp and still arrived as undefined in
  // the bootstrap's build-checkout fallback, which kept 404ing on a commit
  // that exists only on the build machine.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const mainTs = readFileSync(path.join(here, '..', 'electron', 'main.ts'), 'utf8')

  const parserBody = mainTs.slice(
    mainTs.indexOf('function loadInstallStamp()'),
    mainTs.indexOf('const INSTALL_STAMP = loadInstallStamp()')
  )
  assert.ok(parserBody, 'could not locate loadInstallStamp in main.ts')

  // Fields the writer can put in the payload, per write-build-stamp.mjs.
  const written = ['schemaVersion', 'commit', 'branch', 'builtAt', 'dirty', 'source', 'repoRoot']

  for (const field of written) {
    assert.ok(
      new RegExp(`\\b${field}\\s*:`).test(parserBody),
      `loadInstallStamp() drops "${field}" — add it to the returned object or ` +
        `every consumer sees undefined`
    )
  }
})
