import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sha256Hex, signEd25519 } from '../signed-manifest'

import type { FetchLike } from './download'
import { AppUpdater, type AppUpdaterDeps, type InstallResult, type PersistedUpdateState } from './updater'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string
const FEED_URL = 'https://example.test/install/release.json'
const INSTALLER = Buffer.from('the 1.0.4 installer')

function feedFor(version: string, { assets }: { assets?: Record<string, unknown> } = {}) {
  const feed: Record<string, unknown> = {
    schema: 1,
    product: 'agentx-workmate',
    version,
    publishedAt: '2026-10-02T03:00:00.000Z',
    notes: { vi: ['Cập nhật trong ứng dụng'], en: ['Update from the app'] },
    assets: assets ?? {
      'darwin-arm64': {
        url: 'https://example.test/install/AgentXWorkmate-mac-arm64.dmg',
        sha256: sha256Hex(INSTALLER),
        bytes: INSTALLER.length
      }
    }
  }

  return { ...feed, signature: signEd25519(feed, PRIVATE_PEM) }
}

interface Harness {
  updater: AppUpdater
  deps: AppUpdaterDeps
  persisted: PersistedUpdateState
  pruned: string[][]
  fetches: string[]
  broadcasts: number
  setFeed: (feed: unknown) => void
  setInstallerBody: (body: Buffer) => void
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-updater-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function harness(
  overrides: Partial<AppUpdaterDeps> = {},
  {
    persisted = {},
    installResult = null
  }: { persisted?: PersistedUpdateState; installResult?: InstallResult | null } = {}
): Harness {
  let feedBody: unknown = feedFor('1.0.4')
  let installerBody: Buffer = INSTALLER

  const state: Harness = {
    persisted: { ...persisted },
    pruned: [],
    fetches: [],
    broadcasts: 0,
    setFeed: feed => {
      feedBody = feed
    },
    setInstallerBody: body => {
      installerBody = body
    }
  } as Harness

  const fetch: FetchLike = async url => {
    state.fetches.push(url)

    if (url === FEED_URL) {
      if (feedBody instanceof Error) {
        throw feedBody
      }

      return new Response(JSON.stringify(feedBody), { status: 200 })
    }

    return new Response(new Uint8Array(installerBody), { status: 200 })
  }

  const deps: AppUpdaterDeps = {
    currentVersion: '1.0.3',
    platform: 'darwin',
    arch: 'arm64',
    locationBlock: null,
    feedUrl: FEED_URL,
    publicKeyPem: PUBLIC_PEM,
    feedOptions: {},
    downloadDir: path.join(dir, 'updates'),
    fetch,
    handoff: { start: vi.fn(async () => undefined) },
    activeWork: () => ({ count: 0, titles: [] }),
    quit: vi.fn(),
    readPersisted: () => state.persisted,
    writePersisted: next => {
      state.persisted = next
    },
    takeInstallResult: () => installResult,
    pruneDownloads: async keep => {
      const kept = ['1.0.2', '1.0.3', '1.0.4', '1.0.5'].filter(keep)

      state.pruned.push(kept)
    },
    broadcast: () => {
      state.broadcasts += 1
    },
    log: () => undefined,
    now: () => 1_000,
    ...overrides
  }

  state.deps = deps
  state.updater = new AppUpdater(deps)

  return state
}

describe('AppUpdater.initialize', () => {
  it('reports a pending install that took as "updated from"', async () => {
    const h = harness(
      { currentVersion: '1.0.4' },
      {
        persisted: { lastRunVersion: '1.0.3', pendingInstall: { version: '1.0.4', from: '1.0.3', startedAt: 1 } }
      }
    )

    const state = await h.updater.initialize()

    expect(state.updatedFrom).toBe('1.0.3')
    expect(state.lastInstallFailed).toBeNull()
    expect(h.persisted).toEqual({ lastRunVersion: '1.0.4' })
  })

  it("reports a pending install that did not take, with the swap script's reason when there is one", async () => {
    const pending = { lastRunVersion: '1.0.3', pendingInstall: { version: '1.0.4', from: '1.0.3', startedAt: 1 } }

    const withResult = harness(
      {},
      {
        persisted: pending,
        installResult: { version: '1.0.4', ok: false, message: 'the app did not quit in time' }
      }
    )

    const withoutResult = harness({}, { persisted: pending })

    expect((await withResult.updater.initialize()).lastInstallFailed).toEqual({
      version: '1.0.4',
      message: 'the app did not quit in time'
    })
    expect((await withoutResult.updater.initialize()).lastInstallFailed).toEqual({
      version: '1.0.4',
      message: 'the installer did not finish'
    })
    expect(withResult.persisted).toEqual({ lastRunVersion: '1.0.3' })
  })

  it('notices a version installed by hand, and keeps only downloads newer than this one', async () => {
    const h = harness({ currentVersion: '1.0.4' }, { persisted: { lastRunVersion: '1.0.2' } })

    expect((await h.updater.initialize()).updatedFrom).toBe('1.0.2')
    expect(h.pruned).toEqual([['1.0.5']])
  })

  it('says nothing on an ordinary launch', async () => {
    const h = harness({}, { persisted: { lastRunVersion: '1.0.3' } })
    const state = await h.updater.initialize()

    expect(state.updatedFrom).toBeNull()
    expect(state.lastInstallFailed).toBeNull()
  })
})

describe('AppUpdater.check', () => {
  it("finds a newer release with its notes and this machine's installer size", async () => {
    const h = harness()
    const state = await h.updater.check()

    expect(state.phase).toBe('available')
    expect(state.release).toEqual({
      version: '1.0.4',
      publishedAt: '2026-10-02T03:00:00.000Z',
      notes: { vi: ['Cập nhật trong ứng dụng'], en: ['Update from the app'] },
      bytes: INSTALLER.length
    })
    expect(state.blocked).toBeNull()
    expect(state.checking).toBe(false)
    expect(state.checkedAt).toBe(1_000)
    expect(h.pruned.at(-1)).toEqual(['1.0.4'])
  })

  it('is up to date when the feed is not newer, and drops every download', async () => {
    const h = harness()

    h.setFeed(feedFor('1.0.3'))

    const state = await h.updater.check()

    expect(state.phase).toBe('up-to-date')
    expect(state.release).toBeNull()
    expect(h.pruned.at(-1)).toEqual([])
  })

  it('offers no download for a machine the release has no installer for', async () => {
    const h = harness({ platform: 'win32', arch: 'x64' })

    expect((await h.updater.check()).blocked).toBe('no-installer-for-machine')
  })

  it('keeps a location block whatever the release', async () => {
    const h = harness({ locationBlock: 'translocated' })

    expect((await h.updater.check()).blocked).toBe('translocated')
  })

  it('refuses a feed that is not signed by the release key', async () => {
    const h = harness()

    h.setFeed({ ...feedFor('1.0.4'), version: '9.0.0' })

    const state = await h.updater.check()

    expect(state.phase).toBe('idle')
    expect(state.checkError).toMatch(/signature/)
  })

  it('keeps a known release when a later check fails', async () => {
    const h = harness()

    await h.updater.check()
    h.setFeed(new TypeError('fetch failed'))

    const state = await h.updater.check()

    expect(state.phase).toBe('available')
    expect(state.release?.version).toBe('1.0.4')
    expect(state.checkError).toBe('fetch failed')
  })

  it('shares one request between concurrent checks', async () => {
    const h = harness()

    await Promise.all([h.updater.check(), h.updater.check(), h.updater.check()])

    expect(h.fetches.filter(url => url === FEED_URL)).toHaveLength(1)
  })

  it('goes straight to ready when this release was already downloaded and verified', async () => {
    const h = harness()
    const installer = path.join(dir, 'updates', '1.0.4', 'AgentXWorkmate-mac-arm64.dmg')

    fs.mkdirSync(path.dirname(installer), { recursive: true })
    fs.writeFileSync(installer, INSTALLER)

    expect((await h.updater.check()).phase).toBe('ready')
    expect(h.fetches).toEqual([FEED_URL])
  })
})

describe('AppUpdater.download', () => {
  it('downloads and verifies the installer, then is ready', async () => {
    const h = harness()

    await h.updater.check()

    const state = await h.updater.download()

    expect(state.phase).toBe('ready')
    expect(state.progress).toBeNull()
    expect(fs.readFileSync(path.join(dir, 'updates', '1.0.4', 'AgentXWorkmate-mac-arm64.dmg'))).toEqual(INSTALLER)
  })

  it('returns to available with the reason when the download fails verification', async () => {
    const h = harness()

    await h.updater.check()
    h.setInstallerBody(Buffer.from('not the 1.0.4 installer'))

    const state = await h.updater.download()

    expect(state.phase).toBe('available')
    expect(state.downloadError?.kind).toBe('size')
  })

  it('does nothing when there is nothing to download or installing is blocked', async () => {
    const idle = harness()

    expect((await idle.updater.download()).phase).toBe('idle')

    const blocked = harness({ locationBlock: 'not-writable' })

    await blocked.updater.check()

    expect((await blocked.updater.download()).phase).toBe('available')
    expect(blocked.fetches).toEqual([FEED_URL])
  })
})

describe('AppUpdater.install', () => {
  async function readyHarness(overrides: Partial<AppUpdaterDeps> = {}) {
    const h = harness(overrides)

    await h.updater.check()
    await h.updater.download()

    return h
  }

  it('hands over to the installer, remembers the pending install, and quits', async () => {
    const h = await readyHarness()
    const outcome = await h.updater.install()

    expect(outcome).toEqual({ started: true })
    expect(h.deps.handoff.start).toHaveBeenCalledWith(
      path.join(dir, 'updates', '1.0.4', 'AgentXWorkmate-mac-arm64.dmg'),
      '1.0.4'
    )
    expect(h.persisted).toEqual({
      lastRunVersion: '1.0.3',
      pendingInstall: { version: '1.0.4', from: '1.0.3', startedAt: 1_000 }
    })
    expect(h.deps.quit).toHaveBeenCalledOnce()
    expect(h.updater.getState().phase).toBe('installing')
  })

  it('asks first while the agent is mid-turn, and goes ahead once confirmed', async () => {
    const h = await readyHarness({ activeWork: () => ({ count: 2, titles: ['Báo cáo tuần', 'Dịch tài liệu'] }) })

    expect(await h.updater.install()).toEqual({
      started: false,
      reason: 'active-work',
      activeWork: { count: 2, titles: ['Báo cáo tuần', 'Dịch tài liệu'] }
    })
    expect(h.deps.handoff.start).not.toHaveBeenCalled()
    expect(h.updater.getState().phase).toBe('ready')

    expect(await h.updater.install({ confirmActiveWork: true })).toEqual({ started: true })
  })

  it('stays ready, with the reason, when the hand-off cannot start', async () => {
    const h = await readyHarness({
      handoff: {
        start: async () => {
          throw new Error('the disk image holds version 1.0.5, the release says 1.0.4')
        }
      }
    })

    const outcome = await h.updater.install()

    expect(outcome).toMatchObject({ started: false, reason: 'failed' })
    expect(h.updater.getState()).toMatchObject({ phase: 'ready', installError: { kind: 'stage' } })
    expect(h.persisted.pendingInstall).toBeUndefined()
    expect(h.deps.quit).not.toHaveBeenCalled()
  })

  it('re-verifies the installer before running it', async () => {
    const h = await readyHarness()

    fs.writeFileSync(path.join(dir, 'updates', '1.0.4', 'AgentXWorkmate-mac-arm64.dmg'), 'tampered')

    expect(await h.updater.install()).toMatchObject({ started: false, reason: 'failed' })
    expect(h.updater.getState().phase).toBe('available')
    expect(h.deps.handoff.start).not.toHaveBeenCalled()
  })

  it('refuses when nothing is downloaded', async () => {
    const h = harness()

    expect(await h.updater.install()).toMatchObject({ started: false, reason: 'failed' })
  })
})

describe('AppUpdater with a check under way', () => {
  function gate() {
    let open!: () => void

    const opened = new Promise<void>(resolve => {
      open = resolve
    })

    return { open, opened }
  }

  // A fetch whose feed requests and installer bodies can be held until the test
  // lets them through, as a slow network would.
  function controlledFetch({ ignoreAbort = false }: { ignoreAbort?: boolean } = {}) {
    let feed: unknown = feedFor('1.0.4')
    let feedHold: Promise<void> | null = null
    let bodyHold: Promise<void> | null = null
    const counts = { feeds: 0 }

    const fetch: FetchLike = async (url, init) => {
      if (url === FEED_URL) {
        counts.feeds += 1

        const body = JSON.stringify(feed)

        await feedHold

        return new Response(body, { status: 200 })
      }

      const hold = bodyHold

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (ignoreAbort) {
            return
          }

          init.signal?.addEventListener('abort', () => {
            try {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            } catch {
              // Already finished.
            }
          })
        },
        async pull(controller) {
          await hold
          controller.enqueue(new Uint8Array(INSTALLER))
          controller.close()
        }
      })

      return new Response(stream, { status: 200, headers: { 'content-length': String(INSTALLER.length) } })
    }

    return {
      fetch,
      counts,
      setFeed: (next: unknown) => {
        feed = next
      },
      holdFeed: (until: Promise<void> | null) => {
        feedHold = until
      },
      holdBody: (until: Promise<void> | null) => {
        bodyHold = until
      }
    }
  }

  it('leaves a download that started meanwhile running, and starts none of its own mid-download', async () => {
    const net = controlledFetch()
    const h = harness({ fetch: net.fetch })

    await h.updater.check()

    const feed = gate()
    const body = gate()

    net.holdFeed(feed.opened)
    net.holdBody(body.opened)

    const checking = h.updater.check()
    const downloading = h.updater.download()

    feed.open()
    await checking
    expect(h.updater.getState().phase).toBe('downloading')

    await h.updater.check()
    expect(net.counts.feeds).toBe(2)

    body.open()
    await downloading
    expect(h.updater.getState().phase).toBe('ready')
  })

  it('drops a download that a newer release has made moot, without an error', async () => {
    const net = controlledFetch()
    const h = harness({ fetch: net.fetch })

    await h.updater.check()

    const feed = gate()

    net.setFeed(feedFor('1.0.5'))
    net.holdFeed(feed.opened)
    net.holdBody(gate().opened)

    const checking = h.updater.check()
    const downloading = h.updater.download()

    feed.open()
    await checking
    await downloading

    expect(h.updater.getState()).toMatchObject({
      phase: 'available',
      release: { version: '1.0.5' },
      progress: null,
      downloadError: null
    })
    expect(fs.existsSync(path.join(dir, 'updates', '1.0.4', 'AgentXWorkmate-mac-arm64.dmg.partial'))).toBe(false)
  })

  it('keeps the newer release when the moot download finishes anyway', async () => {
    // Not every network stack stops a response mid-body when asked to.
    const net = controlledFetch({ ignoreAbort: true })
    const h = harness({ fetch: net.fetch })

    await h.updater.check()

    const feed = gate()
    const body = gate()

    net.setFeed(feedFor('1.0.5'))
    net.holdFeed(feed.opened)
    net.holdBody(body.opened)

    const checking = h.updater.check()
    const downloading = h.updater.download()

    feed.open()
    await checking
    body.open()
    await downloading

    expect(h.updater.getState()).toMatchObject({ phase: 'available', release: { version: '1.0.5' } })
  })

  it('drops a download the feed has taken back, leaving the state up to date', async () => {
    const net = controlledFetch()
    const h = harness({ fetch: net.fetch })

    await h.updater.check()

    const feed = gate()

    net.setFeed(feedFor('1.0.3'))
    net.holdFeed(feed.opened)
    net.holdBody(gate().opened)

    const checking = h.updater.check()
    const downloading = h.updater.download()

    feed.open()
    await checking
    await downloading

    expect(h.updater.getState()).toMatchObject({ phase: 'up-to-date', release: null, downloadError: null })
  })

  it('changes nothing about an install that started meanwhile', async () => {
    const net = controlledFetch()
    const handoff = gate()
    const start = vi.fn(() => handoff.opened)
    const h = harness({ fetch: net.fetch, handoff: { start } })

    await h.updater.check()
    await h.updater.download()

    const feed = gate()

    net.setFeed(feedFor('1.0.5'))
    net.holdFeed(feed.opened)

    const checking = h.updater.check()
    const installing = h.updater.install()

    await vi.waitFor(() => expect(start).toHaveBeenCalled())
    feed.open()
    await checking

    expect(h.updater.getState()).toMatchObject({ phase: 'installing', release: { version: '1.0.4' } })

    handoff.open()
    await expect(installing).resolves.toEqual({ started: true })
    expect(h.persisted.pendingInstall?.version).toBe('1.0.4')
    expect(h.deps.quit).toHaveBeenCalled()
  })
})

describe('AppUpdater notices', () => {
  it('forgets the post-update notices once acknowledged', async () => {
    const h = harness({ currentVersion: '1.0.4' }, { persisted: { lastRunVersion: '1.0.3' } })

    await h.updater.initialize()

    const state = h.updater.acknowledgeNotices()

    expect(state.updatedFrom).toBeNull()
    expect(state.lastInstallFailed).toBeNull()
  })
})
