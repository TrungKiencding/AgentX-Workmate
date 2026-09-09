#!/usr/bin/env node
/**
 * Put the AgentX WebMate extension package into apps/desktop/build/webmate/ so
 * electron-builder ships it (extraResources → resources/webmate/). Runs as part
 * of `npm run build`.
 *
 *   node scripts/fetch-webmate.mjs                 # download the release pinned in
 *                                                  # optional-mcps/webmate/webmate.lock.json
 *   node scripts/fetch-webmate.mjs --from-dir DIR  # bundle a local WebMate build (DIR = its dist/)
 *   node scripts/fetch-webmate.mjs --pin 1.0.5     # download v1.0.5, verify, rewrite the lock
 *
 * What is verified before anything is bundled:
 *   - the zip's sha256 equals the lock's pin (download path) and release.json's chrome.sha256;
 *   - release.json's Ed25519 signature verifies with the key compiled into the
 *     app (electron/webmate/release-feed.ts) — a local `--from-dir` bundle may be
 *     unsigned, and is then only installable by a source build of the app.
 *
 * A lock whose `sha256` is null means the release does not exist yet: the step
 * then writes an explanatory MANIFEST.json and exits 0 so the build proceeds;
 * the app fetches the signed feed on first launch instead. Set
 * WEBMATE_LOCAL_DIST=<dir> to bundle a local build without passing --from-dir.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMain } from './utils.mjs'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..')
export const LOCK_FILE = join(REPO_ROOT, 'optional-mcps', 'webmate', 'webmate.lock.json')
export const OUT_DIR = join(DESKTOP_ROOT, 'build', 'webmate')
const RELEASE_FEED_SOURCE = join(DESKTOP_ROOT, 'electron', 'webmate', 'release-feed.ts')
const CHROME_ZIP = /^agentx-webmate-chrome-(\d+\.\d+\.\d+)\.zip$/

export const sha256Hex = buffer => createHash('sha256').update(buffer).digest('hex')

/** The release public key, read from the TypeScript source so there is exactly one copy. */
export function releasePublicKeyPem(source = readFileSync(RELEASE_FEED_SOURCE, 'utf8')) {
  const match = /WEBMATE_RELEASE_PUBLIC_KEY = \[\s*((?:'[^']*',?\s*)+)\]\.join\('\\n'\)/.exec(source)

  if (!match) {
    throw new Error(`could not find WEBMATE_RELEASE_PUBLIC_KEY in ${RELEASE_FEED_SOURCE}`)
  }

  return [...match[1].matchAll(/'([^']*)'/g)].map(m => m[1]).join('\n')
}

/** Mirror of release-feed.ts canonicalJson — the signature is over this form. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`
  const keys = Object.keys(value)
    .filter(key => value[key] !== undefined)
    .sort()

  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function verifyReleaseSignature(manifest, publicKeyPem) {
  try {
    const signature = String(manifest?.signature || '')

    if (!signature.startsWith('ed25519:')) return false
    const bytes = Buffer.from(signature.slice('ed25519:'.length), 'base64')

    if (bytes.length !== 64) return false
    const { signature: _s, ...rest } = manifest

    return cryptoVerify(null, Buffer.from(canonicalJson(rest), 'utf8'), createPublicKey(publicKeyPem), bytes)
  } catch {
    return false
  }
}

export function readLock(file = LOCK_FILE) {
  const lock = JSON.parse(readFileSync(file, 'utf8'))

  if (lock.schema !== 1 || typeof lock.version !== 'string') {
    throw new Error(`${file}: unsupported lock file`)
  }

  return lock
}

export function releaseAssetUrls(repository, version) {
  const base = String(repository).replace(/\/+$/, '')

  return {
    zip: `${base}/releases/download/v${version}/agentx-webmate-chrome-${version}.zip`,
    release: `${base}/releases/download/v${version}/release.json`
  }
}

/** Pick the Chrome zip in a local WebMate dist/ folder — the lock's version when present, else the newest. */
export function selectLocalChromeZip(names, wantedVersion) {
  const zips = names
    .map(name => ({ name, match: CHROME_ZIP.exec(name) }))
    .filter(entry => entry.match)
    .sort((a, b) => compareVersions(b.match[1], a.match[1]))

  if (!zips.length) return null
  const exact = zips.find(entry => entry.match[1] === wantedVersion)

  return exact ? { name: exact.name, version: wantedVersion } : { name: zips[0].name, version: zips[0].match[1] }
}

export function compareVersions(a, b) {
  const parse = value => (/^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : [-1, -1, -1])
  const [a1, a2, a3] = parse(a)
  const [b1, b2, b3] = parse(b)

  return a1 - b1 || a2 - b2 || a3 - b3
}

function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`

  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

function resetOutDir(outDir) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
}

/**
 * Describe what was (or was not) bundled. Ships next to the zip so the app and
 * a curious human can tell a deliberate "nothing bundled" from a broken build.
 */
export function buildManifest({ bundled, version = null, sha256 = null, signed = null, source = null, reason = null }) {
  return { schema: 1, bundled, version, sha256, signed, source, reason, writtenAt: new Date().toISOString() }
}

export async function downloadRelease({ version, repository, fetchImpl = fetch, log = console.log }) {
  const urls = releaseAssetUrls(repository, version)

  log(`[webmate] downloading ${urls.zip}`)
  const zipResponse = await fetchImpl(urls.zip)

  if (!zipResponse.ok) throw new Error(`download failed: ${urls.zip} → HTTP ${zipResponse.status}`)
  const zip = Buffer.from(await zipResponse.arrayBuffer())
  log(`[webmate] downloading ${urls.release}`)
  const releaseResponse = await fetchImpl(urls.release)

  if (!releaseResponse.ok) throw new Error(`download failed: ${urls.release} → HTTP ${releaseResponse.status}`)
  const release = JSON.parse(Buffer.from(await releaseResponse.arrayBuffer()).toString('utf8'))

  return { zip, release, urls }
}

export function checkDownloaded({ zip, release, version, expectedSha256, publicKeyPem }) {
  const digest = sha256Hex(zip)

  if (expectedSha256 && digest !== expectedSha256) {
    throw new Error(`zip sha256 ${digest} does not match the lock's ${expectedSha256}`)
  }

  if (release?.version !== version) throw new Error(`release.json is for ${release?.version}, expected ${version}`)
  if (release?.chrome?.sha256 !== digest) throw new Error(`release.json chrome.sha256 does not match the downloaded zip (${digest.slice(0, 12)}…)`)
  if (!verifyReleaseSignature(release, publicKeyPem)) throw new Error('release.json signature does not verify with the WebMate release key')

  return digest
}

export async function run({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, log = console.log, outDir = OUT_DIR, lockFile = LOCK_FILE } = {}) {
  const fromDirIndex = argv.indexOf('--from-dir')
  const pinIndex = argv.indexOf('--pin')
  const fromDir = fromDirIndex >= 0 ? argv[fromDirIndex + 1] : env.WEBMATE_LOCAL_DIST || null
  const pin = pinIndex >= 0 ? argv[pinIndex + 1] : null
  const lock = readLock(lockFile)
  const publicKeyPem = releasePublicKeyPem()

  if (fromDir) {
    const dir = resolve(fromDir)
    const chosen = selectLocalChromeZip(existsSync(dir) ? readdirSync(dir) : [], lock.version)

    if (!chosen) throw new Error(`no agentx-webmate-chrome-<version>.zip in ${dir}`)
    const zip = readFileSync(join(dir, chosen.name))
    const digest = sha256Hex(zip)
    const releaseFile = join(dir, 'release.json')
    let release = null
    let signed = null

    if (existsSync(releaseFile)) {
      release = JSON.parse(readFileSync(releaseFile, 'utf8'))

      if (release.version !== chosen.version) throw new Error(`${releaseFile} is for ${release.version}, but the zip is ${chosen.version}`)
      if (release.chrome?.sha256 !== digest) throw new Error(`${releaseFile} chrome.sha256 does not match ${chosen.name}`)
      signed = verifyReleaseSignature(release, publicKeyPem)
      if (release.signature && !signed) throw new Error(`${releaseFile} carries a signature that does not verify with the WebMate release key`)
    }

    resetOutDir(outDir)
    writeAtomic(join(outDir, chosen.name), zip)
    if (release) writeAtomic(join(outDir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`)
    writeAtomic(join(outDir, 'MANIFEST.json'), `${JSON.stringify(buildManifest({ bundled: true, version: chosen.version, sha256: digest, signed: Boolean(signed), source: `local:${dir}` }), null, 2)}\n`)
    log(`[webmate] bundled local ${chosen.name} (${(zip.length / 1024 / 1024).toFixed(1)} MB, ${signed ? 'signed' : release ? 'UNSIGNED release.json — only a source build installs it' : 'no release.json — only a source build installs it'})`)

    return { bundled: true, version: chosen.version, sha256: digest, signed: Boolean(signed) }
  }

  const version = pin || lock.version

  if (!pin && !lock.sha256) {
    resetOutDir(outDir)
    const reason = `webmate.lock.json pins ${lock.version} but has no sha256 yet (${lock.pending || 'release not published'}); nothing bundled — the app fetches the signed feed on first launch`

    writeAtomic(join(outDir, 'MANIFEST.json'), `${JSON.stringify(buildManifest({ bundled: false, version: lock.version, reason }), null, 2)}\n`)
    log(`[webmate] ${reason}`)

    return { bundled: false, version: lock.version, reason }
  }

  const { zip, release } = await downloadRelease({ version, repository: lock.repository, fetchImpl, log })
  const digest = checkDownloaded({ zip, release, version, expectedSha256: pin ? null : lock.sha256, publicKeyPem })

  resetOutDir(outDir)
  writeAtomic(join(outDir, `agentx-webmate-chrome-${version}.zip`), zip)
  writeAtomic(join(outDir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`)
  writeAtomic(join(outDir, 'MANIFEST.json'), `${JSON.stringify(buildManifest({ bundled: true, version, sha256: digest, signed: true, source: releaseAssetUrls(lock.repository, version).zip }), null, 2)}\n`)

  if (pin) {
    const next = { ...lock, version, sha256: digest }

    delete next.pending
    writeAtomic(lockFile, `${JSON.stringify(next, null, 2)}\n`)
    log(`[webmate] pinned ${version} (${digest.slice(0, 12)}…) in ${lockFile}`)
  }

  log(`[webmate] bundled agentx-webmate-chrome-${version}.zip (${(zip.length / 1024 / 1024).toFixed(1)} MB, signed)`)

  return { bundled: true, version, sha256: digest, signed: true }
}

if (isMain(import.meta.url)) {
  run().catch(error => {
    console.error(`[webmate] fetch-webmate failed: ${error.message}`)
    process.exit(1)
  })
}
