/**
 * Download one GitHub Release asset for the release script (release-feed.ts
 * `build --from-github`) and prove it is the asset GitHub describes.
 *
 * GitHub's download CDN has reset connections partway through 100 MB installers,
 * and `gh release download` gives up when that happens. This keeps every byte it
 * already has: a dropped or stalled connection resumes with an HTTP Range request,
 * and so does the next run after an interrupted one. The file only takes its real
 * name once it is the size, and hashes to the sha256, that GitHub computed when
 * the asset was uploaded.
 */

import fs from 'node:fs'
import path from 'node:path'

import { type FetchLike, fileMatches } from '../electron/app-update/download'

/** A release asset with the size and sha256 GitHub recorded when it was uploaded. */
export interface ReleaseAsset {
  name: string
  url: string
  sha256: string
  bytes: number
}

export class AssetDownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetDownloadError'
  }
}

export interface DownloadOptions {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  /** Attempts in a row that add no bytes before giving up; each waits twice as long, up to 30 s. */
  attempts?: number
  /** A connection that sends nothing for this long is dropped and resumed. */
  idleTimeoutMs?: number
}

/** Why one request stopped short, and whether another can pick up from there. */
class AttemptError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
    /** The partial file cannot be continued: start over. */
    readonly discard = false
  ) {
    super(message)
  }
}

export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** undici reports "fetch failed" / "terminated" and puts the reason in `cause`. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cause = (error as { cause?: { message?: string } })?.cause?.message

  return cause ? `${message}: ${cause}` : message
}

/** One request for the asset from `offset` on, written to `partial`; resolves once the asset is complete. */
async function requestRemainder(
  asset: ReleaseAsset,
  partial: string,
  offset: number,
  fetchImpl: FetchLike,
  idleTimeoutMs: number,
  onProgress: (bytes: number) => void
) {
  const controller = new AbortController()
  const quiet = `no data for ${Math.round(idleTimeoutMs / 1000)} s`
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      controller.abort()
      reader?.cancel().catch(() => undefined)
    }, idleTimeoutMs)
  }

  arm()

  try {
    let response: Response

    try {
      response = await fetchImpl(asset.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: offset > 0 ? { range: `bytes=${offset}-` } : {}
      })
    } catch (error) {
      throw new AttemptError(stalled ? quiet : errorText(error), true)
    }

    const resumed = response.status === 206

    if (resumed) {
      const range = response.headers.get('content-range') ?? ''
      const match = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(range)

      if (!match || Number(match[1]) !== offset) {
        await response.body?.cancel().catch(() => undefined)

        throw new AttemptError(`asked for bytes ${offset}- and got ${range || 'no Content-Range'}`, true, true)
      }

      if (match[2] !== '*' && Number(match[2]) !== asset.bytes) {
        await response.body?.cancel().catch(() => undefined)

        throw new AttemptError(`the server has ${match[2]} bytes, GitHub reports ${asset.bytes}`, false)
      }
    } else if (response.ok) {
      // The whole asset, whether or not a range was asked for.
      const length = Number(response.headers.get('content-length') || 0)

      if (length && length !== asset.bytes) {
        await response.body?.cancel().catch(() => undefined)

        throw new AttemptError(`the server has ${length} bytes, GitHub reports ${asset.bytes}`, false)
      }
    } else {
      await response.body?.cancel().catch(() => undefined)
      const transient = response.status >= 500 || response.status === 408 || response.status === 429

      throw new AttemptError(
        `HTTP ${response.status} from ${asset.url}`,
        transient || response.status === 416,
        response.status === 416
      )
    }

    if (!response.body) {
      throw new AttemptError('the response has no body', true)
    }

    reader = response.body.getReader()

    const handle = await fs.promises.open(partial, resumed ? 'a' : 'w')
    let received = resumed ? offset : 0
    let ended = false

    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>

        try {
          chunk = await reader.read()
        } catch (error) {
          throw new AttemptError(stalled ? quiet : errorText(error), true)
        }

        if (chunk.done) {
          ended = true

          break
        }

        arm()

        if (received + chunk.value.byteLength > asset.bytes) {
          throw new AttemptError(`the server sent more than the ${asset.bytes} bytes GitHub reports`, false)
        }

        await handle.write(chunk.value)
        received += chunk.value.byteLength
        onProgress(received)
      }
    } finally {
      if (!ended) {
        await reader.cancel().catch(() => undefined)
      }

      await handle.close()
    }

    if (received < asset.bytes) {
      throw new AttemptError(
        stalled ? quiet : `the connection closed at ${megabytes(received)} of ${megabytes(asset.bytes)}`,
        true
      )
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Download `asset` to `destination` and prove it is the asset GitHub describes.
 *
 * The bytes collect in a `.partial` file named for the asset's sha256, so a dropped
 * or stalled connection — or an interrupted run — resumes where it stopped (an HTTP
 * Range request) rather than from zero. It gives up only after `attempts` requests
 * in a row that add nothing. The file takes its real name once it hashes to
 * `asset.sha256`; a `destination` that already does is kept as it is.
 */
export async function downloadAsset(
  asset: ReleaseAsset,
  destination: string,
  options: DownloadOptions = {}
): Promise<void> {
  const fetchImpl = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const log = options.log ?? console.log
  const attempts = options.attempts ?? 6
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000

  if (await fileMatches(destination, asset.sha256, asset.bytes)) {
    log(`  ✓ ${asset.name} is already downloaded`)

    return
  }

  const partial = `${destination}.${asset.sha256.slice(0, 12)}.partial`
  const kept = Math.min(fileSize(partial), asset.bytes)
  let shown = Math.floor((kept / asset.bytes) * 10)
  let failures = 0

  const onProgress = (received: number) => {
    const tenth = Math.floor((received / asset.bytes) * 10)

    if (tenth > shown && tenth < 10) {
      shown = tenth
      log(`    ${tenth * 10}% (${megabytes(received)})`)
    }
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true })
  log(`  ↓ ${asset.name} (${megabytes(asset.bytes)}${kept ? `, resuming at ${megabytes(kept)}` : ''})`)

  for (;;) {
    let offset = fileSize(partial)

    if (offset > asset.bytes) {
      fs.rmSync(partial, { force: true })
      offset = 0
    }

    if (offset === asset.bytes) {
      break
    }

    let problem: string

    try {
      await requestRemainder(asset, partial, offset, fetchImpl, idleTimeoutMs, onProgress)

      continue
    } catch (error) {
      if (!(error instanceof AttemptError)) {
        throw error
      }

      if (error.discard) {
        fs.rmSync(partial, { force: true })
      }

      if (!error.retry) {
        throw new AssetDownloadError(`could not download ${asset.name}: ${error.message}`)
      }

      problem = error.message
    }

    const reached = fileSize(partial)

    failures = reached > offset ? 0 : failures + 1

    if (failures >= attempts) {
      throw new AssetDownloadError(
        `could not download ${asset.name}: ${problem} (${attempts} attempts in a row added nothing` +
          `${reached ? `; run again to resume from ${megabytes(reached)}` : ''})`
      )
    }

    const delay = Math.min(30_000, 1_000 * 2 ** failures)

    log(`    ↻ ${problem}; resuming at ${megabytes(reached)} in ${delay / 1000} s`)
    await sleep(delay)
  }

  if (!(await fileMatches(partial, asset.sha256, asset.bytes))) {
    fs.rmSync(partial, { force: true })

    throw new AssetDownloadError(
      `${asset.name} does not hash to the sha256 GitHub reports (${asset.sha256.slice(0, 12)}…); ` +
        'the download was deleted, run again'
    )
  }

  fs.renameSync(partial, destination)
  log(`  ✓ ${asset.name} matches GitHub's sha256 ${asset.sha256.slice(0, 12)}…`)
}
