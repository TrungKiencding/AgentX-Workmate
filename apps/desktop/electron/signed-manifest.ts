/**
 * Ed25519-signed JSON manifests: the primitives both update feeds stand on.
 *
 * Two feeds use them — WebMate's `release.json` (electron/webmate/release-feed.ts)
 * and Workmate's own (electron/app-update/feed.ts). A manifest is a JSON object
 * whose `signature` field is `ed25519:<base64>` over the canonical JSON of every
 * other field. Canonical JSON is the one format the signers outside this repo
 * also produce (WebMate's scripts/release-manifest.mjs), so it must stay byte for
 * byte what it is.
 *
 * Pure: no I/O. Workmate's release script (scripts/release-feed.ts) signs with
 * signEd25519 below, so the app verifies exactly what was signed.
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'

const SIGNATURE_PREFIX = 'ed25519:'
const SEMVER = /^\d+\.\d+\.\d+$/

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

/** The bytes a signature covers: canonical JSON of everything but `signature`. */
export function signingPayload(manifest: Record<string, unknown>): Buffer {
  const { signature: _signature, ...rest } = manifest

  return Buffer.from(canonicalJson(rest), 'utf8')
}

/**
 * true only when `raw.signature` is an Ed25519 signature of `raw` under
 * `publicKeyPem`. Checks the document as received — every field the signer
 * saw — so a field added after signing fails the check rather than slipping
 * past a parser that ignores it. Never throws: a broken signature is no
 * signature.
 */
export function verifyEd25519Signature(raw: unknown, publicKeyPem: string): boolean {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return false
    }

    const signature = String((raw as Record<string, unknown>).signature || '')

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

    return cryptoVerify(null, signingPayload(raw as Record<string, unknown>), key, bytes)
  } catch {
    return false
  }
}

/** The `signature` value for `manifest` (any existing signature is ignored). */
export function signEd25519(manifest: Record<string, unknown>, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)

  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('the signing key is not an Ed25519 private key')
  }

  return `${SIGNATURE_PREFIX}${cryptoSign(null, signingPayload(manifest), key).toString('base64')}`
}

export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value)
}

/** Compare MAJOR.MINOR.PATCH strings; non-semver sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => (SEMVER.test(value) ? value.split('.').map(Number) : [-1, -1, -1])
  const [a1, a2, a3] = parse(a)
  const [b1, b2, b3] = parse(b)

  return a1 - b1 || a2 - b2 || a3 - b3
}
