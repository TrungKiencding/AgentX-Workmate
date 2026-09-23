import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import {
  DEVICE_ID_HEADER,
  DEVICE_ID_RE,
  DEVICE_NAME_HEADER,
  deviceHeaders,
  deviceNameFrom,
  type DeviceStoreIo,
  isDeviceId,
  parseDeviceRecord,
  readDeviceRecord
} from './device-id'

function memoryIo(
  initial: string | null = null,
  overrides: Partial<DeviceStoreIo> = {}
): DeviceStoreIo & { text: string | null; writes: number } {
  const io: any = {
    hostname: () => 'kien-macbook',
    readText: () => io.text,
    text: initial,
    writes: 0,
    writeText: (value: string) => {
      io.text = value
      io.writes += 1
    },
    ...overrides
  }

  return io
}

describe('parseDeviceRecord', () => {
  test('survives every shape a broken file can take', () => {
    // Boot reads this. A throw here costs the user their app; a null costs
    // them one stale row in a device list they can delete.
    for (const raw of [
      null,
      '',
      'not json',
      '[]',
      '"string"',
      '{}',
      '{"id": 7}',
      '{"id": "not-a-uuid"}',
      '{"id": "0123456789ab-cdef-0123-456789abcdef"}'
    ]) {
      assert.equal(parseDeviceRecord(raw), null)
    }
  })

  test('keeps a well-formed record verbatim', () => {
    const record = parseDeviceRecord(
      JSON.stringify({
        id: '6d1b0a3e-1f2c-4b8a-9c7d-5e4f3a2b1c0d',
        name: 'kien-macbook',
        createdAt: '2026-08-13T00:00:00.000Z'
      })
    )

    assert.deepEqual(record, {
      id: '6d1b0a3e-1f2c-4b8a-9c7d-5e4f3a2b1c0d',
      name: 'kien-macbook',
      createdAt: '2026-08-13T00:00:00.000Z'
    })
  })

  test('rejects an uppercase uuid so one machine cannot look like two', () => {
    assert.equal(parseDeviceRecord('{"id": "6D1B0A3E-1F2C-4B8A-9C7D-5E4F3A2B1C0D"}'), null)
  })
})

describe('readDeviceRecord', () => {
  test('mints and persists an id on the first read', () => {
    const io = memoryIo()

    const record = readDeviceRecord(io)

    assert.ok(DEVICE_ID_RE.test(record.id), record.id)
    assert.equal(record.name, 'kien-macbook')
    assert.ok(Date.parse(record.createdAt) > 0)
    assert.equal(io.writes, 1)
    assert.equal(JSON.parse(io.text as string).id, record.id)
  })

  test('returns the same id on every later read, without rewriting', () => {
    const io = memoryIo()

    const first = readDeviceRecord(io)
    const second = readDeviceRecord(io)
    const third = readDeviceRecord(io)

    assert.equal(second.id, first.id)
    assert.equal(third.id, first.id)
    assert.equal(second.createdAt, first.createdAt)
    // One write total: the steady-state path must not touch the disk.
    assert.equal(io.writes, 1)
  })

  test('a malformed file yields a new valid id instead of throwing', () => {
    const io = memoryIo('{ this is not json')

    const record = readDeviceRecord(io)

    assert.ok(DEVICE_ID_RE.test(record.id))
    assert.equal(io.writes, 1)
  })

  test('an unreadable file does not stop the app from booting', () => {
    const logged: string[] = []

    const io = memoryIo(null, {
      readText: () => {
        throw new Error('EACCES')
      },
      rememberLog: (message: string) => logged.push(message)
    })

    const record = readDeviceRecord(io)

    assert.ok(DEVICE_ID_RE.test(record.id))
    assert.ok(logged.some(line => line.includes('could not read the device id')))
  })

  test('an unwritable userData still yields a usable id', () => {
    const logged: string[] = []

    const io = memoryIo(null, {
      writeText: () => {
        throw new Error('EROFS')
      },
      rememberLog: (message: string) => logged.push(message)
    })

    const record = readDeviceRecord(io)

    assert.ok(DEVICE_ID_RE.test(record.id))
    assert.ok(logged.some(line => line.includes('could not persist the device id')))
  })

  test('renaming the machine keeps the id and refreshes the label', () => {
    // The id is the install; the name is only what the device list shows.
    // Minting a new id here would silently orphan the row the user is
    // looking at, and they would have to revoke a machine they still use.
    const io = memoryIo()
    const first = readDeviceRecord(io)

    io.hostname = () => 'kien-desktop'
    const second = readDeviceRecord(io)

    assert.equal(second.id, first.id)
    assert.equal(second.createdAt, first.createdAt)
    assert.equal(second.name, 'kien-desktop')
    assert.equal(io.writes, 2)
  })

  test('the id outlives whoever is signed in', () => {
    // accounts.json changes when a different person signs in; device.json is
    // a sibling file in userData precisely so it does not.
    const io = memoryIo()
    const before = readDeviceRecord(io)

    // Nothing about a sign-in touches this store.
    const after = readDeviceRecord(io)

    assert.equal(after.id, before.id)
  })
})

describe('deviceNameFrom', () => {
  test('keeps ordinary machine names as they are', () => {
    assert.equal(deviceNameFrom('Kien-MacBook-Pro.local'), 'Kien-MacBook-Pro.local')
  })

  test('strips what a header cannot carry', () => {
    // A machine name is user-controlled and this reaches an HTTP header.
    assert.equal(deviceNameFrom('laptop\r\nX-Injected: yes'), 'laptop X-Injected yes')
  })

  test('collapses non-ascii rather than dropping the name', () => {
    assert.equal(deviceNameFrom('máy-của-kiên'), 'm y-c a-ki n')
  })

  test('bounds the length', () => {
    assert.equal(deviceNameFrom('n'.repeat(200)).length, 64)
  })

  test('never returns empty', () => {
    for (const raw of ['', '   ', '\u0000\u0001', '???']) {
      assert.equal(deviceNameFrom(raw), 'unknown device')
    }
  })
})

describe('deviceHeaders', () => {
  test('carries the id and the name', () => {
    const headers = deviceHeaders({
      id: '6d1b0a3e-1f2c-4b8a-9c7d-5e4f3a2b1c0d',
      name: 'kien-macbook',
      createdAt: '2026-08-13T00:00:00.000Z'
    })

    assert.deepEqual(headers, {
      [DEVICE_ID_HEADER]: '6d1b0a3e-1f2c-4b8a-9c7d-5e4f3a2b1c0d',
      [DEVICE_NAME_HEADER]: 'kien-macbook'
    })
  })

  test('sends nothing rather than a malformed header', () => {
    // The service answers a MISSING device header with a clear 400. A
    // malformed one is a case nobody has thought about.
    assert.deepEqual(deviceHeaders(null), {})
    assert.deepEqual(deviceHeaders({ id: 'not-a-uuid', name: 'x', createdAt: '' }), {})
  })

  test('re-sanitizes the stored name on the way out', () => {
    const headers = deviceHeaders({
      id: '6d1b0a3e-1f2c-4b8a-9c7d-5e4f3a2b1c0d',
      name: 'edited\r\nX-Evil: 1',
      createdAt: ''
    })

    assert.ok(!headers[DEVICE_NAME_HEADER].includes('\r'))
    assert.ok(!headers[DEVICE_NAME_HEADER].includes('\n'))
  })
})

describe('isDeviceId', () => {
  test('accepts what we write and rejects what we do not', () => {
    assert.equal(isDeviceId('6d1b0a3e-1f2c-4b8a-9c7d-5e4f3a2b1c0d'), true)
    assert.equal(isDeviceId('6d1b0a3e1f2c4b8a9c7d5e4f3a2b1c0d'), false)
    assert.equal(isDeviceId(''), false)
    assert.equal(isDeviceId(null), false)
    assert.equal(isDeviceId(42), false)
  })
})
