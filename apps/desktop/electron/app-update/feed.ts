/**
 * Workmate's release feed: what a published version is and where its installers live.
 *
 * A release is announced by one signed document, `release.json`, served beside the
 * installers on the download site. Its signature (Ed25519, see ../signed-manifest.ts)
 * covers the version, the notes, and every installer's URL, size and sha256 — so an
 * installer is trusted only when it hashes to what the signed feed says, never because
 * of where it was downloaded from. The private key stays on the release machine
 * (scripts/release-feed.ts signs with it); only the public half ships here.
 *
 * Pure: no I/O. The release script (scripts/release-feed.ts) builds and checks feeds with
 * these same functions, so what it signs is exactly what the app accepts.
 */

import { compareVersions, isSemver, verifyEd25519Signature } from '../signed-manifest'

/** The download site's installer folder: the landing page serves `/install/` with no-cache. */
export const APP_DOWNLOAD_BASE_URL = 'https://agentx-landingpage.astralx.com.vn/install'
export const APP_RELEASE_FEED_URL = `${APP_DOWNLOAD_BASE_URL}/release.json`
/** The landing page's download section, for anyone who has to install by hand. */
export const APP_DOWNLOAD_PAGE_URL = 'https://agentx-landingpage.astralx.com.vn/#tai-ve'

/**
 * Public half of the key that signs Workmate releases. The private half lives only on
 * the release machine (`~/.config/agentx-workmate/release-signing-key.pem` by default,
 * deliberately outside ~/.agentx so no uninstall can take it);
 * `scripts/release-feed.ts` refuses to sign with a key that does not match this one.
 */
export const APP_RELEASE_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEA84k74D6U3wy+G0vJQdYvPbisY72aSEe0K2RnF7AIzM4=',
  '-----END PUBLIC KEY-----',
  ''
].join('\n')

export const APP_RELEASE_PRODUCT = 'agentx-workmate'

/** Locales every release must carry notes for; the app falls back to them. */
export const REQUIRED_NOTE_LOCALES = ['vi', 'en'] as const

const SHA256_HEX = /^[0-9a-f]{64}$/
const ASSET_KEY = /^(darwin|win32|linux)-(arm64|x64)$/
const LOCALE_KEY = /^[a-z]{2}(-[a-z]{2,4})?$/
const MAX_NOTES_PER_LOCALE = 20

export interface AppReleaseAsset {
  url: string
  sha256: string
  bytes: number
}

export interface AppReleaseFeed {
  schema: 1
  product: typeof APP_RELEASE_PRODUCT
  version: string
  publishedAt: string
  /** Bullet points per locale; `vi` and `en` are always present and non-empty. */
  notes: Record<string, string[]>
  /** Installers keyed `<platform>-<arch>`, e.g. `darwin-arm64`, `win32-x64`. */
  assets: Record<string, AppReleaseAsset>
  signature?: string
}

export class AppReleaseFeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppReleaseFeedError'
  }
}

export interface ParseAppReleaseFeedOptions {
  /**
   * Accept `http://127.0.0.1` / `http://localhost` installer URLs. Only an
   * explicit test feed (AGENTX_DESKTOP_UPDATE_FEED_URL) turns this on, so the whole
   * download → verify → install path can run against a local server.
   */
  allowLoopbackHttp?: boolean
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
}

function parseAsset(key: string, raw: unknown, options: ParseAppReleaseFeedOptions): AppReleaseAsset {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppReleaseFeedError(`asset ${key} is not an object`)
  }

  const record = raw as Record<string, unknown>
  let url: URL

  try {
    url = new URL(String(record.url))
  } catch {
    throw new AppReleaseFeedError(`asset ${key} url is not a URL`)
  }

  if (url.protocol !== 'https:' && !(options.allowLoopbackHttp && isLoopbackHttp(url))) {
    throw new AppReleaseFeedError(`asset ${key} url must be https`)
  }

  if (typeof record.sha256 !== 'string' || !SHA256_HEX.test(record.sha256)) {
    throw new AppReleaseFeedError(`asset ${key} sha256 is not a hex sha256`)
  }

  if (typeof record.bytes !== 'number' || !Number.isInteger(record.bytes) || record.bytes <= 0) {
    throw new AppReleaseFeedError(`asset ${key} bytes is not a positive integer`)
  }

  return { url: url.toString(), sha256: record.sha256, bytes: record.bytes }
}

function parseNotes(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppReleaseFeedError('notes is not an object')
  }

  const notes: Record<string, string[]> = {}

  for (const [locale, items] of Object.entries(raw as Record<string, unknown>)) {
    if (!LOCALE_KEY.test(locale)) {
      throw new AppReleaseFeedError(`notes locale ${locale} is not a locale code`)
    }

    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > MAX_NOTES_PER_LOCALE ||
      !items.every(item => typeof item === 'string' && item.trim().length > 0)
    ) {
      throw new AppReleaseFeedError(`notes.${locale} must be 1-${MAX_NOTES_PER_LOCALE} non-empty strings`)
    }

    notes[locale] = items.map(item => item.trim())
  }

  for (const locale of REQUIRED_NOTE_LOCALES) {
    if (!notes[locale]) {
      throw new AppReleaseFeedError(`notes.${locale} is missing`)
    }
  }

  return notes
}

/** Structural check. Throws AppReleaseFeedError naming the first problem. */
export function parseAppReleaseFeed(raw: unknown, options: ParseAppReleaseFeedOptions = {}): AppReleaseFeed {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppReleaseFeedError('the feed is not a JSON object')
  }

  const record = raw as Record<string, unknown>

  if (record.schema !== 1) {
    throw new AppReleaseFeedError(`feed schema ${String(record.schema)} is not supported`)
  }

  if (record.product !== APP_RELEASE_PRODUCT) {
    throw new AppReleaseFeedError(`the feed is for ${String(record.product)}, not ${APP_RELEASE_PRODUCT}`)
  }

  if (!isSemver(record.version)) {
    throw new AppReleaseFeedError(`feed version is not MAJOR.MINOR.PATCH: ${String(record.version)}`)
  }

  if (typeof record.publishedAt !== 'string' || Number.isNaN(Date.parse(record.publishedAt))) {
    throw new AppReleaseFeedError('feed publishedAt is not a date')
  }

  const rawAssets = record.assets

  if (!rawAssets || typeof rawAssets !== 'object' || Array.isArray(rawAssets)) {
    throw new AppReleaseFeedError('feed assets is not an object')
  }

  const assets: Record<string, AppReleaseAsset> = {}

  for (const [key, value] of Object.entries(rawAssets as Record<string, unknown>)) {
    if (!ASSET_KEY.test(key)) {
      throw new AppReleaseFeedError(`asset key ${key} is not <platform>-<arch>`)
    }

    assets[key] = parseAsset(key, value, options)
  }

  if (Object.keys(assets).length === 0) {
    throw new AppReleaseFeedError('the feed lists no installers')
  }

  const feed: AppReleaseFeed = {
    schema: 1,
    product: APP_RELEASE_PRODUCT,
    version: record.version,
    publishedAt: record.publishedAt,
    notes: parseNotes(record.notes),
    assets
  }

  if (typeof record.signature === 'string') {
    feed.signature = record.signature
  }

  return feed
}

/**
 * The parsed feed when it is well formed AND signed by `publicKeyPem`; otherwise an
 * AppReleaseFeedError saying which. The signature is checked over the document as
 * received, so nothing the signer did not see can ride along.
 */
export function verifyAppReleaseFeed(
  raw: unknown,
  publicKeyPem: string = APP_RELEASE_PUBLIC_KEY,
  options: ParseAppReleaseFeedOptions = {}
): AppReleaseFeed {
  const feed = parseAppReleaseFeed(raw, options)

  if (!verifyEd25519Signature(raw, publicKeyPem)) {
    throw new AppReleaseFeedError('the feed signature does not verify with the Workmate release key')
  }

  return feed
}

/** The asset key for a platform/arch pair, e.g. `darwin-arm64`. */
export function assetKeyFor(platform: string, arch: string): string {
  return `${platform}-${arch}`
}

/** true when `feed` is newer than the running version. */
export function isNewerRelease(feed: Pick<AppReleaseFeed, 'version'>, currentVersion: string): boolean {
  return compareVersions(feed.version, currentVersion) > 0
}

/**
 * The notes to show for `locale`: its own, else its language (`zh-hant` → `zh`), else
 * English, else Vietnamese.
 */
export function releaseNotesFor(notes: Record<string, string[]>, locale: string): string[] {
  const language = locale.split('-')[0]

  return notes[locale] ?? notes[language] ?? notes.en ?? notes.vi ?? []
}
