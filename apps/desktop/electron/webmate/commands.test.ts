import assert from 'node:assert/strict'
import path from 'node:path'

import { describe, test } from 'vitest'

import { parseLastCommand, sendWebmateCommand, waitForCommandResult, type WebmateLastCommand } from './commands'
import { webmatePaths } from './paths'

const paths = webmatePaths('/home/k/.agentx', path.posix)

describe('sendWebmateCommand', () => {
  test('writes one whole JSON file per command under commands/ and returns its id', () => {
    const files = new Map<string, string>()
    const dirs: string[] = []

    const id = sendWebmateCommand(
      paths,
      'prepare_update',
      {
        writeTextAtomic: (p, text) => void files.set(p, text),
        mkdirp: dir => void dirs.push(dir),
        uuid: () => 'cmd-1'
      },
      path.posix
    )

    assert.equal(id, 'cmd-1')
    assert.deepEqual(dirs, ['/home/k/.agentx/webmate/commands'])
    assert.deepEqual([...files.keys()], ['/home/k/.agentx/webmate/commands/cmd-1.json'])
    assert.deepEqual(JSON.parse(files.get('/home/k/.agentx/webmate/commands/cmd-1.json')!), {
      id: 'cmd-1',
      action: 'prepare_update'
    })
  })
})

describe('waitForCommandResult', () => {
  const outcome = (id: string, extra: Partial<WebmateLastCommand> = {}): WebmateLastCommand => ({
    id,
    action: 'prepare_update',
    ok: true,
    busy: 0,
    error: null,
    startedAt: 't0',
    finishedAt: 't1',
    ...extra
  })

  test('resolves as soon as state.json names the command id', async () => {
    let reads = 0
    const slept: number[] = []

    const result = await waitForCommandResult('cmd-2', {
      timeoutMs: 5_000,
      pollMs: 100,
      readLastCommand: () => (++reads >= 3 ? outcome('cmd-2') : outcome('cmd-1')),
      sleep: async ms => void slept.push(ms),
      now: () => 0
    })

    assert.equal(result?.id, 'cmd-2')
    assert.deepEqual(slept, [100, 100])
  })

  test('returns null when the deadline passes without an acknowledgement', async () => {
    let clock = 0

    const result = await waitForCommandResult('cmd-3', {
      timeoutMs: 1_000,
      pollMs: 400,
      readLastCommand: () => null,
      sleep: async ms => void (clock += ms),
      now: () => clock
    })

    assert.equal(result, null)
    assert.equal(clock, 1_200)
  })
})

describe('parseLastCommand', () => {
  test('accepts the server shape and rejects junk', () => {
    assert.equal(parseLastCommand(null), null)
    assert.equal(parseLastCommand({ id: 1 }), null)
    assert.deepEqual(parseLastCommand({ id: 'a', action: 'reload', ok: true, startedAt: 's', finishedAt: 'f' }), {
      id: 'a',
      action: 'reload',
      ok: true,
      busy: undefined,
      error: null,
      startedAt: 's',
      finishedAt: 'f'
    })
    assert.equal(
      parseLastCommand({ id: 'a', action: 'prepare_update', ok: false, busy: 2, error: 'still 2 run(s) busy' })?.busy,
      2
    )
  })
})
