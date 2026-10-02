import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { verifyAppReleaseFeed } from '../electron/app-update/feed'

import {
  assertStampOnOriginMain,
  buildSignedFeed,
  checkMacInstaller,
  checkWindowsInstaller,
  describeArtifact,
  generateSigningKey,
  loadSigningKey,
  parseReleaseNotes,
  productVersion,
  readBuildStamp,
  ReleaseError,
  type Run,
  verifyReleaseDir
} from './release-feed'

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
})
