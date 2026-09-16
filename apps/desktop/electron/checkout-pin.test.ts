import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import {
  compareVersions,
  defaultExecGit,
  isRealPin,
  parseVersion,
  probeCheckoutPin,
  readCheckoutVersion,
  relateByMarker,
  relateByVersion,
  relateCheckoutToPin
} from './checkout-pin'

const PIN = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const OTHER = 'ffffffffffffffffffffffffffffffffffffffff'

test('isRealPin accepts a resolved SHA and rejects the fallback placeholder and junk', () => {
  assert.equal(isRealPin(PIN), true)
  assert.equal(isRealPin(PIN.slice(0, 7)), true)
  assert.equal(isRealPin('0'.repeat(40)), false)
  assert.equal(isRealPin('main'), false)
  assert.equal(isRealPin(null), false)
})

test('relateCheckoutToPin: no real stamp means nothing to compare', () => {
  assert.equal(
    relateCheckoutToPin({ pinnedCommit: '0'.repeat(40), headSha: OTHER, pinIsAncestorOfHead: false }),
    'unpinned'
  )
  assert.equal(relateCheckoutToPin({ pinnedCommit: undefined, headSha: OTHER, pinIsAncestorOfHead: false }), 'unpinned')
})

test('relateCheckoutToPin: a checkout git cannot describe is left alone', () => {
  assert.equal(relateCheckoutToPin({ pinnedCommit: PIN, headSha: null, pinIsAncestorOfHead: null }), 'unknown')
  assert.equal(relateCheckoutToPin({ pinnedCommit: PIN, headSha: 'not-a-sha', pinIsAncestorOfHead: null }), 'unknown')
})

test('relateCheckoutToPin: HEAD at the stamp, including an abbreviated stamp', () => {
  assert.equal(relateCheckoutToPin({ pinnedCommit: PIN, headSha: PIN, pinIsAncestorOfHead: null }), 'at-pin')
  assert.equal(
    relateCheckoutToPin({ pinnedCommit: PIN.toUpperCase(), headSha: PIN, pinIsAncestorOfHead: null }),
    'at-pin'
  )
  assert.equal(
    relateCheckoutToPin({ pinnedCommit: PIN.slice(0, 12), headSha: PIN, pinIsAncestorOfHead: null }),
    'at-pin'
  )
})

test('relateCheckoutToPin: a checkout that already contains the stamp is ahead, never rewound', () => {
  assert.equal(relateCheckoutToPin({ pinnedCommit: PIN, headSha: OTHER, pinIsAncestorOfHead: true }), 'ahead')
})

test('relateCheckoutToPin: a checkout without the stamp is behind, whether git said no or could not say', () => {
  // The August-checkout-under-a-September-shell case: HEAD provably lacks the pin.
  assert.equal(relateCheckoutToPin({ pinnedCommit: PIN, headSha: OTHER, pinIsAncestorOfHead: false }), 'behind')
  // Never fetched the pin at all (git: "Not a valid commit name"): also older.
  assert.equal(relateCheckoutToPin({ pinnedCommit: PIN, headSha: OTHER, pinIsAncestorOfHead: null }), 'behind')
})

function fakeGit(answers: Record<string, { status: number | null; stdout?: string }>) {
  const calls: string[][] = []

  const execGit = (args: string[]) => {
    calls.push(args)
    const key = args.join(' ')
    const hit = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))

    return hit ? { status: hit[1].status, stdout: hit[1].stdout ?? '' } : { status: null, stdout: '' }
  }

  return { execGit, calls }
}

test('probeCheckoutPin skips git entirely without a real pin or a root', () => {
  const { execGit, calls } = fakeGit({})

  assert.deepEqual(probeCheckoutPin('/x/agentx-agent', '0'.repeat(40), execGit), {
    relation: 'unpinned',
    headSha: null
  })
  assert.deepEqual(probeCheckoutPin(null, PIN, execGit), { relation: 'unknown', headSha: null })
  assert.equal(calls.length, 0)
})

test('probeCheckoutPin reads HEAD once and stops when it is the pin', () => {
  const { execGit, calls } = fakeGit({ 'rev-parse HEAD': { status: 0, stdout: `${PIN}\n` } })

  assert.deepEqual(probeCheckoutPin('/x/agentx-agent', PIN, execGit), { relation: 'at-pin', headSha: PIN })
  assert.equal(calls.length, 1)
})

test('probeCheckoutPin maps merge-base exit codes: 0 ahead, 1 behind, anything else behind-until-fetched', () => {
  const ahead = fakeGit({ 'rev-parse HEAD': { status: 0, stdout: OTHER }, 'merge-base --is-ancestor': { status: 0 } })
  assert.equal(probeCheckoutPin('/x', PIN, ahead.execGit).relation, 'ahead')
  assert.deepEqual(ahead.calls[1], ['merge-base', '--is-ancestor', PIN, 'HEAD'])

  const behind = fakeGit({ 'rev-parse HEAD': { status: 0, stdout: OTHER }, 'merge-base --is-ancestor': { status: 1 } })
  assert.equal(probeCheckoutPin('/x', PIN, behind.execGit).relation, 'behind')

  const unfetched = fakeGit({
    'rev-parse HEAD': { status: 0, stdout: OTHER },
    'merge-base --is-ancestor': { status: 128 }
  })

  assert.equal(probeCheckoutPin('/x', PIN, unfetched.execGit).relation, 'behind')
})

test('probeCheckoutPin reports unknown when the root is not a repository or git is missing', () => {
  const noRepo = fakeGit({ 'rev-parse HEAD': { status: 128, stdout: '' } })
  assert.deepEqual(probeCheckoutPin('/x', PIN, noRepo.execGit), { relation: 'unknown', headSha: null })

  const noGit = fakeGit({})
  assert.deepEqual(probeCheckoutPin('/x', PIN, noGit.execGit), { relation: 'unknown', headSha: null })
})

test('defaultExecGit returns a status instead of throwing when git is absent', () => {
  const run = defaultExecGit('/definitely/not/a/git/binary', false)
  const result = run(['rev-parse', 'HEAD'], process.cwd())

  assert.equal(result.status, null)
  assert.equal(result.stdout, '')
})

test('defaultExecGit answers from a real repository when one is available', () => {
  const run = defaultExecGit('git', false)
  const head = run(['rev-parse', 'HEAD'], process.cwd())

  if (head.status !== 0) {
    // Not running inside a git checkout (packaged CI artifact); nothing to assert.
    return
  }

  assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/)
  assert.equal(probeCheckoutPin(process.cwd(), head.stdout.trim(), run).relation, 'at-pin')
})

test('parseVersion / compareVersions order numeric components and reject junk', () => {
  assert.deepEqual(parseVersion('1.0.1'), [1, 0, 1])
  assert.deepEqual(parseVersion('v0.20.0-beta'), [0, 20, 0])
  assert.equal(parseVersion('main'), null)
  assert.equal(parseVersion(null), null)

  assert.equal(compareVersions('0.20.0', '1.0.1'), -1)
  assert.equal(compareVersions('1.0.1', '0.20.0'), 1)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1)
  assert.equal(compareVersions('x', '1.0.1'), null)
})

test('relateByVersion: only a LOWER declared version proves the checkout is older', () => {
  // The August install: pyproject said 0.20.0 while the desktop shipping over it said 1.0.1.
  assert.equal(relateByVersion({ checkoutVersion: '0.20.0', shellVersion: '1.0.1' }), 'behind')
  // Equal or newer says nothing about commits; never claim more than we know.
  assert.equal(relateByVersion({ checkoutVersion: '1.0.1', shellVersion: '1.0.1' }), 'unknown')
  assert.equal(relateByVersion({ checkoutVersion: '1.1.0', shellVersion: '1.0.1' }), 'unknown')
  assert.equal(relateByVersion({ checkoutVersion: null, shellVersion: '1.0.1' }), 'unknown')
})

test('readCheckoutVersion reads the [project] version and ignores other tables', () => {
  const pyproject = [
    '[tool.something]',
    'version = "9.9.9"',
    '',
    '[project]',
    'name = "agentx-workmate"',
    "version = '0.20.0'",
    ''
  ].join('\n')

  const seen: string[] = []

  const readFile = (file: string) => {
    seen.push(file)

    return pyproject
  }

  assert.equal(readCheckoutVersion('/x/agentx-agent', readFile), '0.20.0')
  assert.match(seen[0], /agentx-agent[\\/]pyproject\.toml$/)
  assert.equal(
    readCheckoutVersion('/x/agentx-agent', () => 'name = "no version here"'),
    null
  )
  assert.equal(
    readCheckoutVersion('/x/agentx-agent', () => {
      throw new Error('ENOENT')
    }),
    null
  )
  assert.equal(readCheckoutVersion(null, readFile), null)
})

test("readCheckoutVersion reads this repository's own pyproject when run from the checkout", () => {
  const repoRoot = path.resolve(process.cwd(), '..', '..')
  const version = readCheckoutVersion(repoRoot)

  if (version === null) {
    return // not running inside the source tree
  }

  assert.match(version, /^\d+\.\d+/)
})

test('relateByMarker: without git, a marker pinned elsewhere is an older build; the same pin is at-pin', () => {
  assert.equal(relateByMarker({ markerPinnedCommit: PIN, stampCommit: PIN }), 'at-pin')
  assert.equal(relateByMarker({ markerPinnedCommit: PIN.slice(0, 12), stampCommit: PIN }), 'at-pin')
  assert.equal(relateByMarker({ markerPinnedCommit: OTHER, stampCommit: PIN }), 'behind')
  // No marker, a fallback marker, or no real stamp: nothing to say.
  assert.equal(relateByMarker({ markerPinnedCommit: null, stampCommit: PIN }), 'unknown')
  assert.equal(relateByMarker({ markerPinnedCommit: '0'.repeat(40), stampCommit: PIN }), 'unknown')
  assert.equal(relateByMarker({ markerPinnedCommit: OTHER, stampCommit: '0'.repeat(40) }), 'unknown')
})
