#!/usr/bin/env tsx
/**
 * Publish a Workmate release to the download site: sign `release.json` for the
 * installers that were just built, so every installed app can offer the update.
 *
 *   npm run release:feed -- keygen
 *   npm run release:feed -- build --out ~/Desktop/AgentX-Landing/public/install
 *   npm run release:feed -- build --from-github desktop-v1.0.9 --out ~/Desktop/AgentX-Landing/public/install
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
 * `build --from-github <tag>` publishes the installers CI attached to that GitHub
 * Release (.github/workflows/release-desktop.yml) instead of ones built here. It
 * downloads them, resuming when the connection drops, requires each to hash to the
 * digest GitHub computed on upload, and makes the same checks with the tagged
 * commit in place of the build stamp. The Windows installer's stamp comes from the
 * build manifest CI attaches beside it (scripts/write-win-build-manifest.mjs),
 * which records that installer by sha256.
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

import { downloadAsset, type DownloadOptions, megabytes, type ReleaseAsset } from './release-download'
import { readPeIdentity } from './win-exe-identity.mjs'
import { winBuildManifestName } from './write-win-build-manifest.mjs'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')

export const DEFAULT_KEY_PATH = path.join(os.homedir(), '.config', 'agentx-workmate', 'release-signing-key.pem')
export const FEED_FILE = 'release.json'

/** The installers a release publishes, by asset key. Names match the download page. */
export const ARTIFACTS = [
  { key: 'darwin-arm64', file: 'AgentXWorkmate-mac-arm64.dmg' },
  { key: 'win32-x64', file: 'AgentXWorkmate-win-x64.exe' }
] as const

/** Where release-desktop.yml attaches the installers it builds for a `desktop-v<version>` tag. */
export const GITHUB_REPOSITORY = 'TrungKiencding/AgentX-Workmate'

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

/** What a failed command said: its stderr when it has one (gh and git explain themselves there). */
function commandError(error: unknown): string {
  const stderr = String((error as { stderr?: unknown })?.stderr ?? '').trim()

  return stderr || (error instanceof Error ? error.message : String(error))
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

function agreedVersion(version: string, init: string, where = ''): string {
  const product = /__version__\s*=\s*["']([^"']+)["']/.exec(init)?.[1]

  if (version !== product) {
    throw new ReleaseError(
      `${where}apps/desktop/package.json says ${version} but hermes_cli/__init__.py says ${product}; run scripts/release.py --sync-versions`
    )
  }

  return version
}

/** package.json's version, which must be the product version release.py syncs. */
export function productVersion(desktopRoot = DESKTOP_ROOT, repoRoot = REPO_ROOT): string {
  const version = String(readJson(path.join(desktopRoot, 'package.json')).version || '')

  return agreedVersion(version, fs.readFileSync(path.join(repoRoot, 'hermes_cli', '__init__.py'), 'utf8'))
}

/** The same check at `commit`, read from git: what a release built there carries. */
export async function productVersionAt(commit: string, run: Run = defaultRun, repoRoot = REPO_ROOT): Promise<string> {
  const at = `at ${commit.slice(0, 10)}`

  const show = async (file: string) => {
    try {
      return (await run('git', ['show', `${commit}:${file}`], { cwd: repoRoot })).stdout
    } catch (error) {
      throw new ReleaseError(`could not read ${file} ${at}: ${commandError(error)}`)
    }
  }

  const packageJson = await show('apps/desktop/package.json')
  let version: string

  try {
    version = String(JSON.parse(packageJson).version || '')
  } catch {
    throw new ReleaseError(`apps/desktop/package.json ${at} is not JSON`)
  }

  return agreedVersion(version, await show('hermes_cli/__init__.py'), `${at}, `)
}

function checkBuildStamp(stamp: any, file: string): BuildStamp {
  if (!/^[0-9a-f]{40}$/.test(String(stamp?.commit))) {
    throw new ReleaseError(`${file} has no commit; was this a fallback build?`)
  }

  if (stamp.dirty !== false) {
    throw new ReleaseError(`the installers were built from a dirty tree (${file} dirty: ${stamp.dirty})`)
  }

  return { commit: stamp.commit, dirty: false }
}

export function readBuildStamp(desktopRoot = DESKTOP_ROOT): BuildStamp {
  return checkBuildStamp(readJson(path.join(desktopRoot, 'build', 'install-stamp.json')), 'build/install-stamp.json')
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

type ReadVersionStrings = (file: string) => Record<string, string>

const readExeVersionStrings: ReadVersionStrings = file => readPeIdentity(fs.readFileSync(file)).versionStrings || {}

/** The NSIS installer's version resource. */
export function checkWindowsInstallerVersion(
  exe: string,
  version: string,
  readVersionStrings: ReadVersionStrings = readExeVersionStrings
) {
  const strings = readVersionStrings(exe)

  if (strings.ProductVersion !== version) {
    throw new ReleaseError(`${path.basename(exe)} is version ${strings.ProductVersion}, expected ${version}`)
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
  readVersionStrings: ReadVersionStrings = readExeVersionStrings
) {
  checkWindowsInstallerVersion(exe, version, readVersionStrings)

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

/**
 * Write `target` under a temporary name and rename it into place: a half-copied
 * installer never sits under the real name, and a hard link already there (an old
 * release kept elsewhere) is replaced instead of written through.
 */
function replaceFile(target: string, write: (temp: string) => void) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`)

  try {
    write(temp)
    fs.renameSync(temp, target)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

/**
 * Sign the feed for `artifacts`, then put each installer (under its own name) and
 * the feed in `outDir` and check the folder as the app will. Nothing is written
 * unless the feed signs.
 */
export async function writeReleaseDir(options: {
  outDir: string
  version: string
  notes: Record<string, string[]>
  artifacts: FeedArtifact[]
  baseUrl: string
  privateKeyPem: string
  publicKeyPem: string
}): Promise<AppReleaseFeed> {
  const { outDir, artifacts, publicKeyPem } = options

  const feed = buildSignedFeed({
    version: options.version,
    notes: options.notes,
    artifacts,
    baseUrl: options.baseUrl,
    privateKeyPem: options.privateKeyPem,
    publicKeyPem
  })

  fs.mkdirSync(outDir, { recursive: true })

  for (const artifact of artifacts) {
    const target = path.resolve(outDir, path.basename(artifact.file))

    if (path.resolve(artifact.file) !== target) {
      replaceFile(target, temp => fs.copyFileSync(artifact.file, temp, fs.constants.COPYFILE_FICLONE))
    }
  }

  replaceFile(path.join(outDir, FEED_FILE), temp => fs.writeFileSync(temp, `${JSON.stringify(feed, null, 2)}\n`))

  return verifyReleaseDir(outDir, publicKeyPem)
}

// ── GitHub release ──────────────────────────────────────────────────────────

/** `desktop-v1.0.9` → `1.0.9`: the tags release-desktop.yml builds a release for. */
export function tagVersion(tag: string): string {
  const version = /^desktop-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1]

  if (!version) {
    throw new ReleaseError(`${tag || '(no tag)'} is not a desktop release tag (desktop-v<major>.<minor>.<patch>)`)
  }

  return version
}

/** CI names an installer `AgentXWorkmate-<version>-<os>-<arch>.<ext>` (package.json build.artifactName). */
export function githubAssetName(file: string, version: string): string {
  return file.replace(/^AgentXWorkmate-/, `AgentXWorkmate-${version}-`)
}

export interface GitHubRelease {
  tag: string
  /** The commit the tag points at, peeled through an annotated tag. */
  commit: string
  assets: { name: string; size: number; digest: null | string; state: string; url: string }[]
}

/** The GitHub Release for `tag` and its commit, as `gh api` reports them. */
export async function readGitHubRelease(
  tag: string,
  run: Run = defaultRun,
  repository = GITHUB_REPOSITORY
): Promise<GitHubRelease> {
  const api = async (endpoint: string): Promise<any> => {
    const request = `repos/${repository}/${endpoint}`
    let stdout: string

    try {
      stdout = (await run('gh', ['api', request])).stdout
    } catch (error) {
      throw new ReleaseError(`gh api ${request} failed: ${commandError(error)}`)
    }

    try {
      return JSON.parse(stdout)
    } catch {
      throw new ReleaseError(`gh api ${request} did not answer JSON`)
    }
  }

  const release = await api(`releases/tags/${tag}`)
  let target = (await api(`git/ref/tags/${tag}`))?.object

  for (let depth = 0; target?.type === 'tag' && depth < 4; depth++) {
    target = (await api(`git/tags/${target.sha}`))?.object
  }

  if (target?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(String(target.sha))) {
    throw new ReleaseError(`${tag} does not point at a commit`)
  }

  const assets = (Array.isArray(release?.assets) ? release.assets : []).map((asset: any) => ({
    name: String(asset.name),
    size: Number(asset.size),
    digest: typeof asset.digest === 'string' ? asset.digest : null,
    state: String(asset.state ?? 'uploaded'),
    url: String(asset.browser_download_url)
  }))

  return { tag, commit: target.sha, assets }
}

export function releaseAsset(release: GitHubRelease, name: string): ReleaseAsset {
  const asset = release.assets.find(candidate => candidate.name === name)

  if (!asset) {
    throw new ReleaseError(`the GitHub release ${release.tag} has no ${name}`)
  }

  if (asset.state !== 'uploaded') {
    throw new ReleaseError(`${name} on ${release.tag} is not fully uploaded (state ${asset.state})`)
  }

  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1]

  if (!sha256) {
    throw new ReleaseError(`GitHub reports no sha256 digest for ${name}, so there is nothing to check it against`)
  }

  if (!Number.isInteger(asset.size) || asset.size <= 0) {
    throw new ReleaseError(`GitHub reports ${name} as ${asset.size} bytes`)
  }

  return { name, url: asset.url, sha256, bytes: asset.size }
}

/**
 * What CI recorded beside the Windows installers (scripts/write-win-build-manifest.mjs):
 * the stamp they were packed with, and each one's sha256. It stands in for the
 * unpacked build `checkWindowsInstaller` reads, for installers built elsewhere.
 */
export function checkWinBuildManifest(
  raw: unknown,
  expected: { file: string; version: string; tag: string; commit: string; installers: ReleaseAsset[] }
) {
  const manifest = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>

  if (manifest.schema !== 1 || manifest.product !== APP_RELEASE_PRODUCT) {
    throw new ReleaseError(`${expected.file} is not a Workmate Windows build manifest`)
  }

  if (manifest.version !== expected.version) {
    throw new ReleaseError(`${expected.file} is for ${manifest.version}, expected ${expected.version}`)
  }

  const stamp = checkBuildStamp(manifest.stamp, expected.file)

  if (stamp.commit !== expected.commit) {
    throw new ReleaseError(
      `the Windows build pins ${stamp.commit.slice(0, 10)}, ${expected.tag} is ${expected.commit.slice(0, 10)}`
    )
  }

  for (const installer of expected.installers) {
    const recorded = manifest.installers?.[installer.name]

    if (recorded?.sha256 !== installer.sha256 || recorded?.bytes !== installer.bytes) {
      throw new ReleaseError(`${installer.name} on GitHub is not the installer ${expected.file} describes`)
    }
  }
}

export interface GitHubBuildOptions {
  /** `desktop-v<version>`, the tag release-desktop.yml built. */
  tag: string
  outDir: string
  privateKeyPem: string
  publicKeyPem?: string
  /** Kept between runs so an interrupted download resumes; one folder per tag under the temp dir by default. */
  downloadDir?: string
  notesFile?: string
  baseUrl?: string
  repository?: string
  run?: Run
  download?: Omit<DownloadOptions, 'log'>
  readVersionStrings?: ReadVersionStrings
  log?: (line: string) => void
  desktopRoot?: string
  repoRoot?: string
}

/**
 * `build --from-github`: publish the installers CI attached to the GitHub Release for
 * `tag`. The checks are `build`'s, with the tagged commit in place of the build stamp
 * and CI's build manifest in place of the unpacked Windows build. Everything that can
 * refuse without the installers does so before they are downloaded.
 */
export async function buildFromGitHub(options: GitHubBuildOptions): Promise<AppReleaseFeed> {
  const { tag } = options
  const version = tagVersion(tag)
  const run = options.run ?? defaultRun
  const log = options.log ?? console.log
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const downloadDir = options.downloadDir ?? path.join(os.tmpdir(), 'agentx-workmate-release', tag)

  const notesFile =
    options.notesFile ?? path.join(options.desktopRoot ?? DESKTOP_ROOT, 'release-notes', `${version}.md`)

  if (!fs.existsSync(notesFile)) {
    throw new ReleaseError(`no release notes at ${notesFile}`)
  }

  const notes = parseReleaseNotes(fs.readFileSync(notesFile, 'utf8'))
  const release = await readGitHubRelease(tag, run, options.repository)

  const installers = ARTIFACTS.map(artifact => ({
    ...artifact,
    asset: releaseAsset(release, githubAssetName(artifact.file, version))
  }))

  const manifestFile = winBuildManifestName(version)

  if (!release.assets.some(asset => asset.name === manifestFile)) {
    throw new ReleaseError(
      `the GitHub release ${tag} has no ${manifestFile}, the record of which commit its Windows installer pins; ` +
        'a release CI cut before it wrote one cannot be published with --from-github'
    )
  }

  const manifestAsset = releaseAsset(release, manifestFile)

  log(`→ Workmate ${version} from ${tag}, agent ${release.commit.slice(0, 10)}; downloading into ${downloadDir}`)
  await assertStampOnOriginMain(release.commit, run, repoRoot)

  const committed = await productVersionAt(release.commit, run, repoRoot)

  if (committed !== version) {
    throw new ReleaseError(`${tag} points at ${release.commit.slice(0, 10)}, whose version is ${committed}`)
  }

  const download = (asset: ReleaseAsset, file: string) =>
    downloadAsset(asset, path.join(downloadDir, file), { ...options.download, log })

  await download(manifestAsset, manifestFile)

  const manifest = readJson(path.join(downloadDir, manifestFile))

  checkWinBuildManifest(manifest, {
    file: manifestFile,
    version,
    tag,
    commit: release.commit,
    installers: installers.filter(({ key }) => key.startsWith('win32')).map(({ asset }) => asset)
  })
  log(`  ✓ the Windows build pins ${release.commit.slice(0, 10)}${manifest.run ? ` (${manifest.run})` : ''}`)

  const artifacts: FeedArtifact[] = []

  for (const { key, file, asset } of installers) {
    const local = path.join(downloadDir, file)

    await download(asset, file)

    if (key.startsWith('darwin')) {
      await checkMacInstaller(local, version, release.commit, run)
    } else {
      checkWindowsInstallerVersion(local, version, options.readVersionStrings)
    }

    artifacts.push({ key, file: local, sha256: asset.sha256, bytes: asset.bytes })
    log(`  ✓ ${file} (${megabytes(asset.bytes)})`)
  }

  return writeReleaseDir({
    outDir: options.outDir,
    version,
    notes,
    artifacts,
    baseUrl: options.baseUrl ?? APP_DOWNLOAD_BASE_URL,
    privateKeyPem: options.privateKeyPem,
    publicKeyPem: options.publicKeyPem ?? APP_RELEASE_PUBLIC_KEY
  })
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)

  return index >= 0 ? args[index + 1] : undefined
}

function published(version: string, outDir: string) {
  console.log(`✓ Signed ${FEED_FILE} for ${version} in ${outDir}`)
  console.log('  Deploy that folder to publish (AgentX-Landing: ./deploy/deploy.sh <user@host>).')
}

async function buildFromGitHubCommand(args: string[], outDir: string) {
  const tag = option(args, '--from-github') ?? ''

  // A mistyped command line fails before the signing key is read.
  tagVersion(tag)

  if (option(args, '--release-dir')) {
    throw new ReleaseError('--release-dir is for installers built here; --from-github takes the ones CI attached')
  }

  const downloadDir = option(args, '--download-dir')

  const feed = await buildFromGitHub({
    tag,
    outDir,
    downloadDir: downloadDir ? path.resolve(downloadDir) : undefined,
    notesFile: option(args, '--notes'),
    baseUrl: option(args, '--base-url'),
    repository: option(args, '--repo'),
    privateKeyPem: loadSigningKey(option(args, '--key') ?? keyPath(), APP_RELEASE_PUBLIC_KEY)
  })

  published(feed.version, outDir)
}

async function build(args: string[]) {
  const out = option(args, '--out')

  if (!out) {
    throw new ReleaseError('build needs --out <dir> (the download site folder, e.g. AgentX-Landing/public/install)')
  }

  if (args.includes('--from-github')) {
    await buildFromGitHubCommand(args, path.resolve(out))

    return
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
    console.log(`  ✓ ${file} (${megabytes(artifacts.at(-1)!.bytes)})`)
  }

  const outDir = path.resolve(out)

  await writeReleaseDir({
    outDir,
    version,
    notes,
    artifacts,
    baseUrl,
    privateKeyPem,
    publicKeyPem: APP_RELEASE_PUBLIC_KEY
  })
  published(version, outDir)
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

  throw new ReleaseError(
    'usage: release-feed.ts keygen [--key <file>] | build --out <dir> [...] | ' +
      'build --from-github desktop-v<version> --out <dir> [...] | verify <dir>'
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
