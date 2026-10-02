import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sha256Hex } from '../signed-manifest'

import { DownloadError, downloadVerified, type FetchLike, fileMatches } from './download'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-download-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const PAYLOAD = Buffer.from('the installer bytes, in three chunks')

/** A fetch whose body streams `chunks`; `failAfter` breaks the stream mid-way. */
function fakeFetch(
  chunks: Buffer[],
  { status = 200, length, failAfter }: { status?: number; length?: number; failAfter?: number } = {}
): FetchLike {
  return async (_url, init) => {
    let sent = 0

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (init.signal?.aborted) {
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))

          return
        }

        if (failAfter !== undefined && sent === failAfter) {
          controller.error(new Error('connection reset'))

          return
        }

        if (sent < chunks.length) {
          controller.enqueue(new Uint8Array(chunks[sent]))
          sent += 1
        } else {
          controller.close()
        }
      }
    })

    const headers: Record<string, string> = {}

    if (length !== undefined) {
      headers['content-length'] = String(length)
    }

    return new Response(body, { status, headers })
  }
}

function threeChunks() {
  return [PAYLOAD.subarray(0, 10), PAYLOAD.subarray(10, 20), PAYLOAD.subarray(20)]
}

function request(overrides: Partial<Parameters<typeof downloadVerified>[0]> = {}) {
  return {
    url: 'https://example.test/AgentXWorkmate-win-x64.exe',
    sha256: sha256Hex(PAYLOAD),
    bytes: PAYLOAD.length,
    destination: path.join(dir, '1.0.4', 'AgentXWorkmate-win-x64.exe'),
    progressIntervalMs: 0,
    ...overrides
  }
}

async function failure(promise: Promise<unknown>): Promise<DownloadError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(DownloadError)

    return error as DownloadError
  }

  throw new Error('expected the download to fail')
}

describe('downloadVerified', () => {
  it('streams to a partial file and gives it its name only once size and hash match', async () => {
    const progress: number[] = []
    const req = request({ onProgress: received => progress.push(received) })

    await downloadVerified(req, fakeFetch(threeChunks(), { length: PAYLOAD.length }))

    expect(fs.readFileSync(req.destination)).toEqual(PAYLOAD)
    expect(fs.existsSync(`${req.destination}.partial`)).toBe(false)
    expect(progress.at(-1)).toBe(PAYLOAD.length)
    expect(progress.length).toBeGreaterThanOrEqual(3)
  })

  it('refuses a body whose announced length differs from the release', async () => {
    const req = request()
    const error = await failure(downloadVerified(req, fakeFetch(threeChunks(), { length: PAYLOAD.length + 1 })))

    expect(error.kind).toBe('size')
    expect(fs.existsSync(req.destination)).toBe(false)
  })

  it('stops a body that runs past the release size', async () => {
    const req = request({ bytes: 15, sha256: sha256Hex(PAYLOAD.subarray(0, 15)) })
    const error = await failure(downloadVerified(req, fakeFetch(threeChunks())))

    expect(error.kind).toBe('size')
    expect(fs.existsSync(`${req.destination}.partial`)).toBe(false)
  })

  it('rejects a truncated body and a body with other bytes', async () => {
    const short = await failure(downloadVerified(request(), fakeFetch(threeChunks().slice(0, 2))))
    const other = Buffer.from(PAYLOAD).fill(0x41, 0, 5)
    const tampered = await failure(downloadVerified(request(), fakeFetch([other])))

    expect(short.kind).toBe('size')
    expect(tampered.kind).toBe('hash')
    expect(fs.readdirSync(path.join(dir, '1.0.4'))).toEqual([])
  })

  it('reports HTTP errors, unreachable hosts and dropped connections', async () => {
    const http = await failure(downloadVerified(request(), fakeFetch(threeChunks(), { status: 404 })))

    const unreachable = await failure(
      downloadVerified(request(), async () => {
        throw new TypeError('fetch failed')
      })
    )

    const dropped = await failure(downloadVerified(request(), fakeFetch(threeChunks(), { failAfter: 1 })))

    expect(http.kind).toBe('http')
    expect(http.message).toMatch(/404/)
    expect(unreachable.kind).toBe('network')
    expect(dropped.kind).toBe('network')
    expect(fs.existsSync(`${request().destination}.partial`)).toBe(false)
  })

  it('is cancelled by its signal and cleans up after itself', async () => {
    const controller = new AbortController()

    const req = request({
      signal: controller.signal,
      onProgress: received => {
        if (received >= 10) {
          controller.abort()
        }
      }
    })

    const error = await failure(downloadVerified(req, fakeFetch(threeChunks())))

    expect(error.kind).toBe('aborted')
    expect(fs.existsSync(`${req.destination}.partial`)).toBe(false)
    expect(fs.existsSync(req.destination)).toBe(false)
  })
})

describe('fileMatches', () => {
  it('is true only for the exact bytes', async () => {
    const file = path.join(dir, 'installer.exe')

    fs.writeFileSync(file, PAYLOAD)

    expect(await fileMatches(file, sha256Hex(PAYLOAD), PAYLOAD.length)).toBe(true)
    expect(await fileMatches(file, sha256Hex(PAYLOAD), PAYLOAD.length + 1)).toBe(false)
    expect(await fileMatches(file, 'b'.repeat(64), PAYLOAD.length)).toBe(false)
    expect(await fileMatches(path.join(dir, 'missing.exe'), sha256Hex(PAYLOAD), PAYLOAD.length)).toBe(false)
  })
})
