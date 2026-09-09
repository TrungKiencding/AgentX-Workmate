import assert from 'node:assert/strict'
import path from 'node:path'

import { describe, test } from 'vitest'

import { webmatePaths } from './paths'
import { defaultPrefs, isSnoozed, parsePrefs, prefsFile, type PrefsIo, readPrefs, writePrefs } from './prefs'

function memoryIo(initial: Record<string, string> = {}): PrefsIo & { files: Map<string, string>; writes: number } {
  const files = new Map(Object.entries(initial))

  const io = {
    files,
    writes: 0,
    readText: (p: string) => files.get(p) ?? null,
    writeTextAtomic: (p: string, text: string) => {
      files.set(p, text)
      io.writes += 1
    },
    now: () => new Date('2026-09-09T10:00:00.000Z')
  }

  return io
}

const paths = webmatePaths('/home/k/.agentx', path.posix)
const FILE = prefsFile(paths, path.posix)

describe('prefs', () => {
  test('prefs.json sits in the webmate root', () => {
    assert.equal(FILE, '/home/k/.agentx/webmate/prefs.json')
  })

  test('parsePrefs falls back to defaults for every broken shape and keeps known fields', () => {
    const now = new Date('2026-09-09T10:00:00.000Z')

    for (const bad of [null, '', '{', '[]', '42']) {
      assert.deepEqual(parsePrefs(bad, now), defaultPrefs(now), JSON.stringify(bad))
    }

    const parsed = parsePrefs(
      JSON.stringify({
        schema: 1,
        prompt: 'never',
        autoUpdate: false,
        askWhenNotReady: 'yes',
        mode: 'window',
        browser: { id: 'chrome', name: 'Google Chrome', profileDir: 'Default', profileName: 'Kiên' },
        connectedAt: 'not a date',
        cardSnoozedUntil: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-08T00:00:00.000Z'
      }),
      now
    )

    assert.equal(parsed.prompt, 'never')
    assert.equal(parsed.autoUpdate, false)
    // A non-boolean keeps the default rather than becoming truthy garbage.
    assert.equal(parsed.askWhenNotReady, true)
    assert.equal(parsed.mode, 'window')
    assert.deepEqual(parsed.browser, {
      id: 'chrome',
      name: 'Google Chrome',
      profileDir: 'Default',
      profileName: 'Kiên'
    })
    assert.equal(parsed.connectedAt, null)
    assert.equal(parsed.cardSnoozedUntil, '2026-09-10T00:00:00.000Z')
    assert.equal(parsed.updatedAt, '2026-09-08T00:00:00.000Z')
  })

  test('writePrefs creates the file, merges patches, and skips identical writes', () => {
    const io = memoryIo()

    const first = writePrefs(FILE, { prompt: 'later' }, io)

    assert.equal(first.prompt, 'later')
    assert.equal(io.writes, 1)
    assert.equal(readPrefs(FILE, io).prompt, 'later')

    // Same content again → no write.
    writePrefs(FILE, { prompt: 'later' }, io)
    assert.equal(io.writes, 1)

    // Another field merges without touching the first.
    const second = writePrefs(
      FILE,
      { autoUpdate: false, browser: { id: 'edge', name: 'Microsoft Edge', profileDir: null, profileName: null } },
      io
    )

    assert.equal(second.prompt, 'later')
    assert.equal(second.autoUpdate, false)
    assert.equal(second.browser?.id, 'edge')
    assert.equal(io.writes, 2)

    // undefined in a patch means "leave alone".
    const third = writePrefs(FILE, { prompt: undefined, mode: 'browser' }, io)

    assert.equal(third.prompt, 'later')
    assert.equal(third.mode, 'browser')
  })

  test('a missing file is written even when the patch equals the defaults', () => {
    const io = memoryIo()

    writePrefs(FILE, {}, io)
    assert.equal(io.writes, 1)
    assert.ok(io.files.get(FILE)?.endsWith('\n'))
  })

  test('isSnoozed compares against now', () => {
    const now = new Date('2026-09-09T10:00:00.000Z')

    assert.equal(isSnoozed(null, now), false)
    assert.equal(isSnoozed('2026-09-09T09:59:59.000Z', now), false)
    assert.equal(isSnoozed('2026-09-09T10:00:01.000Z', now), true)
  })
})
