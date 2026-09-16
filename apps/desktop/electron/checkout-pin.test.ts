import assert from 'node:assert/strict'

import { test } from 'vitest'

import { defaultExecGit, isRealPin, probeCheckoutPin, relateCheckoutToPin } from './checkout-pin'

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
