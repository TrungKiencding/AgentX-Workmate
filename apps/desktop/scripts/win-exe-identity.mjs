/**
 * win-exe-identity.mjs — read the icon + version resources out of a packed
 * Windows executable and check they are AgentX's, not Electron's.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Windows Electron app gets its taskbar icon, its Alt-Tab icon, the icon a
 * shortcut draws, and the name Task Manager shows from PE resources compiled
 * into `AgentX Workmate.exe`. electron-builder writes them during packing —
 * unless the build turns that step off, in which case the app ships wearing
 * the stock Electron atom and calling itself "Electron" by "GitHub, Inc.".
 *
 * That is exactly what happened: `build.win.signAndEditExecutable: false` was
 * set to keep electron-builder away from signtool/winCodeSign (whose macOS
 * symlinks crash 7-Zip on non-admin Windows), but that flag disables resource
 * editing TOO. A hand-rolled `rcedit` afterPack hook was meant to compensate;
 * rcedit drives a Windows .exe, so on a macOS/Linux build host it needs Wine
 * and simply fails — and the hook swallowed the failure so the build stayed
 * green. Every Windows artifact cut from a Mac shipped unbranded.
 *
 * The flag is now `signExecutable: false`, which disables ONLY signing;
 * electron-builder edits the resources itself with the pure-JS `resedit`, on
 * every host OS. This module exists so that promise is CHECKED rather than
 * trusted: after-pack.mjs runs it and fails the build when the exe is not
 * branded. A cosmetic-looking defect that reaches users as "why is my app an
 * atom" is not one to discover from a screenshot again.
 *
 * Everything here is pure (Buffers in, plain objects out) so it unit-tests
 * without a packed app — see win-exe-identity.test.mjs.
 */

import { createHash } from 'node:crypto'

/** Resource types we read. Values are from winnt.h. */
const RT_ICON = 3
const RT_VERSION = 16

/** Names in the stock Electron binary. Seeing one means nothing was stamped. */
const STOCK_ELECTRON_STRINGS = new Set(['Electron', 'GitHub, Inc.', 'electron.exe'])

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Dimensions of one icon image, whether it is stored as PNG (Vista+ 256px
 * entries) or as the older BMP-ish DIB. A DIB's header height counts the
 * colour bitmap AND the AND-mask, so it reads double — hence the halving.
 */
function iconDimensions(blob) {
  if (blob.length >= 24 && blob.readUInt32BE(0) === 0x89504e47) {
    return { width: blob.readUInt32BE(16), height: blob.readUInt32BE(20) }
  }

  if (blob.length >= 12) {
    return { width: blob.readInt32LE(4), height: Math.floor(blob.readInt32LE(8) / 2) }
  }

  return { width: 0, height: 0 }
}

/**
 * The icon images inside a .ico file, in file order.
 *
 * electron-builder hands `resedit` these exact byte ranges and they land in
 * the exe unchanged, so comparing hashes is an exact "is this our icon"
 * answer rather than a resemblance.
 */
export function readIcoEntries(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error('not an .ico file')
  }

  const count = buffer.readUInt16LE(4)
  const entries = []

  for (let i = 0; i < count; i++) {
    const dir = 6 + i * 16
    const size = buffer.readUInt32LE(dir + 8)
    const offset = buffer.readUInt32LE(dir + 12)
    const blob = buffer.subarray(offset, offset + size)

    entries.push({ ...iconDimensions(blob), bytes: size, sha256: sha256(blob) })
  }

  return entries
}

/** Locate the PE header and the resource directory, or throw. */
function peResourceSection(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('not a PE executable (no MZ header)')
  }

  const peOffset = buffer.readUInt32LE(0x3c)

  if (buffer.length < peOffset + 24 || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('not a PE executable (no PE signature)')
  }

  const coff = peOffset + 4
  const sectionCount = buffer.readUInt16LE(coff + 2)
  const optionalHeaderSize = buffer.readUInt16LE(coff + 16)
  const optional = coff + 20
  // 0x20b = PE32+; its data directories start 16 bytes later than PE32's.
  const dataDirectories = optional + (buffer.readUInt16LE(optional) === 0x20b ? 112 : 96)
  // Entry 2 of the data directory is the resource table.
  const resourceRva = buffer.readUInt32LE(dataDirectories + 16)

  if (!resourceRva) {
    throw new Error('executable carries no resource directory')
  }

  const sections = optional + optionalHeaderSize

  const rvaToOffset = rva => {
    for (let i = 0; i < sectionCount; i++) {
      const header = sections + i * 40
      const virtualSize = buffer.readUInt32LE(header + 8)
      const virtualAddress = buffer.readUInt32LE(header + 12)
      const rawSize = buffer.readUInt32LE(header + 16)
      const rawPointer = buffer.readUInt32LE(header + 20)

      if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
        return rawPointer + (rva - virtualAddress)
      }
    }

    return null
  }

  const root = rvaToOffset(resourceRva)

  if (root == null) {
    throw new Error('resource directory RVA falls outside every section')
  }

  return { root, rvaToOffset }
}

/** The (id, offset) pairs of one resource directory node. */
function directoryEntries(buffer, offset) {
  const named = buffer.readUInt16LE(offset + 12)
  const ids = buffer.readUInt16LE(offset + 14)
  const out = []

  for (let i = 0; i < named + ids; i++) {
    const entry = offset + 16 + i * 8

    out.push({ id: buffer.readUInt32LE(entry), offset: buffer.readUInt32LE(entry + 4) })
  }

  return out
}

/** Walk type → name → language and collect every leaf blob for one type. */
function leavesForType(buffer, root, rvaToOffset, type) {
  const typeNode = directoryEntries(buffer, root).find(e => e.id === type)

  if (!typeNode) {
    return []
  }

  const blobs = []

  for (const nameNode of directoryEntries(buffer, root + (typeNode.offset & 0x7fffffff))) {
    for (const langNode of directoryEntries(buffer, root + (nameNode.offset & 0x7fffffff))) {
      // A language node is a leaf: its offset points at a data ENTRY (an RVA
      // + size pair), not at another directory.
      const dataEntry = root + langNode.offset
      const dataOffset = rvaToOffset(buffer.readUInt32LE(dataEntry))
      const dataSize = buffer.readUInt32LE(dataEntry + 4)

      if (dataOffset != null) {
        blobs.push(buffer.subarray(dataOffset, dataOffset + dataSize))
      }
    }
  }

  return blobs
}

/**
 * One node of a VS_VERSIONINFO tree.
 *
 * Every node is `wLength, wValueLength, wType, szKey (NUL-terminated UTF-16)`,
 * then the value, then the children — with each of those three parts padded
 * to a 4-byte boundary. `wValueLength` counts BYTES for a binary node and
 * UTF-16 CHARACTERS for a text one, which is the detail a naive reader gets
 * wrong and the reason this is spelled out rather than pattern-matched.
 */
function readVersionNode(buffer, offset) {
  const length = buffer.readUInt16LE(offset)
  const valueLength = buffer.readUInt16LE(offset + 2)
  const type = buffer.readUInt16LE(offset + 4)

  let cursor = offset + 6
  const keyStart = cursor

  while (cursor + 1 < buffer.length && buffer.readUInt16LE(cursor) !== 0) {
    cursor += 2
  }

  const key = buffer.toString('utf16le', keyStart, cursor)

  cursor += 2 // the key's NUL terminator
  cursor = offset + align4(cursor - offset)

  const valueBytes = type === 1 ? valueLength * 2 : valueLength
  const value =
    type === 1 && valueBytes > 0
      ? buffer.toString('utf16le', cursor, cursor + valueBytes).replace(/\0+$/, '')
      : ''

  const childrenStart = offset + align4(cursor + valueBytes - offset)

  return { key, value, length, end: offset + length, childrenStart }
}

function align4(n) {
  return (n + 3) & ~3
}

/** Iterate a node's children, stopping at its declared end. */
function* versionChildren(buffer, node) {
  let cursor = node.childrenStart

  while (cursor + 6 <= node.end && cursor + 6 <= buffer.length) {
    const child = readVersionNode(buffer, cursor)

    if (child.length < 6) {
      return // a zero-length node would loop forever
    }

    yield child
    cursor = align4(child.end)
  }
}

/**
 * The StringFileInfo pairs of a VS_VERSIONINFO blob: `{ProductName: '…'}`.
 *
 * Only the string table is read. The fixed-info struct (file/product version
 * as packed integers) is not what identifies an app to a person, and the
 * strings are what Explorer, Task Manager, and the properties dialog show.
 */
export function parseVersionStrings(blob) {
  if (blob.length < 6) {
    return {}
  }

  const root = readVersionNode(blob, 0)
  const strings = {}

  for (const child of versionChildren(blob, root)) {
    if (child.key !== 'StringFileInfo') {
      continue
    }

    // StringFileInfo → one StringTable per language → one node per string.
    for (const table of versionChildren(blob, child)) {
      for (const entry of versionChildren(blob, table)) {
        strings[entry.key] = entry.value
      }
    }
  }

  return strings
}

/**
 * The identity a packed Windows executable advertises: its icon images and
 * its version strings. Throws when `buffer` is not a resource-carrying PE.
 */
export function readPeIdentity(buffer) {
  const { root, rvaToOffset } = peResourceSection(buffer)

  const icons = leavesForType(buffer, root, rvaToOffset, RT_ICON).map(blob => ({
    ...iconDimensions(blob),
    bytes: blob.length,
    sha256: sha256(blob)
  }))

  const versionBlobs = leavesForType(buffer, root, rvaToOffset, RT_VERSION)

  return { icons, versionStrings: versionBlobs.length ? parseVersionStrings(versionBlobs[0]) : {} }
}

/**
 * Check a packed exe's identity against the icon and names it should carry.
 *
 * Returns `{ ok: true }` or `{ ok: false, problems: [...] }` — a list rather
 * than a first-failure, so one build log says everything that is wrong.
 *
 * The icon check is set equality on content hashes, not a count or a size
 * comparison: the stock Electron icon happens to carry 16/32/48/256 too, so
 * anything looser would have called the broken build correct.
 */
export function checkWindowsExeIdentity({ identity, icoEntries, expect = {} }) {
  const problems = []
  const strings = identity.versionStrings || {}

  for (const [field, wanted] of Object.entries(expect)) {
    const actual = strings[field] || ''

    if (actual !== wanted) {
      problems.push(`${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`)
    }
  }

  for (const [field, actual] of Object.entries(strings)) {
    if (STOCK_ELECTRON_STRINGS.has(actual)) {
      problems.push(`${field} still says ${JSON.stringify(actual)} — the exe was never re-stamped`)
    }
  }

  if (icoEntries) {
    const wanted = new Set(icoEntries.map(entry => entry.sha256))
    const found = new Set((identity.icons || []).map(icon => icon.sha256))
    const missing = icoEntries.filter(entry => !found.has(entry.sha256))

    if (missing.length > 0) {
      problems.push(
        `icon does not match assets/icon.ico — ${missing.length}/${icoEntries.length} images ` +
          `absent (missing ${missing.map(m => `${m.width}x${m.height}`).join(', ')}; ` +
          `exe carries ${found.size} image(s))`
      )
    }

    const extra = (identity.icons || []).filter(icon => !wanted.has(icon.sha256))

    if (extra.length > 0) {
      problems.push(
        `exe carries ${extra.length} icon image(s) that are not in assets/icon.ico ` +
          `(${extra.map(e => `${e.width}x${e.height}`).join(', ')}) — a stale icon group was left behind`
      )
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true }
}

export { STOCK_ELECTRON_STRINGS }
