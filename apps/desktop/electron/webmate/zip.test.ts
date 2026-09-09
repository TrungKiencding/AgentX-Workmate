import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import { crc32, extractZip, listZipEntries, readZipEntry, safeEntryPath, ZipError } from './zip'
import { buildZip } from './zip-writer.test-helper'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webmate-zip-'))

  tempDirs.push(dir)

  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })))
})

describe('zip reader', () => {
  test('crc32 matches the reference vector', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
    assert.equal(crc32(Buffer.alloc(0)), 0)
  })

  test('lists and reads store and deflate entries', () => {
    const big = Buffer.alloc(20_000, 'a')

    const archive = buildZip([
      { name: 'manifest.json', data: '{"version":"1.0.4"}' },
      { name: 'icons/', data: '' },
      { name: 'icons/icon16.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), store: true },
      { name: 'src/big.js', data: big }
    ])

    const entries = listZipEntries(archive)

    assert.deepEqual(
      entries.map(e => [e.name, e.isDirectory, e.compressionMethod]),
      [
        ['manifest.json', false, 8],
        ['icons/', true, 0],
        ['icons/icon16.png', false, 0],
        ['src/big.js', false, 8]
      ]
    )
    assert.equal(readZipEntry(archive, entries[0]).toString(), '{"version":"1.0.4"}')
    assert.deepEqual([...readZipEntry(archive, entries[2])], [0x89, 0x50, 0x4e, 0x47])
    assert.ok(readZipEntry(archive, entries[3]).equals(big))
    assert.ok(entries[3].compressedSize < big.length, 'a repetitive file must actually compress')
  })

  test('rejects non-zips and corrupted data', () => {
    assert.throws(() => listZipEntries(Buffer.from('not a zip at all, definitely not')), ZipError)
    assert.throws(() => listZipEntries(Buffer.alloc(3)), ZipError)

    const archive = buildZip([{ name: 'a.txt', data: 'hello world hello world' }])
    const entries = listZipEntries(archive)
    const corrupted = Buffer.from(archive)
    // Flip a byte inside the compressed payload (after the 30-byte local header + 5-byte name).
    corrupted[36] ^= 0xff
    assert.throws(() => readZipEntry(corrupted, entries[0]), /CRC mismatch|invalid|unexpected/i)
  })

  test('safeEntryPath refuses every escape shape and keeps normal names', () => {
    const dest = '/tmp/dest'
    const p = path.posix

    assert.equal(safeEntryPath('manifest.json', dest, p), '/tmp/dest/manifest.json')
    assert.equal(safeEntryPath('src/a/b.js', dest, p), '/tmp/dest/src/a/b.js')
    assert.equal(safeEntryPath('icons/', dest, p), '/tmp/dest/icons')

    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:evil', 'C:\\x', 'a\\b', '', './', 'a/./b', 'a\0b']) {
      assert.equal(safeEntryPath(bad, dest, p), null, JSON.stringify(bad))
    }

    assert.equal(safeEntryPath('src/a.js', 'C:\\dest', path.win32), 'C:\\dest\\src\\a.js')
    assert.equal(safeEntryPath('..\\x', 'C:\\dest', path.win32), null)
  })

  test('extractZip writes the tree and refuses a hostile archive before touching disk', async () => {
    const dir = await tempDir()

    const archive = buildZip([
      { name: 'manifest.json', data: '{"version":"1.0.4"}' },
      { name: 'src/', data: '' },
      { name: 'src/background.js', data: 'console.log(1)' }
    ])

    const result = await extractZip(archive, path.join(dir, 'out'))

    assert.deepEqual(result, { files: 2, bytes: '{"version":"1.0.4"}'.length + 'console.log(1)'.length })
    assert.equal(await fsp.readFile(path.join(dir, 'out', 'manifest.json'), 'utf8'), '{"version":"1.0.4"}')
    assert.equal(await fsp.readFile(path.join(dir, 'out', 'src', 'background.js'), 'utf8'), 'console.log(1)')

    const hostile = buildZip([
      { name: 'ok.txt', data: 'fine' },
      { name: '../escape.txt', data: 'nope' }
    ])

    await assert.rejects(() => extractZip(hostile, path.join(dir, 'hostile')), /unsafe entry name/)
    await assert.rejects(
      () => fsp.stat(path.join(dir, 'hostile', 'ok.txt')),
      'nothing may be written from a refused archive'
    )
    await assert.rejects(() => fsp.stat(path.join(dir, 'escape.txt')))
  })
})
