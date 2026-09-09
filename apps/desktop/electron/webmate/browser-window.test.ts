import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, test } from 'vitest'

import {
  chooseWindowBrowser,
  windowArgs,
  type WindowChild,
  type WindowStatus,
  WorkmateBrowserWindow
} from './browser-window'
import type { BrowserInfo } from './browsers'
import { NulFramer } from './cdp-pipe'

const chrome = {
  id: 'chrome' as const,
  name: 'Google Chrome',
  executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  supported: true
}

const OPTIONS = {
  browser: chrome,
  profileDir: '/Users/k/.agentx/webmate/profile',
  installDir: '/Users/k/.agentx/webmate/AgentX WebMate'
}

/**
 * A fake Chromium: answers CDP on fds 3/4 like the real thing. `behaviour`
 * decides what happens to each command; `exit()` simulates the person closing
 * the browser.
 */
class FakeBrowser extends EventEmitter implements WindowChild {
  pid = 4242
  exitCode: number | null = null
  readonly stdio: Array<PassThrough | null>
  readonly commands: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  killed = false
  private readonly toChild = new PassThrough()
  private readonly fromChild = new PassThrough()
  private readonly framer = new NulFramer()

  constructor(
    private readonly behaviour: (
      method: string,
      params: Record<string, unknown>,
      browser: FakeBrowser
    ) => Record<string, unknown> | null
  ) {
    super()
    this.stdio = [null, null, null, this.toChild, this.fromChild]
    this.toChild.on('data', chunk => {
      for (const frame of this.framer.push(chunk)) {
        const command = JSON.parse(frame)

        this.commands.push(command)
        const answer = this.behaviour(command.method, command.params ?? {}, this)

        if (answer) {
          const { exitAfter, ...reply } = answer as Record<string, unknown> & { exitAfter?: number }

          this.fromChild.write(`${JSON.stringify({ id: command.id, ...reply })}\0`)

          if (typeof exitAfter === 'number') {
            // A browser that honours Browser.close is gone before we even look.
            this.exit(exitAfter)
          }
        }
      }
    })
  }

  kill(): boolean {
    this.killed = true
    this.exit(137)

    return true
  }

  exit(code: number): void {
    if (this.exitCode !== null) {
      return
    }

    this.exitCode = code
    this.fromChild.end()
    this.emit('exit', code, null)
  }
}

const wellBehaved = (method: string) => {
  if (method === 'Browser.getVersion') {
    return { result: { product: 'Chrome/152.0' } }
  }

  if (method === 'Extensions.loadUnpacked') {
    return { result: { id: 'pfadeibckkgklmmjghiikadphihbpape' } }
  }

  if (method === 'Browser.close') {
    return { result: {}, exitAfter: 0 }
  }

  return { error: { code: -32601, message: `unknown ${method}` } }
}

describe('windowArgs', () => {
  test('own profile, pipe debugging, unsafe extension debugging, no first-run noise', () => {
    assert.deepEqual(windowArgs(OPTIONS), [
      '--user-data-dir=/Users/k/.agentx/webmate/profile',
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      '--new-window'
    ])
    assert.equal(windowArgs({ ...OPTIONS, startUrl: 'https://example.com' }).at(-1), 'https://example.com')
    // Never a TCP debugging port.
    assert.ok(!windowArgs(OPTIONS).some(arg => arg.startsWith('--remote-debugging-port')))
  })
})

describe('WorkmateBrowserWindow', () => {
  test('opens the browser, loads the folder over the pipe, closes gracefully, and tracks the person closing it', async () => {
    const changes: WindowStatus['phase'][] = []
    let browser: FakeBrowser | null = null

    const window = new WorkmateBrowserWindow({
      spawn: (file, args) => {
        assert.equal(file, chrome.executable)
        assert.ok(args.includes('--remote-debugging-pipe'))
        browser = new FakeBrowser(wellBehaved)

        return browser
      },
      onChange: status => void changes.push(status.phase),
      sleep: async () => {}
    })

    const status = await window.open(OPTIONS)

    assert.equal(status.open, true)
    assert.equal(status.phase, 'open')
    assert.equal(status.pid, 4242)
    assert.equal(status.extensionId, 'pfadeibckkgklmmjghiikadphihbpape')
    assert.equal(status.browserName, 'Google Chrome')
    assert.deepEqual(
      browser!.commands.map(c => c.method),
      ['Browser.getVersion', 'Extensions.loadUnpacked']
    )
    assert.equal(browser!.commands[1].params.path, OPTIONS.installDir)

    // A second open while open is a no-op.
    assert.equal((await window.open(OPTIONS)).pid, 4242)
    assert.equal(browser!.commands.length, 2)

    await window.close()
    assert.equal(window.isOpen(), false)
    assert.equal(browser!.commands.at(-1)?.method, 'Browser.close')
    assert.equal(browser!.killed, false, 'a browser that honours Browser.close is not killed')
    assert.deepEqual(changes, ['starting', 'open', 'closing', 'closed'])

    // Open again; this time the person closes the browser themselves.
    const reopened = await window.open(OPTIONS)

    assert.equal(reopened.open, true)
    browser!.exit(0)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(window.isOpen(), false)
    assert.equal(window.current().exitCode, 0)
    assert.equal(window.current().error, null)
  })

  test('a browser that ignores Browser.close is killed after the grace period', async () => {
    const stubborn = (method: string) =>
      method === 'Browser.getVersion'
        ? { result: { product: 'Chrome/152.0' } }
        : method === 'Extensions.loadUnpacked'
          ? { result: { id: 'x' } }
          : method === 'Browser.close'
            ? { result: {} }
            : null

    let browser: FakeBrowser | null = null

    const window = new WorkmateBrowserWindow({
      spawn: () => (browser = new FakeBrowser(stubborn)),
      sleep: async () => {},
      closeTimeoutMs: 10
    })

    await window.open(OPTIONS)
    await window.close()
    assert.equal(browser!.killed, true)
    assert.equal(window.isOpen(), false)
  })

  test('a failed extension load closes the browser again and reports why', async () => {
    const noExtensions = (method: string) =>
      method === 'Browser.getVersion'
        ? { result: { product: 'Chrome/152.0' } }
        : method === 'Extensions.loadUnpacked'
          ? { error: { code: -32000, message: 'Extension loading is not enabled' } }
          : method === 'Browser.close'
            ? { result: {}, exitAfter: 0 }
            : null

    let browser: FakeBrowser | null = null

    const window = new WorkmateBrowserWindow({
      spawn: () => (browser = new FakeBrowser(noExtensions)),
      sleep: async () => {}
    })

    await assert.rejects(window.open(OPTIONS), /not enabled/)
    assert.equal(window.isOpen(), false)
    assert.match(window.current().error ?? '', /not enabled/)
    assert.equal(browser!.exitCode, 0, 'the browser is closed after a failed load')
  })

  test('a browser that dies before answering is reported, and a missing binary is refused up front', async () => {
    const window = new WorkmateBrowserWindow({
      spawn: () => {
        const browser = new FakeBrowser(() => null)

        setImmediate(() => browser.exit(1))

        return browser
      },
      sleep: async () => {}
    })

    await assert.rejects(window.open(OPTIONS), /exited with 1/)
    assert.equal(window.isOpen(), false)

    await assert.rejects(
      new WorkmateBrowserWindow().open({ ...OPTIONS, browser: { ...chrome, executable: null } }),
      /no Chromium/
    )
  })

  test('relaunch closes and opens again — the update path in this mode', async () => {
    const spawned: FakeBrowser[] = []

    const window = new WorkmateBrowserWindow({
      spawn: () => {
        const browser = new FakeBrowser(wellBehaved)

        spawned.push(browser)

        return browser
      },
      sleep: async () => {}
    })

    await window.open(OPTIONS)
    const status = await window.relaunch(OPTIONS)

    assert.equal(spawned.length, 2)
    assert.equal(spawned[0].exitCode, 0)
    assert.equal(status.open, true)
    await window.close()
  })
})

describe('WorkmateBrowserWindow.openUrl', () => {
  test('opens an http(s) page as a new tab over the pipe, and refuses anything else', async () => {
    const created: Array<Record<string, unknown>> = []
    const browser = new FakeBrowser((method, params) => {
      if (method === 'Target.createTarget') {
        created.push(params)

        return { result: { targetId: 'T1' } }
      }

      return wellBehaved(method)
    })
    const window = new WorkmateBrowserWindow({ spawn: () => browser, sleep: async () => undefined })

    assert.deepEqual(await window.openUrl('https://id.example.test/auth'), {
      ok: false,
      targetId: null,
      error: 'window is not open'
    })

    await window.open(OPTIONS)
    const opened = await window.openUrl('https://id.example.test/auth?x=1')

    assert.deepEqual(opened, { ok: true, targetId: 'T1', error: null })
    assert.deepEqual(created, [{ url: 'https://id.example.test/auth?x=1' }])
    assert.equal((await window.openUrl('chrome://settings')).ok, false)
    assert.equal((await window.openUrl('file:///etc/hosts')).ok, false)
    assert.equal((await window.openUrl('nope')).ok, false)
    assert.equal(created.length, 1, 'nothing but http(s) reaches the browser')

    await window.close()
  })

  test('a browser that rejects the tab reports the error instead of throwing', async () => {
    const browser = new FakeBrowser(method =>
      method === 'Target.createTarget' ? { error: { code: -32000, message: 'no window' } } : wellBehaved(method)
    )
    const window = new WorkmateBrowserWindow({ spawn: () => browser, sleep: async () => undefined })

    await window.open(OPTIONS)
    const opened = await window.openUrl('https://id.example.test/')

    assert.equal(opened.ok, false)
    assert.match(opened.error ?? '', /no window/)
    await window.close()
  })
})

describe('chooseWindowBrowser', () => {
  const browser = (id: BrowserInfo['id'], isDefault = false, supported = true): BrowserInfo => ({
    id,
    name: id,
    executable: `/bin/${id}`,
    appPath: null,
    version: null,
    isDefault,
    supported,
    unsupportedReason: null,
    dataDir: null,
    extensionsUrl: 'chrome://extensions',
    singleProfile: false,
    running: null,
    profiles: []
  })

  test('remembered browser, else the default, else the first Chromium one; never Firefox/Safari', () => {
    const list = [browser('firefox', true, false), browser('edge', false), browser('chrome', false)]

    assert.equal(chooseWindowBrowser(list, 'chrome')?.id, 'chrome')
    assert.equal(chooseWindowBrowser(list, null)?.id, 'edge')
    assert.equal(chooseWindowBrowser([browser('firefox', true, false), browser('brave', true)], 'vivaldi')?.id, 'brave')
    assert.equal(chooseWindowBrowser([browser('safari', true, false)], null), null)
  })
})
