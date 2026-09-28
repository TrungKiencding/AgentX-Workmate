import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activeGateway,
  closeSecondaryGateways,
  configureGatewayRegistry,
  ensureGatewayForProfile,
  openGatewayForProfile,
  setPrimaryGateway
} from './gateway'

// A socket that opens AGAIN left every session bound to its previous connection
// parked on the backend, so whatever rides the window's gateway must re-attach.
// The primary's reopen paths are driven through the real boot hook in
// use-gateway-boot.test.tsx; these cover the per-profile secondaries.

type Listener = (ev: unknown) => void

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = 0
  private listeners: Record<string, Set<Listener>> = {}

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN
      this.emit('open', {})
    }, 0)
  }

  addEventListener(type: string, fn: Listener) {
    ;(this.listeners[type] ??= new Set()).add(fn)
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners[type]?.delete(fn)
  }

  close() {
    this.drop()
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  private emit(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) {
      fn(ev)
    }
  }
}

const originalWebSocket = globalThis.WebSocket
const reopened = vi.fn()

function socketOf(url: string): FakeWebSocket {
  const socket = FakeWebSocket.instances.findLast(s => s.url === url)

  if (!socket) {
    throw new Error(`no socket for ${url}`)
  }

  return socket
}

const wsUrl = (profile: string) => `ws://127.0.0.1/api/ws?profile=${profile}`

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  reopened.mockReset()
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
  ;(window as { agentxDesktop?: unknown }).agentxDesktop = {
    getConnection: vi.fn(async (profile: string) => ({ authMode: 'token', profile, wsUrl: wsUrl(profile) })),
    touchBackend: vi.fn(async () => undefined)
  }
  setPrimaryGateway(null, 'default')
  configureGatewayRegistry({ onActiveGatewayReopened: reopened, onEvent: () => undefined })
})

afterEach(async () => {
  closeSecondaryGateways()
  await ensureGatewayForProfile('default')
  vi.useRealTimers()
  ;(globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket
  delete (window as { agentxDesktop?: unknown }).agentxDesktop
})

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('a secondary socket reopening', () => {
  it('re-attaches what rides it when it is the gateway the window talks through', async () => {
    const opening = ensureGatewayForProfile('work')
    await settle()
    await opening

    expect(activeGateway()?.connectionState).toBe('open')
    expect(reopened).not.toHaveBeenCalled()

    socketOf(wsUrl('work')).drop()
    // The secondary's own backoff re-dials it.
    await settle(30_000)

    expect(activeGateway()?.connectionState).toBe('open')
    expect(reopened).toHaveBeenCalledTimes(1)
  })

  it('leaves the window alone when a background profile reconnects', async () => {
    const opening = openGatewayForProfile('background')
    await settle()
    await opening

    socketOf(wsUrl('background')).drop()
    await settle(30_000)

    expect(FakeWebSocket.instances.filter(s => s.url === wsUrl('background'))).toHaveLength(2)
    expect(reopened).not.toHaveBeenCalled()
  })
})
