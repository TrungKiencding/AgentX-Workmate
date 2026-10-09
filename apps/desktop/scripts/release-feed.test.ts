import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { FetchLike } from '../electron/app-update/download'
import { verifyAppReleaseFeed } from '../electron/app-update/feed'
import { sha256Hex } from '../electron/signed-manifest'

import {
  assertStampOnOriginMain,
  buildFromGitHub,
  buildSignedFeed,
  checkMacInstaller,
  checkWindowsInstaller,
  describeArtifact,
  generateSigningKey,
  type GitHubBuildOptions,
  loadSigningKey,
  parseReleaseNotes,
  productVersion,
  readBuildStamp,
  readGitHubRelease,
  releaseAsset,
  ReleaseError,
  type Run,
  verifyReleaseDir,
  writeReleaseDir
} from './release-feed'
import { readWinBuild, winBuildManifest } from './write-win-build-manifest.mjs'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-release-feed-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function testKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')

  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string
  }
}

const NOTES = { vi: ['Cập nhật ngay trong ứng dụng'], en: ['Update from inside the app'] }
const COMMIT = 'a'.repeat(40)

function writeFile(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

describe('release notes', () => {
  it('reads one bullet list per locale heading and ignores everything else', () => {
    const notes = parseReleaseNotes(
      [
        '# AgentX Workmate 1.0.4',
        '',
        'Intro text that is not a note.',
        '',
        '## vi',
        '- Cập nhật ngay trong ứng dụng',
        '* Đăng nhập giữ 14 ngày  ',
        '',
        '## EN',
        '- Update from inside the app',
        '- Sign-in lasts 14 days'
      ].join('\n')
    )

    expect(notes).toEqual({
      vi: ['Cập nhật ngay trong ứng dụng', 'Đăng nhập giữ 14 ngày'],
      en: ['Update from inside the app', 'Sign-in lasts 14 days']
    })
  })
})

describe('signing key', () => {
  it('is created private, never overwritten, and checked against the key the app trusts', () => {
    const file = path.join(dir, 'keys', 'release-signing-key.pem')
    const publicPem = generateSigningKey(file)

    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(() => generateSigningKey(file)).toThrow(ReleaseError)
    expect(loadSigningKey(file, publicPem)).toContain('PRIVATE KEY')
    expect(() => loadSigningKey(file, testKeys().publicPem)).toThrow(/not the key the app trusts/)
    expect(() => loadSigningKey(path.join(dir, 'missing.pem'), publicPem)).toThrow(/no release signing key/)
  })
})

describe('build checks', () => {
  it('requires the desktop version to be the product version', () => {
    writeFile(path.join(dir, 'desktop', 'package.json'), JSON.stringify({ version: '1.0.4' }))
    writeFile(path.join(dir, 'repo', 'hermes_cli', '__init__.py'), '__version__ = "1.0.4"\n')

    expect(productVersion(path.join(dir, 'desktop'), path.join(dir, 'repo'))).toBe('1.0.4')

    writeFile(path.join(dir, 'repo', 'hermes_cli', '__init__.py'), '__version__ = "1.0.3"\n')

    expect(() => productVersion(path.join(dir, 'desktop'), path.join(dir, 'repo'))).toThrow(/--sync-versions/)
  })

  it('refuses a build stamp that is dirty or a fallback', () => {
    const stamp = (value: object) => writeFile(path.join(dir, 'build', 'install-stamp.json'), JSON.stringify(value))

    stamp({ commit: COMMIT, dirty: false })
    expect(readBuildStamp(dir)).toEqual({ commit: COMMIT, dirty: false })

    stamp({ commit: COMMIT, dirty: true })
    expect(() => readBuildStamp(dir)).toThrow(/dirty/)

    stamp({ commit: '0'.repeat(7), dirty: false })
    expect(() => readBuildStamp(dir)).toThrow(/no commit/)
  })

  it('requires the stamped commit to be on origin/main', async () => {
    const calls: string[] = []

    const run =
      (onMain: boolean): Run =>
      async (file, args) => {
        calls.push([file, ...args].join(' '))

        if (args[0] === 'merge-base' && !onMain) {
          throw new Error('exit 1')
        }

        return { stdout: '' }
      }

    await expect(assertStampOnOriginMain(COMMIT, run(true), dir)).resolves.toBeUndefined()
    expect(calls).toEqual(['git fetch --quiet origin main', `git merge-base --is-ancestor ${COMMIT} origin/main`])
    await expect(assertStampOnOriginMain(COMMIT, run(false), dir)).rejects.toThrow(/not on origin\/main/)
  })

  it('checks the app inside the disk image for the version and the stamp, and always detaches', async () => {
    const detached: string[] = []

    const run =
      (version: string, commit: string): Run =>
      async (file, args) => {
        if (args[0] === 'attach') {
          const mount = args[args.indexOf('-mountpoint') + 1]
          const app = path.join(mount, 'AgentX Workmate.app', 'Contents')

          writeFile(path.join(app, 'Info.plist'), 'plist')
          writeFile(path.join(app, 'Resources', 'install-stamp.json'), JSON.stringify({ commit }))
        }

        if (args[0] === 'detach') {
          detached.push(args.at(-1)!)
        }

        if (file.endsWith('plutil')) {
          return { stdout: JSON.stringify({ CFBundleShortVersionString: version }) }
        }

        return { stdout: '' }
      }

    await expect(checkMacInstaller('x.dmg', '1.0.4', COMMIT, run('1.0.4', COMMIT))).resolves.toBeUndefined()
    await expect(checkMacInstaller('x.dmg', '1.0.4', COMMIT, run('1.0.3', COMMIT))).rejects.toThrow(/version 1.0.3/)
    await expect(checkMacInstaller('x.dmg', '1.0.4', COMMIT, run('1.0.4', 'b'.repeat(40)))).rejects.toThrow(/pins/)
    expect(detached).toHaveLength(3)
  })

  it('checks the Windows installer’s version and the stamp it was packed with', () => {
    writeFile(path.join(dir, 'win-unpacked', 'resources', 'install-stamp.json'), JSON.stringify({ commit: COMMIT }))

    const strings = (version: string) => () => ({ ProductVersion: version })

    expect(() => checkWindowsInstaller('setup.exe', '1.0.4', COMMIT, dir, strings('1.0.4'))).not.toThrow()
    expect(() => checkWindowsInstaller('setup.exe', '1.0.4', COMMIT, dir, strings('1.0.3'))).toThrow(/version 1.0.3/)
    expect(() => checkWindowsInstaller('setup.exe', '1.0.4', 'c'.repeat(40), dir, strings('1.0.4'))).toThrow(/pins/)
  })
})

describe('the signed feed', () => {
  function artifacts() {
    writeFile(path.join(dir, 'AgentXWorkmate-mac-arm64.dmg'), Buffer.from('mac installer'))
    writeFile(path.join(dir, 'AgentXWorkmate-win-x64.exe'), Buffer.from('windows installer'))

    return [
      describeArtifact('darwin-arm64', path.join(dir, 'AgentXWorkmate-mac-arm64.dmg')),
      describeArtifact('win32-x64', path.join(dir, 'AgentXWorkmate-win-x64.exe'))
    ]
  }

  it('is accepted by the app and names every installer beside it', async () => {
    const keys = testKeys()

    const feed = buildSignedFeed({
      version: '1.0.4',
      notes: NOTES,
      artifacts: artifacts(),
      baseUrl: 'https://downloads.example.test/install/',
      privateKeyPem: keys.privatePem,
      publicKeyPem: keys.publicPem,
      publishedAt: '2026-10-02T03:00:00.000Z'
    })

    expect(verifyAppReleaseFeed(feed, keys.publicPem).assets['win32-x64']).toEqual({
      url: 'https://downloads.example.test/install/AgentXWorkmate-win-x64.exe',
      sha256: describeArtifact('win32-x64', path.join(dir, 'AgentXWorkmate-win-x64.exe')).sha256,
      bytes: 'windows installer'.length
    })

    writeFile(path.join(dir, 'release.json'), JSON.stringify(feed, null, 2))

    await expect(verifyReleaseDir(dir, keys.publicPem)).resolves.toMatchObject({ version: '1.0.4' })

    // A replaced installer no longer matches the signed feed.
    writeFile(path.join(dir, 'AgentXWorkmate-win-x64.exe'), Buffer.from('something else'))
    await expect(verifyReleaseDir(dir, keys.publicPem)).rejects.toThrow(/win32-x64/)
  })

  it('is refused when the app would refuse it', () => {
    const keys = testKeys()

    const base = {
      version: '1.0.4',
      baseUrl: 'https://x.test',
      privateKeyPem: keys.privatePem,
      publicKeyPem: keys.publicPem
    }

    expect(() => buildSignedFeed({ ...base, notes: { vi: ['x'] }, artifacts: artifacts() })).toThrow(/notes.en/)
    expect(() => buildSignedFeed({ ...base, notes: NOTES, artifacts: [] })).toThrow(/no installers/)
    expect(() =>
      buildSignedFeed({ ...base, notes: NOTES, artifacts: artifacts(), publicKeyPem: testKeys().publicPem })
    ).toThrow(/signature/)
  })

  it('replaces an installer already in the folder instead of writing through it', async () => {
    const keys = testKeys()
    const outDir = path.join(dir, 'site')
    const kept = path.join(dir, 'kept', 'AgentXWorkmate-win-x64.exe')

    // The download folder's installer is a hard link to an earlier release kept elsewhere.
    writeFile(kept, 'the installer an earlier release shipped')
    fs.mkdirSync(outDir)
    fs.linkSync(kept, path.join(outDir, 'AgentXWorkmate-win-x64.exe'))

    await writeReleaseDir({
      outDir,
      version: '1.0.4',
      notes: NOTES,
      artifacts: artifacts(),
      baseUrl: 'https://downloads.example.test/install',
      privateKeyPem: keys.privatePem,
      publicKeyPem: keys.publicPem
    })

    expect(fs.readFileSync(kept, 'utf8')).toBe('the installer an earlier release shipped')
    expect(fs.readFileSync(path.join(outDir, 'AgentXWorkmate-win-x64.exe'), 'utf8')).toBe('windows installer')
    expect(fs.readdirSync(outDir).sort()).toEqual([
      'AgentXWorkmate-mac-arm64.dmg',
      'AgentXWorkmate-win-x64.exe',
      'release.json'
    ])
  })
})

describe('build --from-github', () => {
  const TAG = 'desktop-v1.0.9'
  const TAG_OBJECT = 'f'.repeat(40)
  const OTHER_COMMIT = 'b'.repeat(40)
  const DMG = Buffer.from('mac installer built by CI')
  const EXE = Buffer.from('windows installer built by CI')
  const DMG_ASSET = 'AgentXWorkmate-1.0.9-mac-arm64.dmg'
  const EXE_ASSET = 'AgentXWorkmate-1.0.9-win-x64.exe'
  const MANIFEST_ASSET = 'AgentXWorkmate-1.0.9-win-build.json'

  /** What scripts/write-win-build-manifest.mjs writes in CI beside the Windows installer `exe`. */
  async function ciManifest(options: { commit?: string; exe?: Buffer } = {}) {
    const releaseDir = fs.mkdtempSync(path.join(dir, 'ci-release-'))

    writeFile(
      path.join(releaseDir, 'win-unpacked', 'resources', 'install-stamp.json'),
      JSON.stringify({ schemaVersion: 1, commit: options.commit ?? COMMIT, branch: TAG, dirty: false, source: 'ci' })
    )
    writeFile(path.join(releaseDir, EXE_ASSET), options.exe ?? EXE)

    const env = {
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'TrungKiencding/AgentX-Workmate',
      GITHUB_RUN_ID: '7',
      GITHUB_RUN_ATTEMPT: '1'
    }

    return Buffer.from(
      JSON.stringify(winBuildManifest({ version: '1.0.9', ...(await readWinBuild(releaseDir, '1.0.9')), env }))
    )
  }

  interface FakeRelease {
    assets: Record<string, Buffer>
    /** Digests GitHub reports in place of the assets' own. */
    digests?: Record<string, string>
    onMain?: boolean
    /** apps/desktop/package.json and hermes_cli/__init__.py at the tagged commit. */
    committed?: { app: string; product: string }
    dmg?: { version?: string; commit?: string }
    exeVersion?: string
  }

  async function ciRelease(): Promise<FakeRelease> {
    return {
      assets: {
        [DMG_ASSET]: DMG,
        'AgentXWorkmate-1.0.9-mac-arm64.zip': Buffer.from('mac zip'),
        [EXE_ASSET]: EXE,
        'AgentXWorkmate-1.0.9-win-arm64.exe': Buffer.from('windows arm64 installer'),
        [MANIFEST_ASSET]: await ciManifest()
      }
    }
  }

  /** GitHub, git, hdiutil and the exe's version resource as one release presents them. */
  function fakeRelease(release: FakeRelease) {
    const calls: string[] = []
    const downloads: string[] = []
    const mounted: string[] = []
    const versionsRead: string[] = []
    const json = (value: unknown) => ({ stdout: JSON.stringify(value) })

    const assets = Object.entries(release.assets).map(([name, data]) => ({
      name,
      size: data.length,
      state: 'uploaded',
      digest: release.digests?.[name] ?? `sha256:${sha256Hex(data)}`,
      browser_download_url: `https://github.com/TrungKiencding/AgentX-Workmate/releases/download/${TAG}/${name}`
    }))

    const run: Run = async (file, args) => {
      calls.push([path.basename(file), ...args].join(' '))

      if (file === 'gh') {
        const endpoint = args[1].replace('repos/TrungKiencding/AgentX-Workmate/', '')

        if (endpoint === `releases/tags/${TAG}`) {
          return json({ tag_name: TAG, assets })
        }

        if (endpoint === `git/ref/tags/${TAG}`) {
          return json({ object: { type: 'tag', sha: TAG_OBJECT } })
        }

        if (endpoint === `git/tags/${TAG_OBJECT}`) {
          return json({ object: { type: 'commit', sha: COMMIT } })
        }

        throw Object.assign(new Error(`Command failed: gh ${args.join(' ')}`), { stderr: 'gh: Not Found (HTTP 404)\n' })
      }

      if (file === 'git') {
        if (args[0] === 'merge-base' && release.onMain === false) {
          throw new Error('exit 1')
        }

        if (args[0] === 'show') {
          const { app, product } = release.committed ?? { app: '1.0.9', product: '1.0.9' }

          return {
            stdout: args[1].endsWith('package.json') ? JSON.stringify({ version: app }) : `__version__ = "${product}"\n`
          }
        }

        return { stdout: '' }
      }

      if (args[0] === 'attach') {
        const app = path.join(args[args.indexOf('-mountpoint') + 1], 'AgentX Workmate.app', 'Contents')

        mounted.push(args.at(-1)!)
        writeFile(path.join(app, 'Info.plist'), 'plist')
        writeFile(
          path.join(app, 'Resources', 'install-stamp.json'),
          JSON.stringify({ commit: release.dmg?.commit ?? COMMIT })
        )
      }

      if (file.endsWith('plutil')) {
        return json({ CFBundleShortVersionString: release.dmg?.version ?? '1.0.9' })
      }

      return { stdout: '' }
    }

    const fetch: FetchLike = async url => {
      const name = decodeURIComponent(url.split('/').at(-1)!)
      const data = release.assets[name]

      downloads.push(name)

      return data
        ? new Response(new Uint8Array(data), { headers: { 'content-length': String(data.length) } })
        : new Response('Not Found', { status: 404 })
    }

    const readVersionStrings = (file: string) => {
      versionsRead.push(file)

      return { ProductVersion: release.exeVersion ?? '1.0.9' }
    }

    return { run, fetch, readVersionStrings, calls, downloads, mounted, versionsRead }
  }

  function optionsFor(fake: ReturnType<typeof fakeRelease>, keys = testKeys()): GitHubBuildOptions {
    writeFile(
      path.join(dir, 'desktop', 'release-notes', '1.0.9.md'),
      '# AgentX Workmate 1.0.9\n\n## vi\n- Bản phát hành mới\n\n## en\n- A new release\n'
    )

    return {
      tag: TAG,
      outDir: path.join(dir, 'site', 'install'),
      downloadDir: path.join(dir, 'downloads'),
      privateKeyPem: keys.privatePem,
      publicKeyPem: keys.publicPem,
      baseUrl: 'https://downloads.example.test/install',
      run: fake.run,
      download: { fetch: fake.fetch, sleep: async () => undefined },
      readVersionStrings: fake.readVersionStrings,
      log: () => undefined,
      desktopRoot: path.join(dir, 'desktop'),
      repoRoot: dir
    }
  }

  it('publishes the installers CI attached to the release, checked as a local build is', async () => {
    const keys = testKeys()
    const fake = fakeRelease(await ciRelease())
    const options = optionsFor(fake, keys)
    const downloadDir = options.downloadDir!

    await expect(buildFromGitHub(options)).resolves.toMatchObject({ version: '1.0.9' })

    expect(fs.readdirSync(options.outDir).sort()).toEqual([
      'AgentXWorkmate-mac-arm64.dmg',
      'AgentXWorkmate-win-x64.exe',
      'release.json'
    ])
    expect(fs.readFileSync(path.join(options.outDir, 'AgentXWorkmate-mac-arm64.dmg'))).toEqual(DMG)
    expect(fs.readFileSync(path.join(options.outDir, 'AgentXWorkmate-win-x64.exe'))).toEqual(EXE)

    const feed = verifyAppReleaseFeed(
      JSON.parse(fs.readFileSync(path.join(options.outDir, 'release.json'), 'utf8')),
      keys.publicPem
    )

    expect(feed.notes).toEqual({ vi: ['Bản phát hành mới'], en: ['A new release'] })
    expect(feed.assets['win32-x64']).toEqual({
      url: 'https://downloads.example.test/install/AgentXWorkmate-win-x64.exe',
      sha256: sha256Hex(EXE),
      bytes: EXE.length
    })

    // The tagged commit stands in for the build stamp...
    expect(fake.calls).toContain(`git merge-base --is-ancestor ${COMMIT} origin/main`)
    expect(fake.calls).toContain(`git show ${COMMIT}:hermes_cli/__init__.py`)
    // ...and what was checked is what was downloaded: the dmg mounted, the exe's version read.
    expect(fake.downloads).toEqual([MANIFEST_ASSET, DMG_ASSET, EXE_ASSET])
    expect(fake.mounted).toEqual([path.join(downloadDir, 'AgentXWorkmate-mac-arm64.dmg')])
    expect(fake.versionsRead).toEqual([path.join(downloadDir, 'AgentXWorkmate-win-x64.exe')])

    // Running it again uses the downloads it already has.
    await buildFromGitHub(options)
    expect(fake.downloads).toHaveLength(3)
  })

  it('refuses a tag the release cannot be traced to, before downloading anything', async () => {
    const release = await ciRelease()

    const refusals: [Partial<FakeRelease>, RegExp][] = [
      [{ onMain: false }, /aaaaaaaaaa is not on origin\/main/],
      [
        { committed: { app: '1.0.9', product: '1.0.8' } },
        /at aaaaaaaaaa, apps\/desktop\/package.json says 1.0.9 but hermes_cli\/__init__.py says 1.0.8/
      ],
      [{ committed: { app: '1.0.8', product: '1.0.8' } }, /desktop-v1.0.9 points at aaaaaaaaaa, whose version is 1.0.8/]
    ]

    for (const [override, message] of refusals) {
      const fake = fakeRelease({ ...release, ...override })
      const options = optionsFor(fake)

      await expect(buildFromGitHub(options)).rejects.toThrow(message)
      expect(fake.downloads).toEqual([])
      expect(fs.existsSync(options.outDir)).toBe(false)
    }

    const fake = fakeRelease(release)

    await expect(buildFromGitHub({ ...optionsFor(fake), tag: 'v1.0.9' })).rejects.toThrow(
      /v1.0.9 is not a desktop release tag/
    )
    await expect(
      buildFromGitHub({
        ...optionsFor(fake),
        tag: 'desktop-v1.0.10',
        notesFile: path.join(dir, 'desktop', 'release-notes', '1.0.9.md')
      })
    ).rejects.toThrow(/releases\/tags\/desktop-v1.0.10 failed: gh: Not Found \(HTTP 404\)/)
    expect(fake.downloads).toEqual([])
  })

  it('refuses a Windows installer that no build manifest vouches for, before downloading it', async () => {
    const refusals: [Buffer | undefined, RegExp][] = [
      [undefined, /has no AgentXWorkmate-1.0.9-win-build.json/],
      [await ciManifest({ commit: OTHER_COMMIT }), /the Windows build pins bbbbbbbbbb, desktop-v1.0.9 is aaaaaaaaaa/],
      [
        await ciManifest({ exe: Buffer.from('a different build') }),
        /AgentXWorkmate-1.0.9-win-x64.exe on GitHub is not the installer AgentXWorkmate-1.0.9-win-build.json describes/
      ]
    ]

    for (const [manifest, message] of refusals) {
      const fake = fakeRelease({
        assets: { [DMG_ASSET]: DMG, [EXE_ASSET]: EXE, ...(manifest ? { [MANIFEST_ASSET]: manifest } : {}) }
      })

      const options = optionsFor(fake)

      await expect(buildFromGitHub(options)).rejects.toThrow(message)
      expect(fake.downloads).toEqual(manifest ? [MANIFEST_ASSET] : [])
      expect(fs.existsSync(options.outDir)).toBe(false)
    }
  })

  it('refuses installers that are not what GitHub reports, carry another version, or pin another commit', async () => {
    const release = await ciRelease()

    const refusals: [Partial<FakeRelease>, RegExp][] = [
      [
        { digests: { [DMG_ASSET]: `sha256:${sha256Hex(Buffer.from('another disk image'))}` } },
        /AgentXWorkmate-1.0.9-mac-arm64.dmg does not hash to the sha256 GitHub reports/
      ],
      [{ dmg: { version: '1.0.8' } }, /AgentXWorkmate-mac-arm64.dmg is version 1.0.8, expected 1.0.9/],
      [{ dmg: { commit: OTHER_COMMIT } }, /AgentXWorkmate-mac-arm64.dmg pins bbbbbbbbbb/],
      [{ exeVersion: '1.0.8' }, /AgentXWorkmate-win-x64.exe is version 1.0.8, expected 1.0.9/]
    ]

    for (const [override, message] of refusals) {
      const fake = fakeRelease({ ...release, ...override })
      const options = optionsFor(fake)

      await expect(buildFromGitHub(options)).rejects.toThrow(message)
      expect(fs.existsSync(options.outDir)).toBe(false)
    }
  })

  it('peels the tag to its commit, and takes only assets GitHub reports a sha256 for', async () => {
    const asset = (name: string, extra: object) => ({
      name,
      size: 3,
      state: 'uploaded',
      digest: `sha256:${'c'.repeat(64)}`,
      browser_download_url: `https://github.test/${name}`,
      ...extra
    })

    const run: Run = async (_file, args) => {
      if (args[1].endsWith('/releases/tags/desktop-v1.0.9')) {
        return {
          stdout: JSON.stringify({
            assets: [asset('a.exe', {}), asset('b.exe', { digest: null }), asset('c.exe', { state: 'open' })]
          })
        }
      }

      // A lightweight tag points straight at the commit.
      return { stdout: JSON.stringify({ object: { type: 'commit', sha: COMMIT } }) }
    }

    const release = await readGitHubRelease('desktop-v1.0.9', run)

    expect(release.commit).toBe(COMMIT)
    expect(releaseAsset(release, 'a.exe')).toEqual({
      name: 'a.exe',
      url: 'https://github.test/a.exe',
      sha256: 'c'.repeat(64),
      bytes: 3
    })
    expect(() => releaseAsset(release, 'b.exe')).toThrow(/no sha256 digest/)
    expect(() => releaseAsset(release, 'c.exe')).toThrow(/not fully uploaded/)
    expect(() => releaseAsset(release, 'd.exe')).toThrow(/has no d.exe/)
  })
})
