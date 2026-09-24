import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { test } from 'vitest'

import { collectProcessTree, type ProcessEntry, terminateProcessTree } from './process-tree'

// The app (pid 100, leading group 100) spawned the installer detached (200,
// leading group 200). 201 stayed in the installer's group; 202 is a `set -m`
// job with a group of its own and a child 203. 300 is unrelated.
const TABLE: ProcessEntry[] = [
  { pid: 1, ppid: 0, pgid: 1 },
  { pid: 100, ppid: 1, pgid: 100 },
  { pid: 200, ppid: 100, pgid: 200 },
  { pid: 201, ppid: 200, pgid: 200 },
  { pid: 202, ppid: 200, pgid: 202 },
  { pid: 203, ppid: 202, pgid: 202 },
  { pid: 300, ppid: 1, pgid: 300 }
]

const sorted = (values: number[]) => [...values].sort((a, b) => a - b)

test('collectProcessTree finds the descendants and every process group they run in', () => {
  const tree = collectProcessTree(TABLE, 200)

  assert.deepEqual(sorted(tree.pids), [200, 201, 202, 203])
  assert.deepEqual(sorted(tree.groups), [200, 202])
})

test('collectProcessTree reaches what is left in the root group after the root has exited', () => {
  // The root is gone and 201 was reparented to init, but it is still in the
  // root's group. The root's own pid may already belong to someone else.
  const table = TABLE.filter(p => p.pid !== 200).map(p => (p.ppid === 200 ? { ...p, ppid: 1 } : p))
  const tree = collectProcessTree(table, 200)

  assert.deepEqual(tree.pids, [201])
  assert.deepEqual(tree.groups, [200])

  const allGone = TABLE.filter(p => p.pid !== 200 && p.pid !== 201)
  assert.deepEqual(collectProcessTree(allGone, 200), { pids: [], groups: [] }, 'an empty group is not signalled')
})

test("collectProcessTree never lists the caller's own group, or init", () => {
  // A root that was NOT spawned detached shares the app's group (100), and
  // signalling that group would take the app down with it.
  const shared = TABLE.map(p => (p.pid === 200 || p.pid === 201 ? { ...p, pgid: 100 } : p))
  const tree = collectProcessTree(shared, 200)

  assert.deepEqual(sorted(tree.pids), [200, 201, 202, 203], 'still signalled one by one')
  assert.deepEqual(tree.groups, [202])

  const bogus = collectProcessTree([...TABLE, { pid: 1, ppid: 200, pgid: 200 }], 200)
  assert.ok(!bogus.pids.includes(1))
})

// A process table that honours kill(): SIGTERM ends a process unless it is
// stubborn, SIGKILL always does, and signal 0 fails once nothing is left.
function fakeKernel(stubborn: number[] = []) {
  const alive = new Set(TABLE.map(p => p.pid))
  const signals: [number, string][] = []

  const kill = (target: number, signal: NodeJS.Signals | 0) => {
    const hit = TABLE.filter(p => alive.has(p.pid) && (target < 0 ? p.pgid === -target : p.pid === target))

    if (signal !== 0) {
      signals.push([target, signal])
    }

    if (hit.length === 0) {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }

    for (const p of hit) {
      if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !stubborn.includes(p.pid))) {
        alive.delete(p.pid)
      }
    }
  }

  const sent = (signal: string) => signals.filter(([, s]) => s === signal).map(([target]) => target)

  return { alive, kill, sent, signals, listProcesses: () => TABLE.filter(p => alive.has(p.pid)) }
}

test('terminateProcessTree sends SIGTERM to the whole tree and stops there when that is enough', async () => {
  const kernel = fakeKernel()

  await terminateProcessTree(200, { platform: 'darwin', pollMs: 5, graceMs: 1_000, ...kernel })

  assert.deepEqual(kernel.signals[0], [-200, 'SIGSTOP'], "the root's group is held still while the tree is read")
  assert.deepEqual(sorted(kernel.sent('SIGTERM')), [-202, -200, 200, 201, 202, 203])
  assert.deepEqual(kernel.sent('SIGKILL'), [], 'nothing needed SIGKILL')
  assert.deepEqual(sorted([...kernel.alive]), [1, 100, 300], 'only the tree is gone')
  assert.ok(
    !kernel.signals.some(([target]) => [1, -1, 100, -100, 300, -300].includes(target)),
    'the app, init and unrelated processes are never signalled'
  )
})

test('terminateProcessTree sends SIGKILL after the grace period to whatever ignored SIGTERM', async () => {
  const kernel = fakeKernel([203])
  const startedAt = Date.now()

  await terminateProcessTree(200, { platform: 'linux', pollMs: 5, graceMs: 60, ...kernel })

  assert.ok(Date.now() - startedAt >= 60, 'waited out the grace period first')
  assert.deepEqual(kernel.sent('SIGKILL'), [-202, 203], 'only what was still there')
  assert.ok(!kernel.alive.has(203))
})

test('terminateProcessTree falls back to the root and its group when ps cannot be read', async () => {
  const kernel = fakeKernel()

  await terminateProcessTree(200, { platform: 'darwin', pollMs: 5, kill: kernel.kill, listProcesses: () => null })

  assert.deepEqual(kernel.sent('SIGTERM'), [-200, 200])
})

test('terminateProcessTree uses taskkill /T on Windows and has nothing left to wait for', () => {
  const kills = []
  const taskkilled = []

  const stopping = terminateProcessTree(200, {
    platform: 'win32',
    taskkill: pid => taskkilled.push(pid),
    kill: (pid, signal) => kills.push([pid, signal])
  })

  assert.equal(stopping, null)
  assert.deepEqual(taskkilled, [200])
  assert.deepEqual(kills, [], 'no POSIX group signals on Windows')

  // taskkill missing or refused: the root is still stopped.
  terminateProcessTree(200, {
    platform: 'win32',
    taskkill: () => {
      throw new Error('taskkill: access denied')
    },
    kill: (pid, signal) => kills.push([pid, signal])
  })

  assert.deepEqual(kills, [[200, 'SIGTERM']])
})

// ---------------------------------------------------------------------------
// Real processes
// ---------------------------------------------------------------------------

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

function exitSignal(child): Promise<string | null> {
  return new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)))
}

function firstLine(child): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      out += chunk

      if (out.includes('\n')) {
        resolve(out.split('\n')[0])
      }
    })
    child.on('error', reject)
  })
}

async function waitUntil(what: string, probe: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs

  while (!probe()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test.skipIf(process.platform === 'win32')(
  'a real tree that ignores SIGTERM is gone once the teardown settles',
  async () => {
    const child = spawn('bash', ['-c', 'trap "" TERM; sleep 300 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true
    })

    const exited = exitSignal(child)
    const sleeper = Number(await firstLine(child))

    try {
      const stopping = terminateProcessTree(child.pid, { graceMs: 200, pollMs: 20 })

      assert.ok(isRunning(child.pid) && isRunning(sleeper), 'SIGTERM alone does not stop this tree')
      await stopping
      assert.equal(await exited, 'SIGKILL')
      await waitUntil('the grandchild to be gone', () => !isRunning(sleeper))
    } finally {
      for (const pid of [sleeper, child.pid]) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  },
  10_000
)

test.skipIf(process.platform === 'win32')(
  "a root left in the caller's own process group is stopped without signalling that group",
  async () => {
    // Were the group signalled, this test process would get the SIGTERM too.
    const child = spawn('sleep', ['300'], { stdio: 'ignore' })
    const exited = exitSignal(child)

    try {
      await terminateProcessTree(child.pid, { graceMs: 2_000, pollMs: 20 })
      assert.equal(await exited, 'SIGTERM')
    } finally {
      child.kill('SIGKILL')
    }
  },
  10_000
)
