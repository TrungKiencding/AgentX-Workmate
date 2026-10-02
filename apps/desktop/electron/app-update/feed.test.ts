import { generateKeyPairSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { signEd25519 } from '../signed-manifest'

import {
  APP_RELEASE_FEED_URL,
  APP_RELEASE_PUBLIC_KEY,
  AppReleaseFeedError,
  assetKeyFor,
  isNewerRelease,
  parseAppReleaseFeed,
  releaseNotesFor,
  verifyAppReleaseFeed
} from './feed'

const SHA = 'a'.repeat(64)

function sampleFeed(): Record<string, any> {
  return {
    schema: 1,
    product: 'agentx-workmate',
    version: '1.0.4',
    publishedAt: '2026-10-02T03:00:00.000Z',
    notes: { vi: ['Cập nhật ngay trong ứng dụng'], en: ['Update from inside the app'] },
    assets: {
      'darwin-arm64': { url: 'https://example.test/install/AgentXWorkmate-mac-arm64.dmg', sha256: SHA, bytes: 10 },
      'win32-x64': { url: 'https://example.test/install/AgentXWorkmate-win-x64.exe', sha256: SHA, bytes: 20 }
    }
  }
}

function signed(feed: Record<string, any>) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string

  return { feed: { ...feed, signature: signEd25519(feed, privatePem) }, publicPem }
}

function problem(mutate: (feed: Record<string, any>) => void, options = {}): string {
  const feed = sampleFeed()

  mutate(feed)

  try {
    parseAppReleaseFeed(feed, options)
  } catch (error) {
    expect(error).toBeInstanceOf(AppReleaseFeedError)

    return (error as Error).message
  }

  return 'accepted'
}

describe('Workmate release feed', () => {
  it('parses a well-formed feed', () => {
    const feed = parseAppReleaseFeed(sampleFeed())

    expect(feed.version).toBe('1.0.4')
    expect(Object.keys(feed.assets)).toEqual(['darwin-arm64', 'win32-x64'])
    expect(feed.notes.vi).toEqual(['Cập nhật ngay trong ứng dụng'])
  })

  it('names the first problem with a malformed feed', () => {
    expect(problem(feed => (feed.schema = 2))).toMatch(/schema 2/)
    expect(problem(feed => (feed.product = 'agentx-webmate'))).toMatch(/agentx-webmate/)
    expect(problem(feed => (feed.version = 'v1.0.4'))).toMatch(/MAJOR.MINOR.PATCH/)
    expect(problem(feed => (feed.publishedAt = 'soon'))).toMatch(/publishedAt/)
    expect(problem(feed => (feed.assets = {}))).toMatch(/no installers/)
    expect(problem(feed => (feed.assets['darwin-universal'] = feed.assets['darwin-arm64']))).toMatch(/darwin-universal/)
    expect(problem(feed => (feed.assets['win32-x64'].sha256 = 'abc'))).toMatch(/sha256/)
    expect(problem(feed => (feed.assets['win32-x64'].bytes = 0))).toMatch(/bytes/)
    expect(problem(feed => (feed.assets['win32-x64'].url = 'not a url'))).toMatch(/not a URL/)
    expect(problem(feed => (feed.notes = { vi: ['x'] }))).toMatch(/notes.en is missing/)
    expect(problem(feed => (feed.notes.en = []))).toMatch(/notes.en/)
    expect(problem(feed => (feed.notes.en = ['  ']))).toMatch(/notes.en/)
    expect(problem(feed => (feed.notes.en = Array.from({ length: 21 }, () => 'x')))).toMatch(/notes.en/)
    expect(problem(feed => (feed.notes['Tiếng Việt'] = ['x']))).toMatch(/locale/)
    expect(problem(() => undefined)).toBe('accepted')
  })

  it('requires https installers, allowing loopback http only when asked', () => {
    const http = (host: string) => (feed: Record<string, any>) =>
      (feed.assets['win32-x64'].url = `http://${host}:8080/AgentXWorkmate-win-x64.exe`)

    expect(problem(http('example.test'))).toMatch(/must be https/)
    expect(problem(http('127.0.0.1'))).toMatch(/must be https/)
    expect(problem(http('127.0.0.1'), { allowLoopbackHttp: true })).toBe('accepted')
    expect(problem(http('localhost'), { allowLoopbackHttp: true })).toBe('accepted')
    expect(problem(http('example.test'), { allowLoopbackHttp: true })).toMatch(/must be https/)
  })

  it('accepts a feed only with a signature from the release key', () => {
    const { feed, publicPem } = signed(sampleFeed())

    expect(verifyAppReleaseFeed(feed, publicPem).version).toBe('1.0.4')
    expect(() => verifyAppReleaseFeed({ ...feed, version: '1.0.5' }, publicPem)).toThrow(/signature/)
    expect(() => verifyAppReleaseFeed(sampleFeed(), publicPem)).toThrow(/signature/)
    // Signed, but by a key that is not Workmate's.
    expect(() => verifyAppReleaseFeed(feed)).toThrow(/signature/)
  })

  it('ships a real Ed25519 public key and the download-site feed URL', () => {
    expect(APP_RELEASE_PUBLIC_KEY).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----\n$/)
    expect(APP_RELEASE_FEED_URL).toBe('https://agentx-landingpage.astralx.com.vn/install/release.json')
  })

  it('compares against the running version', () => {
    expect(isNewerRelease({ version: '1.0.4' }, '1.0.3')).toBe(true)
    expect(isNewerRelease({ version: '1.0.4' }, '1.0.4')).toBe(false)
    expect(isNewerRelease({ version: '1.0.3' }, '1.0.4')).toBe(false)
    expect(assetKeyFor('darwin', 'arm64')).toBe('darwin-arm64')
  })

  it('picks notes for a locale, then its language, then English, then Vietnamese', () => {
    const notes = { vi: ['vi'], en: ['en'], zh: ['zh'] }

    expect(releaseNotesFor(notes, 'vi')).toEqual(['vi'])
    expect(releaseNotesFor(notes, 'zh-hant')).toEqual(['zh'])
    expect(releaseNotesFor(notes, 'ja')).toEqual(['en'])
    expect(releaseNotesFor({ vi: ['vi'] }, 'ja')).toEqual(['vi'])
  })
})
