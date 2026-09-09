/**
 * A small, dependency-free ZIP reader for the WebMate extension package.
 *
 * The package is a plain zip written by `git archive --format=zip` (store or
 * deflate entries, no ZIP64, no encryption), so the whole format needed here is
 * the end-of-central-directory record, the central directory and the local
 * file headers. Every entry name is checked against path traversal before a
 * byte is written: an update feed is signed, but the extraction step must
 * still refuse `../` on its own.
 *
 * Pure functions over a Buffer plus one async extractor; no third-party zip
 * library (constraint: no new dependencies in the desktop app).
 */

import { promises as fsp } from 'node:fs'
import nodePath from 'node:path'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

export interface ZipEntry {
  name: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  crc32: number
  localHeaderOffset: number
  isDirectory: boolean
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

/** Parse the central directory. Throws ZipError on anything malformed. */
export function listZipEntries(archive: Buffer): ZipEntry[] {
  if (archive.length < 22) {
    throw new ZipError('archive is too small to be a zip file')
  }

  const earliest = Math.max(0, archive.length - 0xffff - 22)
  let eocd = -1

  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) {
      eocd = offset

      break
    }
  }

  if (eocd < 0) {
    throw new ZipError('no end-of-central-directory record; not a zip file')
  }

  const entryCount = archive.readUInt16LE(eocd + 10)
  const centralSize = archive.readUInt32LE(eocd + 12)
  let offset = archive.readUInt32LE(eocd + 16)

  if (entryCount === 0xffff || centralSize === 0xffffffff || offset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported')
  }

  const entries: ZipEntry[] = []

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipError(`invalid central-directory entry at index ${index}`)
    }

    const compressionMethod = archive.readUInt16LE(offset + 10)
    const crc32 = archive.readUInt32LE(offset + 16)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const localHeaderOffset = archive.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength

    if (nameEnd > archive.length) {
      throw new ZipError(`truncated entry name at index ${index}`)
    }

    const name = archive.toString('utf8', nameStart, nameEnd)

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      crc32,
      localHeaderOffset,
      isDirectory: name.endsWith('/')
    })
    offset = nameEnd + extraLength + commentLength
  }

  return entries
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let n = 0; n < 256; n += 1) {
    let c = n

    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }

    table[n] = c >>> 0
  }

  return table
})()

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff

  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

/** The uncompressed bytes of one entry, CRC-checked. */
export function readZipEntry(archive: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localHeaderOffset

  if (header + 30 > archive.length || archive.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) {
    throw new ZipError(`invalid local header for ${entry.name}`)
  }

  // The local header repeats the name/extra fields with possibly different
  // extra lengths; the central directory's sizes are authoritative.
  const nameLength = archive.readUInt16LE(header + 26)
  const extraLength = archive.readUInt16LE(header + 28)
  const dataStart = header + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize

  if (dataEnd > archive.length) {
    throw new ZipError(`truncated data for ${entry.name}`)
  }

  const raw = archive.subarray(dataStart, dataEnd)
  let data: Buffer

  if (entry.compressionMethod === METHOD_STORE) {
    data = Buffer.from(raw)
  } else if (entry.compressionMethod === METHOD_DEFLATE) {
    data = inflateRawSync(raw)
  } else {
    throw new ZipError(`unsupported compression method ${entry.compressionMethod} for ${entry.name}`)
  }

  if (data.length !== entry.uncompressedSize) {
    throw new ZipError(`size mismatch for ${entry.name}: expected ${entry.uncompressedSize}, got ${data.length}`)
  }

  if (crc32(data) !== entry.crc32) {
    throw new ZipError(`CRC mismatch for ${entry.name}`)
  }

  return data
}

/**
 * The destination for an entry, or null when the name must not be written:
 * absolute paths, drive letters, backslash separators, `..` segments, or
 * anything that would resolve outside `destDir`.
 */
export function safeEntryPath(name: string, destDir: string, pathModule: typeof nodePath = nodePath): string | null {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    return null
  }

  const segments = name.split('/').filter(segment => segment.length > 0)

  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
    return null
  }

  const resolvedDest = pathModule.resolve(destDir)
  const target = pathModule.resolve(resolvedDest, ...segments)
  const relative = pathModule.relative(resolvedDest, target)

  if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
    return null
  }

  return target
}

export interface ExtractResult {
  files: number
  bytes: number
}

/**
 * Extract the whole archive under `destDir` (created if missing). Refuses the
 * archive as a whole — before writing anything — if any entry is unsafe, so a
 * half-extracted folder never exists.
 */
export async function extractZip(archive: Buffer, destDir: string): Promise<ExtractResult> {
  const entries = listZipEntries(archive)
  const planned: Array<{ entry: ZipEntry; target: string }> = []

  for (const entry of entries) {
    const target = safeEntryPath(entry.name, destDir)

    if (target === null) {
      throw new ZipError(`refusing unsafe entry name: ${JSON.stringify(entry.name)}`)
    }

    planned.push({ entry, target })
  }

  await fsp.mkdir(destDir, { recursive: true })
  let files = 0
  let bytes = 0

  for (const { entry, target } of planned) {
    if (entry.isDirectory) {
      await fsp.mkdir(target, { recursive: true })

      continue
    }

    const data = readZipEntry(archive, entry)

    await fsp.mkdir(nodePath.dirname(target), { recursive: true })
    await fsp.writeFile(target, data)
    files += 1
    bytes += data.length
  }

  return { files, bytes }
}
