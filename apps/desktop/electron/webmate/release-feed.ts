/**
 * The WebMate update feed (`release.json`) as Workmate reads it.
 *
 * Mirror of `scripts/release-manifest.mjs` in the WebMate repository — the two
 * must stay byte-for-byte compatible on the canonical form, because the
 * Ed25519 signature is computed over it. Workmate installs a release only when
 * the signature verifies under the key below AND the downloaded zip's sha256
 * matches; there is no "install anyway".
 *
 * Pure: no I/O. The updater (phase 2) and the installer's fetch script sit on
 * top of this.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

/**
 * Public half of the Ed25519 key that signs WebMate releases. The private half
 * is the WebMate repository's `WEBMATE_RELEASE_SIGNING_KEY` GitHub secret; a
 * copy of this PEM is committed there as scripts/release-signing-key.pub.pem
 * and the release workflow refuses to sign with any other key.
 */
export const WEBMATE_RELEASE_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEApDBdmNhqWhgtL7Dymqe3cyLuYW7G8dPXh57S3AmdXvY=',
  '-----END PUBLIC KEY-----',
  ''
].join('\n')

export const WEBMATE_RELEASE_FEED_URL = 'https://raw.githubusercontent.com/astralxkienlt/agentx-webmate/main/release.json'
export const WEBMATE_REPOSITORY_URL = 'https://github.com/astralxkienlt/agentx-webmate'

const SIGNATURE_PREFIX = 'ed25519:'
const SEMVER = /^\d+\.\d+\.\d+$/
const SHA256_HEX = /^[0-9a-f]{64}$/

export interface ReleaseManifest {
  schema: 1
  version: string
  publishedAt: string
  chrome: { url: string; sha256: string; bytes: number }
  minWorkmate: string
  minProtocol: number
  notes: { vi?: string; en?: string; [locale: string]: string | undefined }
  signature?: string
}

export class ReleaseManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseManifestError'
  }
}

/** Deterministic JSON: sorted keys at every level, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`
  }

  const record = value as Record<string, unknown>

  const keys = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()

  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export function sha256Hex(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Structural check. Throws ReleaseManifestError naming the first problem. */
export function parseReleaseManifest(raw: unknown): ReleaseManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReleaseManifestError('release manifest must be an object')
  }

  const record = raw as Record<string, unknown>

  if (record.schema !== 1) {
    throw new ReleaseManifestError(`release manifest schema ${String(record.schema)} is not supported`)
  }

  if (typeof record.version !== 'string' || !SEMVER.test(record.version)) {
    throw new ReleaseManifestError(`release manifest version is not MAJOR.MINOR.PATCH: ${String(record.version)}`)
  }

  if (typeof record.publishedAt !== 'string' || Number.isNaN(Date.parse(record.publishedAt))) {
    throw new ReleaseManifestError('release manifest publishedAt is not a date')
  }

  const chrome = record.chrome as Record<string, unknown> | undefined

  if (!chrome || typeof chrome !== 'object') {
    throw new ReleaseManifestError('release manifest has no chrome package')
  }

  let url: URL

  try {
    url = new URL(String(chrome.url))
  } catch {
    throw new ReleaseManifestError('release manifest chrome.url is not a URL')
  }

  if (url.protocol !== 'https:') {
    throw new ReleaseManifestError('release manifest chrome.url must be https')
  }

  if (typeof chrome.sha256 !== 'string' || !SHA256_HEX.test(chrome.sha256)) {
    throw new ReleaseManifestError('release manifest chrome.sha256 is not a hex sha256')
  }

  if (typeof chrome.bytes !== 'number' || !Number.isInteger(chrome.bytes) || chrome.bytes <= 0) {
    throw new ReleaseManifestError('release manifest chrome.bytes is not a positive integer')
  }

  if (typeof record.minWorkmate !== 'string' || !SEMVER.test(record.minWorkmate)) {
    throw new ReleaseManifestError('release manifest minWorkmate is not MAJOR.MINOR.PATCH')
  }

  if (typeof record.minProtocol !== 'number' || !Number.isInteger(record.minProtocol) || record.minProtocol < 1) {
    throw new ReleaseManifestError('release manifest minProtocol is not a positive integer')
  }

  if (!record.notes || typeof record.notes !== 'object') {
    throw new ReleaseManifestError('release manifest has no notes')
  }

  const manifest: ReleaseManifest = {
    schema: 1,
    version: record.version,
    publishedAt: record.publishedAt,
    chrome: { url: url.toString(), sha256: chrome.sha256, bytes: chrome.bytes },
    minWorkmate: record.minWorkmate,
    minProtocol: record.minProtocol,
    notes: { ...(record.notes as Record<string, string>) }
  }

  if (typeof record.signature === 'string') {
    manifest.signature = record.signature
  }

  return manifest
}

/** The bytes the signature covers: canonical JSON of everything but `signature`. */
export function signingPayload(manifest: Record<string, unknown>): Buffer {
  const { signature: _signature, ...rest } = manifest

  return Buffer.from(canonicalJson(rest), 'utf8')
}

/**
 * true only for a well-formed manifest whose Ed25519 signature verifies under
 * `publicKeyPem`. Never throws: a broken feed is "no feed".
 */
export function verifyReleaseManifest(raw: unknown, publicKeyPem: string = WEBMATE_RELEASE_PUBLIC_KEY): boolean {
  try {
    const manifest = parseReleaseManifest(raw)
    const signature = String(manifest.signature || '')

    if (!signature.startsWith(SIGNATURE_PREFIX)) {
      return false
    }

    const bytes = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'base64')

    if (bytes.length !== 64) {
      return false
    }

    const key = createPublicKey(publicKeyPem)

    if (key.asymmetricKeyType !== 'ed25519') {
      return false
    }

    // Verify over the document as received (all fields the signer saw), not
    // over the parsed subset — an extra field would otherwise slip past.
    return cryptoVerify(null, signingPayload(raw as Record<string, unknown>), key, bytes)
  } catch {
    return false
  }
}

/** Compare MAJOR.MINOR.PATCH strings; non-semver sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => (SEMVER.test(value) ? value.split('.').map(Number) : [-1, -1, -1])
  const [a1, a2, a3] = parse(a)
  const [b1, b2, b3] = parse(b)

  return a1 - b1 || a2 - b2 || a3 - b3
}
