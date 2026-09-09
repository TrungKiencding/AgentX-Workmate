/**
 * Minimal ZIP writer for tests (store + deflate, no ZIP64). Lives next to the
 * reader so tests can build archives — including deliberately hostile ones —
 * without a `zip` binary on the machine.
 */

import { deflateRawSync } from 'node:zlib'

import { crc32 } from './zip'

export interface ZipInput {
  name: string
  data?: Buffer | string
  /** Force the store method; deflate is the default for files. */
  store?: boolean
}

function dosDateTime(): { time: number; date: number } {
  // A fixed timestamp keeps archives byte-identical between runs.
  return { time: (12 << 11) | (0 << 5) | 0, date: ((2026 - 1980) << 9) | (9 << 5) | 9 }
}

export function buildZip(inputs: ZipInput[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const { time, date } = dosDateTime()

  for (const input of inputs) {
    const isDirectory = input.name.endsWith('/')
    const data = isDirectory
      ? Buffer.alloc(0)
      : Buffer.isBuffer(input.data)
        ? input.data
        : Buffer.from(input.data ?? '', 'utf8')
    const method = isDirectory || input.store ? 0 : 8
    const payload = method === 8 ? deflateRawSync(data) : data
    const name = Buffer.from(input.name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    locals.push(local, payload)
    centrals.push(central)
    offset += local.length + payload.length
  }

  const centralDirectory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(inputs.length, 8)
  eocd.writeUInt16LE(inputs.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralDirectory, eocd])
}
