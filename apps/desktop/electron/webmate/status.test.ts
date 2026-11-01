import assert from 'node:assert/strict'
import path from 'node:path'

import { describe, test } from 'vitest'

import { webmatePaths } from './paths'
import {
  parseBridgeState,
  parseUpdateCheckSummary,
  readWebmateStatus,
  type StatusIo,
  statusSignature,
  WebmateStatusWatcher
} from './status'

const paths = webmatePaths('/home/k/.agentx', path.posix)

function fakeIo(files: Record<string, string>, alivePids: number[] = []): StatusIo & { files: Map<string, string> } {
  const map = new Map(Object.entries(files))

  return {
    files: map,
    readText: p => map.get(p) ?? null,
    exists: p => map.has(p),
    pidAlive: pid => alivePids.includes(pid),
    now: () => new Date('2026-09-09T10:00:00.000Z'),
    pathModule: path.posix
  }
}

const STATE_CONNECTED = JSON.stringify({
  schema: 1,
  pid: 4242,
  port: 17374,
  serverVersion: '1.1.0',
  listening: true,
  connected: true,
  pairingRequired: true,
  browser: 'Chrome 152',
  extensionVersion: '1.0.4',
  installType: 'workmate',
  signedIn: true,
  protocolVersion: 3,
  lastHelloAt: '2026-09-09T09:59:00.000Z',
  error: null,
  lastCommand: { id: 'c1', action: 'reload', ok: true, startedAt: 's', finishedAt: 'f' },
  updatedAt: '2026-09-09T09:59:00.000Z'
})

describe('parseBridgeState', () => {
  test('types every field and tolerates junk', () => {
    const state = parseBridgeState(STATE_CONNECTED)

    assert.equal(state?.connected, true)
    assert.equal(state?.browser, 'Chrome 152')
    assert.equal(state?.installType, 'workmate')
    assert.equal(state?.lastCommand?.id, 'c1')
    assert.equal(state?.instanceId, null, 'a 1.1.0 server names no instance')
    assert.deepEqual(state?.connections, [], 'and lists no connections')
    assert.equal(parseBridgeState(null), null)
    assert.equal(parseBridgeState('nope'), null)
    assert.equal(parseBridgeState(JSON.stringify({ installType: 'store', browser: 7 }))?.installType, null)
  })

  test('reads the attached browsers a 1.2.0 server lists, skipping entries without an instance id', () => {
    const state = parseBridgeState(
      JSON.stringify({
        schema: 1,
        listening: true,
        connected: true,
        instanceId: 'inst-b',
        connections: [
          {
            instanceId: 'inst-a',
            browser: 'Chrome 152',
            extensionVersion: '1.0.5',
            installType: 'workmate',
            signedIn: false,
            protocolVersion: 3,
            lastHelloAt: 't',
            paired: true,
            active: false
          },
          { instanceId: 'inst-b', browser: 'Chrome 152', signedIn: true, active: true, installType: 'workmate' },
          { browser: 'nameless' },
          null
        ]
      })
    )

    assert.equal(state?.instanceId, 'inst-b')
    assert.deepEqual(
      state?.connections.map(c => [c.instanceId, c.signedIn, c.active, c.paired, c.extensionVersion]),
      [
        ['inst-a', false, false, true, '1.0.5'],
        ['inst-b', true, true, false, null]
      ]
    )
  })
})

describe('readWebmateStatus', () => {
  test('a live, connected server is reported with its browser and version', () => {
    const io = fakeIo(
      {
        [paths.stateFile]: STATE_CONNECTED,
        [paths.pairingFile]: JSON.stringify({ schema: 1, token: 't'.repeat(44) }),
        [`${paths.installDir}/manifest.json`]: JSON.stringify({ version: '1.0.4' })
      },
      [4242]
    )

    const status = readWebmateStatus(paths, io)

    assert.equal(status.installedVersion, '1.0.4')
    assert.equal(status.pairingPresent, true)
    assert.equal(status.stale, false)
    assert.equal(status.serverRunning, true)
    assert.deepEqual(status.connections, [])
    assert.equal(status.instanceId, null)
    assert.equal(status.connected, true)
    assert.equal(status.browser, 'Chrome 152')
    assert.equal(status.extensionVersion, '1.0.4')
    assert.equal(status.signedIn, true)
    assert.equal(status.protocolVersion, 3)
    assert.equal(status.lastCommand?.id, 'c1')
    assert.equal(status.prefs.prompt, null)
    assert.equal(status.update, null)
  })

  test('a force-quit server (listening with a dead pid) is stale, so nothing is "connected"', () => {
    const io = fakeIo({ [paths.stateFile]: STATE_CONNECTED }, [])
    const status = readWebmateStatus(paths, io)

    assert.equal(status.stale, true)
    assert.equal(status.serverRunning, false)
    assert.equal(status.connected, false)
    assert.equal(status.browser, null)
    assert.equal(status.error, null)
    assert.equal(status.installedVersion, null)
    assert.equal(status.pairingPresent, false)
  })

  test('relays prefs and the update cache', () => {
    const io = fakeIo({
      [`${paths.root}/prefs.json`]: JSON.stringify({ schema: 1, prompt: 'later', mode: 'browser' }),
      [paths.updateCheckFile]: JSON.stringify({
        schema: 1,
        checkedAt: '2026-09-09T09:00:00.000Z',
        ok: true,
        available: true,
        feed: { version: '1.0.5', minProtocol: 3, notes: { vi: 'Mới', en: 'New', bad: 1 } },
        pendingVersion: null,
        failedVersions: ['1.0.2']
      })
    })

    const status = readWebmateStatus(paths, io)

    assert.equal(status.prefs.prompt, 'later')
    assert.equal(status.prefs.mode, 'browser')
    assert.equal(status.update?.feedVersion, '1.0.5')
    assert.equal(status.update?.available, true)
    assert.deepEqual(status.update?.notes, { vi: 'Mới', en: 'New' })
    assert.deepEqual(status.update?.failedVersions, ['1.0.2'])
    assert.equal(parseUpdateCheckSummary('x'), null)
  })
})

describe('WebmateStatusWatcher', () => {
  test('reports the first read, then only distinct changes, from watch events and polls alike', () => {
    const io = fakeIo({}, [4242])
    const reports: string[] = []
    let watchListener: (() => void) | null = null
    let pollTick: (() => void) | null = null

    const watcher = new WebmateStatusWatcher({
      paths,
      io,
      onChange: status => void reports.push(`${status.serverRunning}/${status.connected}/${status.browser}`),
      watch: (_dir, listener) => {
        watchListener = listener

        return { close: () => void (watchListener = null) }
      },
      setInterval: ((fn: () => void) => {
        pollTick = fn

        return 1 as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearInterval: (() => void (pollTick = null)) as unknown as typeof clearInterval
    })

    watcher.start()
    assert.deepEqual(reports, ['false/false/null'])

    // A poll with nothing new says nothing.
    pollTick!()
    assert.equal(reports.length, 1)

    // The server writes state.json → the directory watcher fires.
    io.files.set(paths.stateFile, STATE_CONNECTED)
    watchListener!()
    assert.deepEqual(reports.at(-1), 'true/true/Chrome 152')
    assert.equal(reports.length, 2)

    // Same content again (a rename that changed nothing) → still quiet.
    watchListener!()
    pollTick!()
    assert.equal(reports.length, 2)

    assert.equal(watcher.current().connected, true)
    assert.equal(statusSignature(watcher.current()), statusSignature(watcher.refresh()))

    watcher.stop()
    assert.equal(watchListener, null)
    assert.equal(pollTick, null)
  })
})
