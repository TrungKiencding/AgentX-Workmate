#!/usr/bin/env tsx
/**
 * Publish a Workmate release to the download site: sign `release.json` for the
 * installers that were just built, so every installed app can offer the update.
 *
 *   npm run release:feed -- keygen
 *   npm run release:feed -- build --out ~/Desktop/AgentX-Landing/public/install
 *   npm run release:feed -- verify ~/Desktop/AgentX-Landing/public/install
 *
 * `build` refuses unless everything an installed app will rely on holds:
 *   - the version in package.json is the product version (hermes_cli/__init__.py);
 *   - the build stamp is clean and its commit is on origin/main — the agent each
 *     installer pins is fetched from GitHub on first launch;
 *   - every installer carries that version and that stamp;
 *   - release-notes/<version>.md has Vietnamese and English notes;
 *   - the signing key is the one whose public half ships in the app
 *     (electron/app-update/feed.ts).
 * It then copies the installers and the signed feed into --out. Deploying that
 * folder (AgentX-Landing's deploy/deploy.sh) is what publishes the release.
 *
 * The feed is built and checked with the app's own parser and verifier, so what
 * this signs is exactly what the app accepts.
 */

import { execFile } from 'node:child_process'
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { fileMatches } from '../electron/app-update/download'
import {
  APP_DOWNLOAD_BASE_URL,
  APP_RELEASE_PRODUCT,
  APP_RELEASE_PUBLIC_KEY,
  type AppReleaseFeed,
  parseAppReleaseFeed,
  verifyAppReleaseFeed
} from '../electron/app-update/feed'
import { sha256Hex, signEd25519 } from '../electron/signed-manifest'

import { readPeIdentity } from './win-exe-identity.mjs'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')

export const DEFAULT_KEY_PATH = path.join(os.homedir(), '.config', 'agentx-workmate', 'release-signing-key.pem')
export const FEED_FILE = 'release.json'

/** The installers a release publishes, by asset key. Names match the download page. */
export const ARTIFACTS = [
  { key: 'darwin-arm64', file: 'AgentXWorkmate-mac-arm64.dmg' },
  { key: 'win32-x64', file: 'AgentXWorkmate-win-x64.exe' }
] as const

export type Run = (file: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string }>

const execFileAsync = promisify(execFile)

const defaultRun: Run = async (file, args, options = {}) => {
  const { stdout } = await execFileAsync(file, args, { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 })

  return { stdout: String(stdout) }
}

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseError'
  }
}

// ── keys ────────────────────────────────────────────────────────────────────

export function keyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTX_WORKMATE_RELEASE_KEY || DEFAULT_KEY_PATH
}

/** Create the signing key (0600, never overwritten); returns its public half as PEM. */
export function generateSigningKey(file: string): string {
  if (fs.existsSync(file)) {
    throw new ReleaseError(`${file} already exists; a release key is never replaced in place`)
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600, flag: 'wx' })

  return publicKey.export({ type: 'spki', format: 'pem' }) as string
}

/** The private key at `file`, checked to be the one `publicKeyPem` belongs to. */
export function loadSigningKey(file: string, publicKeyPem: string): string {
  let pem: string

  try {
    pem = fs.readFileSync(file, 'utf8')
  } catch {
    throw new ReleaseError(`no release signing key at ${file} (set AGENTX_WORKMATE_RELEASE_KEY or pass --key)`)
  }

  const derived = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }) as string

  if (derived.trim() !== publicKeyPem.trim()) {
    throw new ReleaseError(
      `${file} is not the key the app trusts: its public half differs from APP_RELEASE_PUBLIC_KEY in electron/app-update/feed.ts`
    )
  }

  return pem
}

// ── notes ───────────────────────────────────────────────────────────────────

/**
 * Release notes are a small Markdown file: one `## <locale>` heading per language,
 * each followed by `- ` bullets. Anything else is ignored.
 */
export function parseReleaseNotes(markdown: string): Record<string, string[]> {
  const notes: Record<string, string[]> = {}
  let locale: null | string = null

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+([A-Za-z-]+)\s*$/.exec(line)

    if (heading) {
      locale = heading[1].toLowerCase()
      notes[locale] = notes[locale] ?? []

      continue
    }

    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line)

    if (bullet && locale) {
      notes[locale].push(bullet[1])
    }
  }

  return notes
}

// ── checks ──────────────────────────────────────────────────────────────────

export interface BuildStamp {
  commit: string
  dirty: boolean
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ReleaseError(`could not read ${file}: ${(error as Error).message}`)
  }
}

/** package.json's version, which must be the product version release.py syncs. */
export function productVersion(desktopRoot = DESKTOP_ROOT, repoRoot = REPO_ROOT): string {
  const version = String(readJson(path.join(desktopRoot, 'package.json')).version || '')
  const init = fs.readFileSync(path.join(repoRoot, 'hermes_cli', '__init__.py'), 'utf8')
  const product = /__version__\s*=\s*["']([^"']+)["']/.exec(init)?.[1]

  if (version !== product) {
    throw new ReleaseError(
      `apps/desktop/package.json says ${version} but hermes_cli/__init__.py says ${product}; run scripts/release.py --sync-versions`
    )
  }

  return version
}

export function readBuildStamp(desktopRoot = DESKTOP_ROOT): BuildStamp {
  const stamp = readJson(path.join(desktopRoot, 'build', 'install-stamp.json'))

  if (!/^[0-9a-f]{40}$/.test(String(stamp.commit))) {
    throw new ReleaseError('build/install-stamp.json has no commit; was this a fallback build?')
  }

  if (stamp.dirty !== false) {
    throw new ReleaseError('the installers were built from a dirty tree (install-stamp.json dirty: true)')
  }

  return { commit: stamp.commit, dirty: false }
}

/** The agent each installer pins is cloned from GitHub: its commit must be on origin/main. */
export async function assertStampOnOriginMain(
  commit: string,
  run: Run = defaultRun,
  repoRoot = REPO_ROOT
): Promise<void> {
  await run('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: repoRoot })

  try {
    await run('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], { cwd: repoRoot })
  } catch {
    throw new ReleaseError(
      `the build stamp ${commit.slice(0, 10)} is not on origin/main; merge and push before publishing`
    )
  }
}

/** Mount the DMG and check the app inside carries `version` and `stampCommit`. */
export async function checkMacInstaller(dmg: string, version: string, stampCommit: string, run: Run = defaultRun) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-release-'))

  try {
    await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint, dmg])

    try {
      const apps = fs.readdirSync(mountPoint).filter(name => name.endsWith('.app'))

      if (apps.length !== 1) {
        throw new ReleaseError(`${path.basename(dmg)} holds ${apps.length} apps, expected one`)
      }

      const app = path.join(mountPoint, apps[0])

      const { stdout } = await run('/usr/bin/plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        path.join(app, 'Contents', 'Info.plist')
      ])

      const info = JSON.parse(stdout)

      if (info.CFBundleShortVersionString !== version) {
        throw new ReleaseError(
          `${path.basename(dmg)} is version ${info.CFBundleShortVersionString}, expected ${version}`
        )
      }

      const stamp = readJson(path.join(app, 'Contents', 'Resources', 'install-stamp.json'))

      if (stamp.commit !== stampCommit) {
        throw new ReleaseError(
          `${path.basename(dmg)} pins ${String(stamp.commit).slice(0, 10)}, the build stamp is ${stampCommit.slice(0, 10)}`
        )
      }
    } finally {
      await run('/usr/bin/hdiutil', ['detach', mountPoint]).catch(() =>
        run('/usr/bin/hdiutil', ['detach', '-force', mountPoint])
      )
    }
  } finally {
    fs.rmSync(mountPoint, { recursive: true, force: true })
  }
}

/**
 * The NSIS installer's version resource, and the stamp of the unpacked build it was
 * packed from (the installer's own payload is compressed).
 */
export function checkWindowsInstaller(
  exe: string,
  version: string,
  stampCommit: string,
  releaseDir: string,
  readVersionStrings: (file: string) => Record<string, string> = file =>
    readPeIdentity(fs.readFileSync(file)).versionStrings || {}
) {
  const strings = readVersionStrings(exe)

  if (strings.ProductVersion !== version) {
    throw new ReleaseError(`${path.basename(exe)} is version ${strings.ProductVersion}, expected ${version}`)
  }

  const stamp = readJson(path.join(releaseDir, 'win-unpacked', 'resources', 'install-stamp.json'))

  if (stamp.commit !== stampCommit) {
    throw new ReleaseError(
      `the Windows build pins ${String(stamp.commit).slice(0, 10)}, the build stamp is ${stampCommit.slice(0, 10)}`
    )
  }
}

// ── feed ────────────────────────────────────────────────────────────────────

export interface FeedArtifact {
  key: string
  file: string
  sha256: string
  bytes: number
}

export function describeArtifact(key: string, file: string): FeedArtifact {
  const bytes = fs.readFileSync(file)

  return { key, file, sha256: sha256Hex(bytes), bytes: bytes.length }
}

/**
 * The signed feed for `artifacts`, exactly as it will be published, after the app's
 * own verifier has accepted it under `publicKeyPem`.
 */
export function buildSignedFeed(options: {
  version: string
  notes: Record<string, string[]>
  artifacts: FeedArtifact[]
  baseUrl: string
  privateKeyPem: string
  publicKeyPem: string
  publishedAt?: string
  allowLoopbackHttp?: boolean
}): Record<string, unknown> {
  const base = options.baseUrl.replace(/\/+$/, '')

  const unsigned: Record<string, unknown> = {
    schema: 1,
    product: APP_RELEASE_PRODUCT,
    version: options.version,
    publishedAt: options.publishedAt ?? new Date().toISOString(),
    notes: options.notes,
    assets: Object.fromEntries(
      options.artifacts.map(artifact => [
        artifact.key,
        {
          url: `${base}/${encodeURIComponent(path.basename(artifact.file))}`,
          sha256: artifact.sha256,
          bytes: artifact.bytes
        }
      ])
    )
  }

  const feedOptions = { allowLoopbackHttp: options.allowLoopbackHttp }

  try {
    parseAppReleaseFeed(unsigned, feedOptions)
  } catch (error) {
    throw new ReleaseError(`the feed would not be accepted: ${(error as Error).message}`)
  }

  const signed = { ...unsigned, signature: signEd25519(unsigned, options.privateKeyPem) }

  // Throws unless the app would accept exactly these bytes.
  verifyAppReleaseFeed(signed, options.publicKeyPem, feedOptions)

  return signed
}

/** Check a published folder: the feed verifies and every installer it names matches. */
export async function verifyReleaseDir(dir: string, publicKeyPem = APP_RELEASE_PUBLIC_KEY): Promise<AppReleaseFeed> {
  const feed = verifyAppReleaseFeed(readJson(path.join(dir, FEED_FILE)), publicKeyPem)

  for (const [key, asset] of Object.entries(feed.assets)) {
    const file = path.join(dir, decodeURIComponent(path.posix.basename(new URL(asset.url).pathname)))

    if (!(await fileMatches(file, asset.sha256, asset.bytes))) {
      throw new ReleaseError(`${key}: ${file} is missing or does not match the feed`)
    }
  }

  return feed
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)

  return index >= 0 ? args[index + 1] : undefined
}

async function build(args: string[]) {
  const out = option(args, '--out')

  if (!out) {
    throw new ReleaseError('build needs --out <dir> (the download site folder, e.g. AgentX-Landing/public/install)')
  }

  const releaseDir = path.resolve(option(args, '--release-dir') ?? path.join(DESKTOP_ROOT, 'release'))
  const baseUrl = option(args, '--base-url') ?? APP_DOWNLOAD_BASE_URL
  const version = productVersion()
  const notesFile = option(args, '--notes') ?? path.join(DESKTOP_ROOT, 'release-notes', `${version}.md`)
  const stamp = readBuildStamp()
  const privateKeyPem = loadSigningKey(option(args, '--key') ?? keyPath(), APP_RELEASE_PUBLIC_KEY)

  if (!fs.existsSync(notesFile)) {
    throw new ReleaseError(`no release notes at ${notesFile}`)
  }

  const notes = parseReleaseNotes(fs.readFileSync(notesFile, 'utf8'))

  console.log(`→ Workmate ${version}, agent ${stamp.commit.slice(0, 10)}`)
  await assertStampOnOriginMain(stamp.commit)

  const artifacts: FeedArtifact[] = []

  for (const { key, file } of ARTIFACTS) {
    const full = path.join(releaseDir, file)

    if (!fs.existsSync(full)) {
      throw new ReleaseError(`missing ${full}; build both installers before publishing`)
    }

    if (key.startsWith('darwin')) {
      await checkMacInstaller(full, version, stamp.commit)
    } else {
      checkWindowsInstaller(full, version, stamp.commit, releaseDir)
    }

    artifacts.push(describeArtifact(key, full))
    console.log(`  ✓ ${file} (${(artifacts.at(-1)!.bytes / 1024 / 1024).toFixed(1)} MB)`)
  }

  const feed = buildSignedFeed({
    version,
    notes,
    artifacts,
    baseUrl,
    privateKeyPem,
    publicKeyPem: APP_RELEASE_PUBLIC_KEY
  })

  const outDir = path.resolve(out)

  fs.mkdirSync(outDir, { recursive: true })

  for (const artifact of artifacts) {
    const target = path.join(outDir, path.basename(artifact.file))

    if (path.resolve(artifact.file) !== target) {
      fs.copyFileSync(artifact.file, target)
    }
  }

  fs.writeFileSync(path.join(outDir, FEED_FILE), `${JSON.stringify(feed, null, 2)}\n`)
  await verifyReleaseDir(outDir)
  console.log(`✓ Signed ${FEED_FILE} for ${version} in ${outDir}`)
  console.log('  Deploy that folder to publish (AgentX-Landing: ./deploy/deploy.sh <user@host>).')
}

async function main(argv: string[]) {
  const [command, ...args] = argv

  if (command === 'keygen') {
    const file = option(args, '--key') ?? keyPath()
    const publicPem = generateSigningKey(file)

    console.log(`✓ Wrote the release signing key to ${file} (keep a backup; it is never regenerated).`)
    console.log('  Put this public key in APP_RELEASE_PUBLIC_KEY (electron/app-update/feed.ts):\n')
    console.log(publicPem)

    return
  }

  if (command === 'build') {
    await build(args)

    return
  }

  if (command === 'verify' && args[0]) {
    const feed = await verifyReleaseDir(path.resolve(args[0]))

    console.log(`✓ ${FEED_FILE} for ${feed.version} verifies, and so does every installer it names`)

    return
  }

  throw new ReleaseError('usage: release-feed.ts keygen [--key <file>] | build --out <dir> [...] | verify <dir>')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
