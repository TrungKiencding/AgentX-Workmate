import { JsonRpcError, JsonRpcGatewayClient } from '@agentx/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeSocket {
  static readonly OPEN = 1

  readonly sent: string[] = []
  readyState = FakeSocket.OPEN
  private listeners = new Map<string, ((event: any) => void)[]>()

  addEventListener(type: string, callback: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback])
  }

  close(): void {}

  emit(type: string, event: any = {}): void {
    for (const callback of [...(this.listeners.get(type) ?? [])]) {
      callback(event)
    }
  }

  removeEventListener(type: string, callback: (event: any) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(entry => entry !== callback)
    )
  }

  send(payload: string): void {
    this.sent.push(payload)
  }
}

async function connected() {
  vi.stubGlobal('WebSocket', { OPEN: FakeSocket.OPEN })
  const socket = new FakeSocket()
  const client = new JsonRpcGatewayClient({ socketFactory: () => socket as unknown as WebSocket })
  const opening = client.connect('ws://gateway.test/api/ws')

  socket.emit('open')
  await opening

  return { client, socket }
}

function answer(socket: FakeSocket, frame: Record<string, unknown>): void {
  const { id } = JSON.parse(socket.sent.at(-1) ?? '{}') as { id: number }

  socket.emit('message', { data: JSON.stringify({ id, jsonrpc: '2.0', ...frame }) })
}

describe('a JSON-RPC error answer', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the code and data beside the message, so a structured refusal is recognisable', async () => {
    const { client, socket } = await connected()
    const pending = client.request('llm.oneshot', {})
    const license = { access: 'read_only', state: 'expired' }

    answer(socket, {
      error: { code: 4403, data: { code: 'license_read_only', license }, message: 'Workmate is read-only.' }
    })

    const error = await pending.catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(JsonRpcError)
    expect(error).toBeInstanceOf(Error)
    expect((error as JsonRpcError).message).toBe('Workmate is read-only.')
    expect((error as JsonRpcError).code).toBe(4403)
    expect((error as JsonRpcError).data).toEqual({ code: 'license_read_only', license })
  })

  it('reads as before for an error without either', async () => {
    const { client, socket } = await connected()
    const pending = client.request('session.compress', {})

    answer(socket, { error: {} })

    const error = (await pending.catch((reason: unknown) => reason)) as JsonRpcError

    expect(error.message).toBe('AgentX RPC failed')
    expect(error.code).toBeUndefined()
    expect(error.data).toBeUndefined()
  })
})
