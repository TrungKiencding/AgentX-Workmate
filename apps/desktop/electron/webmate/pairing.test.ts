import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import { buildWorkmateJson, defaultPairingIo, ensurePairing, parsePairingFile, type PairingIo, writeWorkmateJsonInto } from './pairing'
import { webmatePaths } from './paths'

function memoryIo(initial: Record<string, string> = {}): PairingIo & { files: Map<string, string>; modes: Map<string, number>; writes: string[] } {
  const files = new Map(Object.entries(initial))
  const modes = new Map<string, number>()
  const writes: string[] = []
  let tokens = 0
  let uuids = 0

  return {
    files,
    modes,
    writes,
    readText: p => files.get(p) ?? null,
    writeTextAtomic: (p, text, mode) => {
      files.set(p, text)
      if (mode !== undefined) modes.set(p, mode)
      writes.push(p)
    },
    exists: p => files.has(p),
    mkdirp: () => {},
    randomToken: () => `token-${++tokens}-`.padEnd(44, 'x'),
    uuid: () => `uuid-${++uuids}`,
    now: () => new Date('2026-09-09T00:00:00.000Z')
  }
}

const OPTIONS = { port: 17374, workmateVersion: '0.21.0' }
const paths = webmatePaths('/home/k/.agentx', path.posix)

describe('parsePairingFile', () => {
  test('accepts a Workmate file and rejects every broken shape', () => {
    const good = parsePairingFile(JSON.stringify({ schema: 1, token: 'a'.repeat(44), port: 17374, installId: 'i', createdAt: 't' }))

    assert.deepEqual(good, { schema: 1, token: 'a'.repeat(44), port: 17374, installId: 'i', createdAt: 't' })

    for (const bad of [null, '', '{', '[]', JSON.stringify({ schema: 2, token: 'a'.repeat(44) }), JSON.stringify({ schema: 1, token: 'short' })]) {
      assert.equal(parsePairingFile(bad), null, JSON.stringify(bad))
    }
  })
})

describe('ensurePairing', () => {
  test('creates pairing.json (0600) on a fresh machine and waits with workmate.json until the folder exists', () => {
    const io = memoryIo()
    const first = ensurePairing(paths, OPTIONS, io)

    assert.equal(first.pairingWritten, true)
    assert.equal(first.extensionPresent, false)
    assert.equal(first.workmateJsonWritten, false)
    assert.equal(io.modes.get(paths.pairingFile), 0o600)
    const written = JSON.parse(io.files.get(paths.pairingFile)!)

    assert.deepEqual(written, { schema: 1, token: first.pairing.token, port: 17374, installId: 'uuid-1', createdAt: '2026-09-09T00:00:00.000Z' })
    assert.ok(first.pairing.token.length >= 32)

    // Second boot: nothing changes, nothing is rewritten.
    const second = ensurePairing(paths, OPTIONS, io)

    assert.equal(second.pairingWritten, false)
    assert.equal(second.pairing.token, first.pairing.token)
    assert.equal(io.writes.length, 1)
  })

  test('writes workmate.json once the extension folder exists, and only when it changes', () => {
    const io = memoryIo({ [path.posix.join(paths.installDir, 'manifest.json')]: '{"version":"1.0.4"}' })
    const first = ensurePairing(paths, OPTIONS, io)

    assert.equal(first.extensionPresent, true)
    assert.equal(first.workmateJsonWritten, true)
    const workmate = JSON.parse(io.files.get(paths.workmateJson)!)

    assert.deepEqual(workmate, {
      schema: 1,
      wsUrl: 'ws://127.0.0.1:17374/extension',
      token: first.pairing.token,
      installId: 'uuid-1',
      workmateVersion: '0.21.0',
      minServerVersion: '1.1.0'
    })
    assert.equal(io.files.get(paths.workmateJson)!.endsWith('\n'), true, 'UTF-8 text with a trailing newline, no BOM')
    assert.ok(!io.files.get(paths.workmateJson)!.startsWith('﻿'))

    const again = ensurePairing(paths, OPTIONS, io)

    assert.equal(again.workmateJsonWritten, false, 'identical content is not rewritten')

    const newVersion = ensurePairing(paths, { ...OPTIONS, workmateVersion: '0.22.0' }, io)

    assert.equal(newVersion.workmateJsonWritten, true)
    assert.equal(newVersion.pairingWritten, false, 'a Workmate version bump does not touch the token')
  })

  test('a port change rewrites both files with the same token; rotate mints a new token', () => {
    const io = memoryIo({ [path.posix.join(paths.installDir, 'manifest.json')]: '{}' })
    const first = ensurePairing(paths, OPTIONS, io)
    const moved = ensurePairing(paths, { ...OPTIONS, port: 17390 }, io)

    assert.equal(moved.pairingWritten, true)
    assert.equal(moved.pairing.token, first.pairing.token, 'moving the port keeps the token')
    assert.equal(moved.pairing.port, 17390)
    assert.equal(moved.pairing.installId, first.pairing.installId)
    assert.equal(JSON.parse(io.files.get(paths.workmateJson)!).wsUrl, 'ws://127.0.0.1:17390/extension')

    const rotated = ensurePairing(paths, { ...OPTIONS, rotate: true }, io)

    assert.equal(rotated.pairingWritten, true)
    assert.notEqual(rotated.pairing.token, first.pairing.token)
    assert.equal(rotated.pairing.installId, first.pairing.installId, 'the install keeps its identity across token resets')
    assert.equal(JSON.parse(io.files.get(paths.workmateJson)!).token, rotated.pairing.token)
    assert.equal(JSON.parse(io.files.get(paths.pairingFile)!).token, rotated.pairing.token)
  })

  test('a corrupted pairing.json is replaced rather than trusted', () => {
    const io = memoryIo({ [paths.pairingFile]: '{ torn' })
    const outcome = ensurePairing(paths, OPTIONS, io)

    assert.equal(outcome.pairingWritten, true)
    assert.equal(JSON.parse(io.files.get(paths.pairingFile)!).schema, 1)
  })

  test('writeWorkmateJsonInto targets a staged folder', () => {
    const io = memoryIo()
    const pairing = { schema: 1 as const, token: 't'.repeat(44), port: 17374, installId: 'i', createdAt: 'c' }

    writeWorkmateJsonInto('/stage/1.0.5', pairing, OPTIONS, io)
    assert.deepEqual(JSON.parse(io.files.get('/stage/1.0.5/workmate.json')!), buildWorkmateJson(pairing, OPTIONS))
  })
})

describe('defaultPairingIo', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })))
  })

  test('writes atomically with the requested mode and reads back', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webmate-pairing-'))

    dirs.push(dir)
    const io = defaultPairingIo()
    const file = path.join(dir, 'nested', 'pairing.json')

    io.writeTextAtomic(file, '{"a":1}\n', 0o600)
    assert.equal(io.readText(file), '{"a":1}\n')
    assert.equal(io.exists(file), true)
    assert.equal(fs.readdirSync(path.dirname(file)).length, 1, 'no temp file left behind')

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    }

    assert.equal(io.readText(path.join(dir, 'missing.json')), null)
    assert.match(io.randomToken(), /^[A-Za-z0-9+/]{43}=$/)
    assert.match(io.uuid(), /^[0-9a-f-]{36}$/)
  })
})
