import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { describe, test } from 'vitest'

import { CdpError, CdpPipe, NulFramer } from './cdp-pipe'

/** A fake browser end of the pipe: what we write arrives as `commands`; `reply()` answers. */
function fakePipe() {
  const toBrowser = new PassThrough()
  const fromBrowser = new PassThrough()
  const commands: Array<{ id: number; method: string; params: Record<string, unknown>; sessionId?: string }> = []
  const framer = new NulFramer()

  toBrowser.on('data', chunk => {
    for (const frame of framer.push(chunk)) {
      commands.push(JSON.parse(frame))
    }
  })

  return {
    commands,
    reply: (message: Record<string, unknown>) => fromBrowser.write(`${JSON.stringify(message)}\0`),
    writeRaw: (text: string) => fromBrowser.write(text),
    end: () => fromBrowser.end(),
    pipe: new CdpPipe(toBrowser, fromBrowser, { defaultTimeoutMs: 200 })
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

describe('NulFramer', () => {
  test('splits NUL-delimited documents across chunk boundaries', () => {
    const framer = new NulFramer()

    assert.deepEqual(framer.push('{"a":1}\0{"b"'), ['{"a":1}'])
    assert.deepEqual(framer.push(':2}\0'), ['{"b":2}'])
    assert.deepEqual(framer.push(Buffer.from('{"c":3}\0{"d":4}\0')), ['{"c":3}', '{"d":4}'])
    assert.deepEqual(framer.push(''), [])
  })
})

describe('CdpPipe', () => {
  test('correlates replies by id, in any order, and surfaces protocol errors', async () => {
    const fake = fakePipe()
    const first = fake.pipe.send<{ product: string }>('Browser.getVersion')
    const second = fake.pipe.send('Extensions.loadUnpacked', { path: '/x' })

    await tick()
    assert.deepEqual(
      fake.commands.map(c => [c.id, c.method]),
      [
        [1, 'Browser.getVersion'],
        [2, 'Extensions.loadUnpacked']
      ]
    )
    assert.deepEqual(fake.commands[1].params, { path: '/x' })

    fake.reply({ id: 2, error: { code: -32000, message: 'Extension loading is not enabled' } })
    fake.reply({ id: 1, result: { product: 'Chrome/152' } })

    assert.deepEqual(await first, { product: 'Chrome/152' })
    await assert.rejects(second, (error: unknown) => {
      assert.ok(error instanceof CdpError)
      assert.equal(error.method, 'Extensions.loadUnpacked')
      assert.equal(error.code, -32000)
      assert.match(error.message, /not enabled/)

      return true
    })
  })

  test('delivers events to listeners and ignores junk frames', async () => {
    const fake = fakePipe()
    const events: Array<[string, unknown, string | undefined]> = []

    fake.pipe.onEvent((method, params, sessionId) => void events.push([method, params, sessionId]))
    fake.writeRaw('not json\0')
    fake.reply({ method: 'Target.targetCreated', params: { targetInfo: { type: 'page' } }, sessionId: 'S1' })
    await tick()

    assert.deepEqual(events, [['Target.targetCreated', { targetInfo: { type: 'page' } }, 'S1']])
  })

  test('sessionId rides along, a silent browser times out, and a closed pipe fails everything pending', async () => {
    const fake = fakePipe()
    const withSession = fake.pipe.send('Page.enable', {}, { sessionId: 'S9', timeoutMs: 50 })

    await tick()
    assert.equal(fake.commands[0].sessionId, 'S9')
    await assert.rejects(withSession, /timed out/)

    const hanging = fake.pipe.send('Target.getTargets', {}, { timeoutMs: 5_000 })

    fake.end()
    await assert.rejects(hanging, /pipe closed/)
    assert.equal(fake.pipe.isClosed, true)
    await assert.rejects(fake.pipe.send('Browser.close'), /pipe closed/)
  })
})
