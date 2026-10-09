import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { FetchLike } from '../electron/app-update/download'

import { downloadAsset, type ReleaseAsset } from './release-download'

let dir: string
let target: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-release-download-'))
  target = path.join(dir, 'AgentXWorkmate-win-x64.exe')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const DATA = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251))

function assetFor(data: Uint8Array): ReleaseAsset {
  return {
    name: 'AgentXWorkmate-1.0.9-win-x64.exe',
    url: 'https://github.test/releases/download/desktop-v1.0.9/AgentXWorkmate-1.0.9-win-x64.exe',
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length
  }
}

const partialOf = (asset: ReleaseAsset) => `${target}.${asset.sha256.slice(0, 12)}.partial`

/** A body that sends `data`, then fails the way undici reports a reset connection. */
function breaksAfter(data: Uint8Array) {
  let sent = false

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(new TypeError('terminated', { cause: new Error('other side closed') }))

        return
      }

      sent = true
      controller.enqueue(data)
    }
  })
}

/** A body that sends `data`, then nothing, ever. */
function stallsAfter(data: Uint8Array) {
  let sent = false

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        return new Promise<void>(() => undefined)
      }

      sent = true
      controller.enqueue(data)
    }
  })
}

/** What a server that honours ranges answers: 206 from `start`, or 200 with everything. */
function honest(data: Buffer, start: null | number): Response {
  const body = data.subarray(start ?? 0)

  return new Response(new Uint8Array(body), {
    status: start === null ? 200 : 206,
    headers: {
      'content-length': String(body.length),
      ...(start === null ? {} : { 'content-range': `bytes ${start}-${data.length - 1}/${data.length}` })
    }
  })
}

/** Serves `data`, answering request N with `script[N]` when there is one. */
function server(data: Buffer, script: (() => Response)[] = []) {
  const ranges: (string | undefined)[] = []

  const fetch: FetchLike = async (_url, init) => {
    const range = init.headers?.range

    ranges.push(range)

    return script[ranges.length - 1]?.() ?? honest(data, range ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : null)
  }

  return { fetch, ranges }
}

const quiet = { log: () => undefined, sleep: async () => undefined }

describe('downloading a release asset', () => {
  it('resumes where a dropped connection broke off', async () => {
    const delays: number[] = []
    const { fetch, ranges } = server(DATA, [() => new Response(breaksAfter(DATA.subarray(0, 400)))])

    await downloadAsset(assetFor(DATA), target, {
      fetch,
      log: () => undefined,
      sleep: async ms => {
        delays.push(ms)
      }
    })

    expect(fs.readFileSync(target)).toEqual(DATA)
    expect(ranges).toEqual([undefined, 'bytes=400-'])
    expect(delays).toEqual([1000])
    expect(fs.readdirSync(dir)).toEqual([path.basename(target)])
  })

  it('starts over when the server answers a range with the whole file, or with the wrong part', async () => {
    const wholeFile = server(DATA, [() => new Response(breaksAfter(DATA.subarray(0, 400))), () => honest(DATA, null)])

    await downloadAsset(assetFor(DATA), target, { fetch: wholeFile.fetch, ...quiet })
    expect(fs.readFileSync(target)).toEqual(DATA)
    expect(wholeFile.ranges).toEqual([undefined, 'bytes=400-'])

    fs.rmSync(target)

    const wrongPart = server(DATA, [() => new Response(breaksAfter(DATA.subarray(0, 400))), () => honest(DATA, 0)])

    await downloadAsset(assetFor(DATA), target, { fetch: wrongPart.fetch, ...quiet })
    expect(fs.readFileSync(target)).toEqual(DATA)
    expect(wrongPart.ranges).toEqual([undefined, 'bytes=400-', undefined])
  })

  it('carries on from what an interrupted run left, and keeps a finished download', async () => {
    const asset = assetFor(DATA)

    fs.writeFileSync(partialOf(asset), DATA.subarray(0, 600))
    // Left by an upload that has since been replaced: never continued.
    fs.writeFileSync(`${target}.000000000000.partial`, Buffer.alloc(900))

    const first = server(DATA)

    await downloadAsset(asset, target, { fetch: first.fetch, ...quiet })
    expect(first.ranges).toEqual(['bytes=600-'])
    expect(fs.readFileSync(target)).toEqual(DATA)

    const again = server(DATA)

    await downloadAsset(asset, target, { fetch: again.fetch, ...quiet })
    expect(again.ranges).toEqual([])
  })

  it('drops a connection that goes quiet and resumes', async () => {
    const lines: string[] = []
    const { fetch, ranges } = server(DATA, [() => new Response(stallsAfter(DATA.subarray(0, 300)))])

    await downloadAsset(assetFor(DATA), target, {
      fetch,
      sleep: async () => undefined,
      log: line => lines.push(line),
      idleTimeoutMs: 20
    })

    expect(fs.readFileSync(target)).toEqual(DATA)
    expect(ranges).toEqual([undefined, 'bytes=300-'])
    expect(lines.join('\n')).toMatch(/no data for/)
  })

  it('gives up after attempts in a row that add nothing, and keeps the bytes for the next run', async () => {
    const asset = assetFor(DATA)
    const delays: number[] = []
    let requests = 0

    const fetch: FetchLike = async () => {
      requests += 1

      if (requests === 1) {
        return new Response(breaksAfter(DATA.subarray(0, 250)))
      }

      throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') })
    }

    await expect(
      downloadAsset(asset, target, {
        fetch,
        attempts: 4,
        log: () => undefined,
        sleep: async ms => {
          delays.push(ms)
        }
      })
    ).rejects.toThrow(/fetch failed: read ECONNRESET \(4 attempts in a row added nothing; run again to resume/)

    // Progress resets the backoff; each attempt that adds nothing doubles it.
    expect(delays).toEqual([1000, 2000, 4000, 8000])
    expect(fs.statSync(partialOf(asset)).size).toBe(250)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('does not retry an asset that is not there', async () => {
    const { fetch, ranges } = server(DATA, [() => new Response('Not Found', { status: 404 })])

    await expect(downloadAsset(assetFor(DATA), target, { fetch, ...quiet })).rejects.toThrow(/HTTP 404/)
    expect(ranges).toHaveLength(1)
  })

  it('keeps nothing that is not the size and sha256 GitHub reports', async () => {
    const reversed = server(Buffer.from(DATA).reverse())

    await expect(downloadAsset(assetFor(DATA), target, { fetch: reversed.fetch, ...quiet })).rejects.toThrow(
      /does not hash to the sha256 GitHub reports/
    )
    expect(fs.readdirSync(dir)).toEqual([])

    const doubled = server(Buffer.concat([DATA, DATA]))

    await expect(downloadAsset(assetFor(DATA), target, { fetch: doubled.fetch, ...quiet })).rejects.toThrow(
      /the server has 2000 bytes, GitHub reports 1000/
    )
    expect(fs.existsSync(target)).toBe(false)
  })
})
