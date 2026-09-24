import assert from 'node:assert/strict'

import { test } from 'vitest'

import { autostartMessagingGateway, describeGatewayAutostart } from './gateway-autostart'

async function run(post: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = []

  await autostartMessagingGateway({ log: line => lines.push(line), post })

  return lines
}

test('logs the channels a started gateway will serve', async () => {
  const lines = await run(async () => ({ platforms: ['telegram', 'discord'], reason: 'started', started: true }))

  assert.deepEqual(lines, ['[messaging] started the gateway for telegram, discord'])
})

test('names the running gateway it left alone', async () => {
  const lines = await run(async () => ({ pid: 46122, platforms: ['telegram'], reason: 'running', started: false }))

  assert.deepEqual(lines, ['[messaging] the gateway is already running (pid 46122)'])
})

test('explains every other decision the backend can make', () => {
  assert.equal(
    describeGatewayAutostart({ platforms: [], reason: 'no_platforms', started: false }),
    '[messaging] no channel is turned on; the gateway was not started'
  )
  assert.equal(
    describeGatewayAutostart({ platforms: ['telegram'], reason: 'service', started: false }),
    '[messaging] a login service runs the gateway for telegram; leaving it to that'
  )
  assert.equal(
    describeGatewayAutostart({ action: 'gateway-restart', platforms: ['telegram'], reason: 'busy', started: false }),
    '[messaging] gateway-restart is already in progress; leaving the gateway alone'
  )
})

test('an answer it does not understand is logged verbatim, not guessed at', () => {
  assert.equal(
    describeGatewayAutostart({ ok: true }),
    '[messaging] unexpected answer from the gateway autostart: {"ok":true}'
  )
  assert.equal(describeGatewayAutostart(null), '[messaging] unexpected answer from the gateway autostart: null')
})

test('a failed request is logged and never thrown into the boot', async () => {
  // An older backend without the route, a 500, a timeout: all end here.
  const lines = await run(async () => {
    throw new Error('404: {"detail":"Not Found"}')
  })

  assert.deepEqual(lines, ['[messaging] could not start the gateway: 404: {"detail":"Not Found"}'])
})

test('a non-Error rejection is still logged as text', async () => {
  const lines = await run(() => Promise.reject('socket hang up'))

  assert.deepEqual(lines, ['[messaging] could not start the gateway: socket hang up'])
})
