/**
 * Download one installer and prove it is the one the signed feed names.
 *
 * The bytes stream to `<destination>.partial` while they are hashed, so a 120 MB
 * installer never sits in memory, and the file only takes its real name once its
 * size and sha256 both match the feed. Anything else — a dropped connection, a
 * truncated or oversized body, a different file at the same URL — deletes the
 * partial file and fails with a kind the UI can explain.
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export type DownloadErrorKind = 'aborted' | 'disk' | 'hash' | 'http' | 'network' | 'size'

export class DownloadError extends Error {
  kind: DownloadErrorKind

  constructor(kind: DownloadErrorKind, message: string) {
    super(message)
    this.name = 'DownloadError'
    this.kind = kind
  }
}

/** The slice of `fetch` the download needs; Electron's `net.fetch` in the app. */
export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'follow' }
) => Promise<Response>

export interface DownloadRequest {
  url: string
  sha256: string
  bytes: number
  /** Final path. The download is written next to it as `<destination>.partial`. */
  destination: string
  signal?: AbortSignal
  /** Called as bytes arrive, at most every `progressIntervalMs`, and once at the end. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void
  progressIntervalMs?: number
  now?: () => number
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError')
}

export async function downloadVerified(request: DownloadRequest, fetchImpl: FetchLike): Promise<void> {
  const { url, sha256, bytes, destination, signal, onProgress } = request
  const interval = request.progressIntervalMs ?? 250
  const now = request.now ?? Date.now
  const partial = `${destination}.partial`

  let response: Response

  try {
    response = await fetchImpl(url, {
      signal,
      redirect: 'follow',
      // The installer keeps its name across releases; never take a cached copy.
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }
    })
  } catch (error) {
    if (isAbort(error, signal)) {
      throw new DownloadError('aborted', 'the download was cancelled')
    }

    throw new DownloadError(
      'network',
      `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (!response.ok || !response.body) {
    throw new DownloadError('http', `${url} answered HTTP ${response.status}`)
  }

  const announced = Number(response.headers.get('content-length') || 0)

  if (announced && announced !== bytes) {
    await response.body.cancel().catch(() => undefined)

    throw new DownloadError('size', `${url} is ${announced} bytes, the release says ${bytes}`)
  }

  try {
    await fsp.mkdir(path.dirname(destination), { recursive: true })
  } catch (error) {
    await response.body.cancel().catch(() => undefined)

    throw new DownloadError('disk', `could not create ${path.dirname(destination)}: ${(error as Error).message}`)
  }

  const hash = createHash('sha256')
  const reader = response.body.getReader()
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null
  let received = 0
  let lastReport = 0

  try {
    handle = await fsp.open(partial, 'w')

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>

      try {
        chunk = await reader.read()
      } catch (error) {
        if (isAbort(error, signal)) {
          throw new DownloadError('aborted', 'the download was cancelled')
        }

        throw new DownloadError('network', `the download of ${url} broke off: ${(error as Error).message}`)
      }

      if (chunk.done) {
        break
      }

      received += chunk.value.byteLength

      if (received > bytes) {
        throw new DownloadError('size', `${url} sent more than the ${bytes} bytes the release says`)
      }

      hash.update(chunk.value)

      try {
        await handle.write(chunk.value)
      } catch (error) {
        throw new DownloadError('disk', `could not write ${partial}: ${(error as Error).message}`)
      }

      if (onProgress && now() - lastReport >= interval) {
        lastReport = now()
        onProgress(received, bytes)
      }
    }

    if (received !== bytes) {
      throw new DownloadError('size', `${url} ended after ${received} of ${bytes} bytes`)
    }

    const digest = hash.digest('hex')

    if (digest !== sha256) {
      throw new DownloadError(
        'hash',
        `${url} hashes to ${digest.slice(0, 12)}…, the release says ${sha256.slice(0, 12)}…`
      )
    }

    await handle.close()
    handle = null
    await fsp.rename(partial, destination)
    onProgress?.(received, bytes)
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    await handle?.close().catch(() => undefined)
    await fsp.rm(partial, { force: true }).catch(() => undefined)

    if (error instanceof DownloadError) {
      throw error
    }

    throw new DownloadError('disk', `could not save the download: ${(error as Error).message}`)
  }
}

/** true when `file` exists with exactly `bytes` bytes hashing to `sha256`. */
export async function fileMatches(file: string, sha256: string, bytes: number): Promise<boolean> {
  try {
    const stat = await fsp.stat(file)

    if (!stat.isFile() || stat.size !== bytes) {
      return false
    }

    const hash = createHash('sha256')
    const handle = await fsp.open(file, 'r')

    try {
      const buffer = Buffer.alloc(1024 * 1024)

      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)

        if (bytesRead === 0) {
          break
        }

        hash.update(buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }

    return hash.digest('hex') === sha256
  } catch {
    return false
  }
}
