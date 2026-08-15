import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'vitest'

import {
  checkWindowsExeIdentity,
  parseVersionStrings,
  readIcoEntries,
  readPeIdentity
} from '../scripts/win-exe-identity.mjs'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const ICON_ICO = path.join(DESKTOP_ROOT, 'assets', 'icon.ico')

const sha256 = buf => createHash('sha256').update(buf).digest('hex')

// ---------------------------------------------------------------------------
// Fixture builders
//
// A packed exe is 200MB and not in the repo, so the PE reader is exercised
// against a hand-built one. It is a real PE as far as the reader is concerned:
// MZ stub, PE signature, an optional header, one section, and a resource tree
// whose RVAs have to be translated through that section — which is exactly the
// arithmetic that would be wrong if the reader were wrong.
// ---------------------------------------------------------------------------

function versionNode(key, value, children = []) {
  const keyBuf = Buffer.from(key + '\0', 'utf16le')
  const isText = value !== null
  const valueBuf = isText ? Buffer.from(value + '\0', 'utf16le') : Buffer.alloc(0)
  const align = n => (n + 3) & ~3

  const headerAndKey = align(6 + keyBuf.length)
  const withValue = align(headerAndKey + valueBuf.length)
  const childBuf = Buffer.concat(children.map(c => padTo4(c)))
  const total = withValue + childBuf.length

  const node = Buffer.alloc(total)
  node.writeUInt16LE(total, 0)
  // wValueLength counts CHARACTERS for a text node and BYTES for a binary one.
  node.writeUInt16LE(isText ? valueBuf.length / 2 : 0, 2)
  node.writeUInt16LE(isText ? 1 : 0, 4)
  keyBuf.copy(node, 6)
  valueBuf.copy(node, headerAndKey)
  childBuf.copy(node, withValue)

  return node
}

function padTo4(buf) {
  const pad = (4 - (buf.length % 4)) % 4

  return pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf
}

function versionInfoBlob(strings) {
  const stringNodes = Object.entries(strings).map(([k, v]) => versionNode(k, v))
  const table = versionNode('040904b0', null, stringNodes)
  const stringFileInfo = versionNode('StringFileInfo', null, [table])

  return versionNode('VS_VERSION_INFO', null, [stringFileInfo])
}

/** A PNG-headed icon image of the given size, with distinguishable bytes. */
function pngIcon(size, seed) {
  const blob = Buffer.alloc(64, seed)
  blob.writeUInt32BE(0x89504e47, 0)
  blob.writeUInt32BE(size, 16)
  blob.writeUInt32BE(size, 20)

  return blob
}

function buildIco(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  let offset = header.length

  images.forEach(({ size, blob }, i) => {
    const dir = 6 + i * 16
    header.writeUInt8(size === 256 ? 0 : size, dir)
    header.writeUInt8(size === 256 ? 0 : size, dir + 1)
    header.writeUInt32LE(blob.length, dir + 8)
    header.writeUInt32LE(offset, dir + 12)
    offset += blob.length
  })

  return Buffer.concat([header, ...images.map(i => i.blob)])
}

/**
 * A minimal PE whose .rsrc section holds one RT_ICON per image plus one
 * RT_VERSION. Layout: [MZ 64][PE header + 1 section header][.rsrc raw data].
 */
function buildPe({ icons = [], versionStrings = null } = {}) {
  const SECTION_RVA = 0x1000
  const types = []

  if (icons.length) {
    types.push({ id: 3, blobs: icons })
  }

  if (versionStrings) {
    types.push({ id: 16, blobs: [versionInfoBlob(versionStrings)] })
  }

  // Three directory levels (type → name → language), then one data entry per
  // leaf, then the payloads.
  const dirSize = t => 16 + t * 8
  let cursor = dirSize(types.length)
  const namePlan = []

  for (const type of types) {
    namePlan.push({ type, offset: cursor })
    cursor += dirSize(type.blobs.length)
  }

  const langPlan = []

  for (const { type } of namePlan) {
    for (const blob of type.blobs) {
      langPlan.push({ blob, offset: cursor })
      cursor += dirSize(1)
    }
  }

  const entryPlan = langPlan.map(l => {
    const entry = { ...l, entryOffset: cursor }
    cursor += 16

    return entry
  })

  const dataStart = (cursor + 15) & ~15
  const rsrc = Buffer.alloc(dataStart + entryPlan.reduce((n, e) => n + e.blob.length, 0))

  const writeDir = (offset, entries) => {
    rsrc.writeUInt16LE(0, offset + 12) // named entries
    rsrc.writeUInt16LE(entries.length, offset + 14) // id entries
    entries.forEach(({ id, target, isDir }, i) => {
      rsrc.writeUInt32LE(id, offset + 16 + i * 8)
      // `>>> 0` because JS bitwise ops yield a SIGNED int32 and the high bit
      // (set to mean "this points at a subdirectory") makes it negative.
      rsrc.writeUInt32LE(isDir ? (target | 0x80000000) >>> 0 : target, offset + 16 + i * 8 + 4)
    })
  }

  writeDir(
    0,
    namePlan.map(({ type, offset }) => ({ id: type.id, target: offset, isDir: true }))
  )

  let leafIndex = 0

  for (const { type, offset } of namePlan) {
    writeDir(
      offset,
      type.blobs.map((_, i) => ({ id: i + 1, target: langPlan[leafIndex + i].offset, isDir: true }))
    )
    leafIndex += type.blobs.length
  }

  entryPlan.forEach((entry, i) => {
    writeDir(langPlan[i].offset, [{ id: 1033, target: entry.entryOffset, isDir: false }])
  })

  let payload = dataStart

  for (const entry of entryPlan) {
    rsrc.writeUInt32LE(SECTION_RVA + payload, entry.entryOffset)
    rsrc.writeUInt32LE(entry.blob.length, entry.entryOffset + 4)
    entry.blob.copy(rsrc, payload)
    payload += entry.blob.length
  }

  const PE_OFFSET = 0x40
  const OPTIONAL_SIZE = 240 // PE32+ optional header with 16 data directories
  const headers = Buffer.alloc(PE_OFFSET + 24 + OPTIONAL_SIZE + 40)
  headers.writeUInt16LE(0x5a4d, 0)
  headers.writeUInt32LE(PE_OFFSET, 0x3c)
  headers.writeUInt32LE(0x00004550, PE_OFFSET)

  const coff = PE_OFFSET + 4
  headers.writeUInt16LE(1, coff + 2) // one section
  headers.writeUInt16LE(OPTIONAL_SIZE, coff + 16)

  const optional = coff + 20
  headers.writeUInt16LE(0x20b, optional) // PE32+
  const dataDirs = optional + 112
  headers.writeUInt32LE(SECTION_RVA, dataDirs + 16) // resource table RVA
  headers.writeUInt32LE(rsrc.length, dataDirs + 20)

  const section = optional + OPTIONAL_SIZE
  headers.write('.rsrc\0\0\0', section, 'ascii')
  headers.writeUInt32LE(rsrc.length, section + 8) // virtual size
  headers.writeUInt32LE(SECTION_RVA, section + 12) // virtual address
  headers.writeUInt32LE(rsrc.length, section + 16) // raw size
  headers.writeUInt32LE(headers.length, section + 20) // raw pointer

  return Buffer.concat([headers, rsrc])
}

// ---------------------------------------------------------------------------

describe('readIcoEntries', () => {
  test('reads every image out of the real assets/icon.ico', () => {
    const entries = readIcoEntries(fs.readFileSync(ICON_ICO))

    // The shipped icon must carry the sizes Windows actually asks for: 16 for
    // the title bar, 32 for the taskbar, 48 for the desktop, 256 for large
    // Explorer views. A .ico missing 256 renders blurry on a shortcut.
    const sizes = entries.map(e => e.width)
    for (const required of [16, 32, 48, 256]) {
      assert.ok(sizes.includes(required), `assets/icon.ico is missing the ${required}px image`)
    }

    assert.ok(entries.every(e => e.width === e.height))
    assert.ok(entries.every(e => e.sha256.length === 64))
  })

  test('rejects a file that is not an .ico', () => {
    assert.throws(() => readIcoEntries(Buffer.from('not an icon at all')), /not an \.ico file/)
  })
})

describe('parseVersionStrings', () => {
  test('reads the StringFileInfo pairs back out', () => {
    const blob = versionInfoBlob({
      ProductName: 'AgentX Workmate',
      CompanyName: 'AstralX Technology',
      FileDescription: 'AgentX Workmate'
    })

    assert.deepEqual(parseVersionStrings(blob), {
      ProductName: 'AgentX Workmate',
      CompanyName: 'AstralX Technology',
      FileDescription: 'AgentX Workmate'
    })
  })

  test('an empty blob yields no strings rather than throwing', () => {
    assert.deepEqual(parseVersionStrings(Buffer.alloc(0)), {})
  })
})

describe('readPeIdentity', () => {
  test('reads icons and version strings out of a resource-carrying PE', () => {
    const icons = [pngIcon(16, 0x11), pngIcon(256, 0x22)]
    const pe = buildPe({ icons, versionStrings: { ProductName: 'AgentX Workmate' } })
    const identity = readPeIdentity(pe)

    assert.deepEqual(
      identity.icons.map(i => `${i.width}x${i.height}`),
      ['16x16', '256x256']
    )
    assert.deepEqual(
      identity.icons.map(i => i.sha256),
      icons.map(sha256)
    )
    assert.equal(identity.versionStrings.ProductName, 'AgentX Workmate')
  })

  test('rejects a buffer that is not a PE', () => {
    assert.throws(() => readPeIdentity(Buffer.from('#!/bin/sh\n')), /not a PE executable/)
  })

  test('rejects a PE with no resource directory', () => {
    const pe = buildPe({ icons: [pngIcon(16, 1)] })
    const stripped = Buffer.from(pe)
    // Zero the resource-table RVA in the data directory.
    stripped.writeUInt32LE(0, 0x40 + 4 + 20 + 112 + 16)

    assert.throws(() => readPeIdentity(stripped), /no resource directory/)
  })
})

describe('checkWindowsExeIdentity', () => {
  const icoEntries = readIcoEntries(
    buildIco([
      { size: 16, blob: pngIcon(16, 0xa1) },
      { size: 256, blob: pngIcon(256, 0xa2) }
    ])
  )

  const brandedIdentity = {
    icons: icoEntries.map(e => ({ width: e.width, height: e.height, sha256: e.sha256 })),
    versionStrings: { ProductName: 'AgentX Workmate', CompanyName: 'AstralX Technology' }
  }

  test('a fully branded exe passes', () => {
    const result = checkWindowsExeIdentity({
      identity: brandedIdentity,
      icoEntries,
      expect: { ProductName: 'AgentX Workmate', CompanyName: 'AstralX Technology' }
    })

    assert.deepEqual(result, { ok: true })
  })

  test('an un-stamped exe is caught by its leftover Electron strings', () => {
    // The exact shape of the bug: the app exe electron-builder never edited.
    const result = checkWindowsExeIdentity({
      identity: {
        icons: brandedIdentity.icons,
        versionStrings: { ProductName: 'Electron', CompanyName: 'GitHub, Inc.' }
      },
      icoEntries
    })

    assert.equal(result.ok, false)
    assert.ok(result.problems.some(p => /ProductName still says "Electron"/.test(p)))
    assert.ok(result.problems.some(p => /CompanyName still says "GitHub, Inc\."/.test(p)))
  })

  test('the stock Electron icon is rejected even though it has plausible sizes', () => {
    // The regression that shipped: Electron's own icon carries 16/32/48/256,
    // so anything that compared counts or dimensions would have passed it.
    const stockIcon = [16, 32, 48, 256].map(size => ({
      width: size,
      height: size,
      sha256: sha256(pngIcon(size, 0xee))
    }))

    const result = checkWindowsExeIdentity({
      identity: { icons: stockIcon, versionStrings: { ProductName: 'AgentX Workmate' } },
      icoEntries
    })

    assert.equal(result.ok, false)
    assert.ok(result.problems.some(p => /icon does not match assets\/icon\.ico/.test(p)))
  })

  test('a stale icon group left alongside ours is reported', () => {
    const result = checkWindowsExeIdentity({
      identity: {
        icons: [...brandedIdentity.icons, { width: 48, height: 48, sha256: sha256(pngIcon(48, 0xff)) }],
        versionStrings: {}
      },
      icoEntries
    })

    assert.equal(result.ok, false)
    assert.ok(result.problems.some(p => /not in assets\/icon\.ico/.test(p)))
  })

  test('a wrong-but-not-Electron product name is reported against what was expected', () => {
    const result = checkWindowsExeIdentity({
      identity: { icons: brandedIdentity.icons, versionStrings: { ProductName: 'AgentX' } },
      icoEntries,
      expect: { ProductName: 'AgentX Workmate' }
    })

    assert.equal(result.ok, false)
    assert.ok(result.problems.some(p => p.includes('expected "AgentX Workmate"')))
  })
})

describe('the electron-builder config that decides whether branding happens', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'))

  test('build.win does not set signAndEditExecutable: false', () => {
    // This is the whole bug in one assertion. `signAndEditExecutable: false`
    // switches off code signing AND the resource editing that puts the AgentX
    // icon on the exe; `signExecutable: false` switches off only signing.
    // Both read as "do not sign", so the wrong one is easy to reach for.
    assert.notEqual(
      pkg.build.win.signAndEditExecutable,
      false,
      'signAndEditExecutable: false also disables icon/version stamping — use signExecutable: false'
    )
  })

  test('signing stays off, so no build ever reaches signtool/winCodeSign', () => {
    assert.equal(pkg.build.win.signExecutable, false)
  })

  test('the app icon the stamping reads is configured and present on disk', () => {
    assert.equal(pkg.build.icon, 'assets/icon')
    assert.ok(fs.existsSync(ICON_ICO), 'assets/icon.ico must exist for the Windows build')
  })

  test('the default Windows targets are ones a macOS build host can actually produce', () => {
    // `msi` drives the WiX toolset, a Windows binary that electron-builder runs
    // under Wine on a non-Windows host — where it dies before it starts. With
    // msi in this list, `npm run dist:win` failed on the machine releases are
    // cut from, after the NSIS installer had already been built and written.
    // msi stays available on demand through `npm run dist:win:msi`.
    assert.deepEqual(pkg.build.win.target, ['nsis'])
    assert.equal(pkg.scripts['dist:win:msi'], 'npm run build && npm run builder -- --win msi')
  })
})
