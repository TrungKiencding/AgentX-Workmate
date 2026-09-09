/**
 * Chrome DevTools Protocol over `--remote-debugging-pipe`.
 *
 * Chromium started with that switch reads commands from its fd 3 and writes
 * replies and events to fd 4; every message is one JSON document followed by
 * a NUL byte. From Node's side those are `child.stdio[3]` (we write) and
 * `child.stdio[4]` (we read). No TCP port, nothing another process on the
 * machine could connect to — which is why the Workmate browser window uses it
 * (apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.6).
 *
 * The client is deliberately small: request/response by id on the browser
 * target (or a session id when given), events to listeners, a per-request
 * timeout, and a clean failure of everything pending when the pipe closes.
 */

import type { Readable, Writable } from 'node:stream'

export interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export class CdpError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number
  ) {
    super(message)
    this.name = 'CdpError'
  }
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Split a NUL-delimited byte stream into complete JSON documents. */
export class NulFramer {
  private buffer = ''

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const frames: string[] = []
    let index = this.buffer.indexOf('\0')

    while (index >= 0) {
      frames.push(this.buffer.slice(0, index))
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\0')
    }

    return frames
  }
}

export type CdpEventListener = (method: string, params: Record<string, unknown>, sessionId?: string) => void

export class CdpPipe {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly framer = new NulFramer()
  private readonly listeners = new Set<CdpEventListener>()
  private closed = false
  private closeReason: string | null = null

  constructor(
    private readonly writable: Writable,
    readable: Readable,
    private readonly options: { defaultTimeoutMs?: number; log?: (message: string) => void } = {}
  ) {
    readable.on('data', chunk => this.onData(chunk))
    readable.on('end', () => this.handleClose('pipe closed'))
    readable.on('error', error => this.handleClose(`pipe error: ${error.message}`))
    writable.on('error', error => this.handleClose(`pipe error: ${error.message}`))
  }

  get isClosed(): boolean {
    return this.closed
  }

  onEvent(listener: CdpEventListener): () => void {
    this.listeners.add(listener)

    return () => void this.listeners.delete(listener)
  }

  /** Send one command; resolves with `result`, rejects with CdpError on a protocol error or timeout. */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { sessionId?: string; timeoutMs?: number } = {}
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new CdpError(this.closeReason ?? 'pipe closed', method))
    }

    const id = this.nextId++
    const message: CdpMessage = { id, method, params }

    if (options.sessionId) {
      message.sessionId = options.sessionId
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? 15_000

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`, method))
      }, timeoutMs)

      this.pending.set(id, { method, resolve: value => resolve(value as T), reject, timer })

      try {
        this.writable.write(`${JSON.stringify(message)}\0`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CdpError(error instanceof Error ? error.message : String(error), method))
      }
    })
  }

  /** Stop listening; every pending command rejects. Does not close the browser. */
  dispose(reason = 'disposed'): void {
    this.handleClose(reason)
  }

  private onData(chunk: Buffer | string): void {
    for (const frame of this.framer.push(chunk)) {
      let message: CdpMessage

      try {
        message = JSON.parse(frame)
      } catch {
        this.options.log?.(`[cdp] dropped a non-JSON frame (${frame.length} bytes)`)

        continue
      }

      if (typeof message.id === 'number') {
        const entry = this.pending.get(message.id)

        if (!entry) {
          continue
        }

        this.pending.delete(message.id)
        clearTimeout(entry.timer)

        if (message.error) {
          entry.reject(new CdpError(message.error.message ?? 'CDP error', entry.method, message.error.code))
        } else {
          entry.resolve(message.result)
        }

        continue
      }

      if (message.method) {
        for (const listener of this.listeners) {
          try {
            listener(message.method, message.params ?? {}, message.sessionId)
          } catch (error) {
            this.options.log?.(`[cdp] event listener failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) {
      return
    }

    this.closed = true
    this.closeReason = reason

    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new CdpError(reason, entry.method))
    }

    this.pending.clear()
  }
}
