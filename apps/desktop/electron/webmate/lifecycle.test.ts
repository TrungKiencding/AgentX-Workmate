import { describe, expect, it, vi } from 'vitest'

import { browsersConfirmed, drainBrowsers, reloadBrowsers } from './lifecycle'
import type { WebmateConnection, WebmateLocalStatus } from './status'

const connection = (instanceId: string, patch: Partial<WebmateConnection> = {}): WebmateConnection => ({
  instanceId,
  browser: 'Chrome',
  extensionVersion: '1.0.4',
  installType: 'workmate',
  signedIn: true,
  protocolVersion: 3,
  lastHelloAt: 'before',
  paired: true,
  active: instanceId === 'idle',
  ...patch
})

const status = (connections: WebmateConnection[]) =>
  ({
    connected: connections.length > 0,
    connections,
    extensionVersion: connections.at(-1)?.extensionVersion
  }) as WebmateLocalStatus

const receipt = (ok = true) => ({
  id: 'cmd',
  action: 'prepare_update',
  ok,
  error: null,
  startedAt: '',
  finishedAt: '',
  results: ['busy', 'idle'].map(instanceId => ({ instanceId, browser: null, ok, outcome: '', signedIn: false }))
})

describe('managed browser lifecycle', () => {
  it('requires each participant to drain, even when the active browser is idle', async () => {
    const before = status([connection('busy'), connection('idle'), connection('dev', { installType: 'dev' })])
    const sendCommand = vi.fn(() => 'cmd')

    const deps = {
      readStatus: () => before,
      sendCommand,
      waitForCommand: async () => ({ ...receipt(false), busy: 2, error: 'busy' })
    }

    await expect(drainBrowsers(deps, before)).rejects.toThrow('busy')
    expect(sendCommand).toHaveBeenCalledWith('prepare_update', { instanceIds: ['busy', 'idle'] })
    await expect(
      drainBrowsers({ ...deps, waitForCommand: async () => ({ ...receipt(), results: undefined }) }, before)
    ).rejects.toThrow('every browser')
  })

  it('accepts timeout only when a fresh read proves the browser closed', async () => {
    const before = status([connection('busy')])
    const deps = { readStatus: () => before, sendCommand: () => 'cmd', waitForCommand: async () => null }
    await expect(drainBrowsers(deps, before)).rejects.toThrow('acknowledged')
    await expect(drainBrowsers({ ...deps, readStatus: () => status([]) }, before)).resolves.toBeUndefined()
  })

  it('rejects a new participant arriving during a drain', async () => {
    const before = status([connection('idle')])
    await expect(
      drainBrowsers(
        {
          readStatus: () => status([connection('idle'), connection('new')]),
          sendCommand: () => 'cmd',
          waitForCommand: async () => receipt()
        },
        before
      )
    ).rejects.toThrow('another browser')
  })

  it('an active browser with the new version cannot confirm the other old version', () => {
    const before = status([connection('busy'), connection('idle')])
    expect(
      browsersConfirmed(
        before,
        status([connection('busy'), connection('idle', { extensionVersion: '1.0.5' })]),
        '1.0.5'
      )
    ).toBe(false)
    expect(
      browsersConfirmed(
        before,
        status([connection('busy', { extensionVersion: '1.0.5' }), connection('idle', { extensionVersion: '1.0.5' })]),
        '1.0.5'
      )
    ).toBe(true)
    expect(browsersConfirmed(before, before, '1.0.4', true)).toBe(false)
    expect(
      browsersConfirmed(
        before,
        status([connection('busy', { lastHelloAt: 'after' }), connection('idle', { lastHelloAt: 'after' })]),
        '1.0.4',
        true
      )
    ).toBe(true)
  })

  it('developer copies neither confirm nor receive managed reloads', async () => {
    const sendCommand = vi.fn(() => 'cmd')
    await reloadBrowsers({
      readStatus: () => status([connection('dev', { installType: 'dev' })]),
      sendCommand,
      waitForCommand: async () => receipt()
    })
    expect(sendCommand).not.toHaveBeenCalled()
  })
})
