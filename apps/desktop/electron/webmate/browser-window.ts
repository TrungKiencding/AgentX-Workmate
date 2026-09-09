/**
 * The Workmate browser window: the person's own Chrome / Edge / Brave binary,
 * started by Workmate with its own profile under `<webmate>/profile`, the
 * extension loaded through CDP `Extensions.loadUnpacked` from the same
 * `AgentX WebMate` folder the guided install points at — so pairing token,
 * bridge and updates are shared, and nothing has to be dragged anywhere
 * (apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.6).
 *
 * Why a pipe and not a port: `--remote-debugging-pipe` is reachable only by
 * the process that spawned the browser. A `--remote-debugging-port` would be
 * a door into a signed-in browser for anything on the machine.
 *
 * Lifetime: the child lives as long as Workmate does (`close()` on quit). A
 * browser the person closes themselves is noticed through the child's exit.
 * Updates in this mode relaunch: chrome.runtime.reload() on a CDP-loaded
 * extension unloads it for good (verified on Chrome 152), so the service
 * closes the window, swaps the folder, and opens it again.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

import type { BrowserInfo } from './browsers'
import { CdpPipe } from './cdp-pipe'

export interface WindowLaunchOptions {
  browser: Pick<BrowserInfo, 'id' | 'name' | 'executable' | 'supported'>
  /** The window's own user-data-dir (`<webmate>/profile`). */
  profileDir: string
  /** The unpacked extension folder to load (`<webmate>/AgentX WebMate`). */
  installDir: string
  /** Optional first page; without it the browser opens on its New Tab page. */
  startUrl?: string
  windowSize?: { width: number; height: number }
}

export interface WindowStatus {
  open: boolean
  /** 'starting' while the browser boots and the extension loads. */
  phase: 'closed' | 'starting' | 'open' | 'closing'
  pid: number | null
  browserId: string | null
  browserName: string | null
  extensionId: string | null
  startedAt: number | null
  /** Why the last open failed or the browser went away. */
  error: string | null
  exitCode: number | null
}

const CLOSED: WindowStatus = {
  open: false,
  phase: 'closed',
  pid: null,
  browserId: null,
  browserName: null,
  extensionId: null,
  startedAt: null,
  error: null,
  exitCode: null
}

/** The minimum of a ChildProcess the window needs; tests hand in a fake. */
export interface WindowChild {
  pid?: number
  stdio: Array<Readable | Writable | null | undefined>
  exitCode: number | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export type WindowSpawn = (file: string, args: string[]) => WindowChild

/** Default: the real browser binary with fds 3/4 as the CDP pipe. */
export const spawnBrowser: WindowSpawn = (file, args) =>
  spawn(file, args, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    windowsHide: false
  }) as unknown as ChildProcess & WindowChild

export interface BrowserWindowDeps {
  spawn?: WindowSpawn
  log?: (message: string) => void
  onChange?: (status: WindowStatus) => void
  /** How long to wait for the browser to answer on the pipe. */
  bootTimeoutMs?: number
  /** How long `close()` waits for a graceful exit before killing. */
  closeTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** The command line for the window. Exported so tests and logs can see exactly what runs. */
export function windowArgs(options: WindowLaunchOptions): string[] {
  const size = options.windowSize ?? { width: 1280, height: 800 }

  const args = [
    `--user-data-dir=${options.profileDir}`,
    '--remote-debugging-pipe',
    // Required for Extensions.loadUnpacked on the browser target.
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${size.width},${size.height}`,
    '--new-window'
  ]

  if (options.startUrl) {
    args.push(options.startUrl)
  }

  return args
}

export class WorkmateBrowserWindow {
  private child: WindowChild | null = null
  private cdp: CdpPipe | null = null
  private status: WindowStatus = { ...CLOSED }
  private closing: Promise<void> | null = null
  private readonly log: (message: string) => void
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly deps: BrowserWindowDeps = {}) {
    this.log = deps.log ?? (() => {})
    this.sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    this.now = deps.now ?? Date.now
  }

  current(): WindowStatus {
    return { ...this.status }
  }

  isOpen(): boolean {
    return this.status.open
  }

  private update(patch: Partial<WindowStatus>): void {
    const next = { ...this.status, ...patch }

    if (JSON.stringify(next) === JSON.stringify(this.status)) {
      return
    }

    this.status = next
    this.deps.onChange?.(this.current())
  }

  /**
   * Start the browser and load the extension. Resolves once the extension
   * folder is loaded (the hello to the bridge follows on the extension's own
   * schedule and shows up in state.json). Rejects — with the window closed
   * again — when the browser cannot be started or the load fails.
   */
  async open(options: WindowLaunchOptions): Promise<WindowStatus> {
    if (this.closing) {
      await this.closing
    }

    if (this.status.open || this.status.phase === 'starting') {
      return this.current()
    }

    if (!options.browser.supported || !options.browser.executable) {
      throw new Error('no Chromium-based browser to run')
    }

    const spawnImpl = this.deps.spawn ?? spawnBrowser
    const args = windowArgs(options)

    this.update({
      ...CLOSED,
      phase: 'starting',
      browserId: options.browser.id,
      browserName: options.browser.name,
      startedAt: this.now()
    })
    this.log(`[webmate] window: ${options.browser.executable} ${args.join(' ')}`)

    let child: WindowChild

    try {
      child = spawnImpl(options.browser.executable, args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      this.update({ ...CLOSED, error: message })
      throw new Error(message)
    }

    this.child = child

    const write = child.stdio[3] as Writable | undefined
    const read = child.stdio[4] as Readable | undefined

    if (!write || !read) {
      child.kill()
      this.child = null
      this.update({ ...CLOSED, error: 'browser did not expose the debugging pipe' })
      throw new Error('browser did not expose the debugging pipe')
    }

    const cdp = new CdpPipe(write, read, { defaultTimeoutMs: this.deps.bootTimeoutMs ?? 20_000, log: this.log })

    this.cdp = cdp

    const exited = new Promise<{ code: number | null; error?: Error }>(resolve => {
      child.once('error', error => resolve({ code: null, error }))
      child.once('exit', code => resolve({ code }))
    })

    child.on('exit', code => {
      if (this.child !== child) {
        return
      }

      this.log(`[webmate] window: browser exited (${code ?? 'signal'})`)
      cdp.dispose(`browser exited with ${code ?? 'a signal'}`)
      this.child = null
      this.cdp = null
      this.update({
        ...CLOSED,
        exitCode: code,
        error: this.status.phase === 'starting' ? 'browser exited during start' : null
      })
    })

    try {
      const version = await Promise.race([
        cdp.send<{ product?: string }>('Browser.getVersion', {}, { timeoutMs: this.deps.bootTimeoutMs ?? 20_000 }),
        exited.then(outcome => {
          throw new Error(
            outcome.error ? outcome.error.message : `browser exited with ${outcome.code ?? 'a signal'} before answering`
          )
        })
      ])

      this.log(`[webmate] window: ${version.product ?? 'browser'} is up on the pipe`)

      const loaded = await cdp.send<{ id?: string }>('Extensions.loadUnpacked', { path: options.installDir })

      this.update({
        open: true,
        phase: 'open',
        pid: child.pid ?? null,
        extensionId: loaded.id ?? null,
        error: null,
        exitCode: null
      })
      this.log(`[webmate] window: extension loaded as ${loaded.id ?? '?'} from ${options.installDir}`)

      return this.current()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      this.log(`[webmate] window: open failed — ${message}`)
      await this.close()
      this.update({ ...CLOSED, error: message })
      throw new Error(message)
    }
  }

  /** Close the browser: Browser.close, then SIGTERM if it lingers. Safe to call when closed. */
  close(): Promise<void> {
    if (this.closing) {
      return this.closing
    }

    const child = this.child
    const cdp = this.cdp

    if (!child) {
      this.cdp = null

      if (this.status.phase !== 'closed') {
        this.update({ ...CLOSED })
      }

      return Promise.resolve()
    }

    this.update({ phase: 'closing', open: false })

    this.closing = (async () => {
      const exited = new Promise<void>(resolve => {
        if (child.exitCode !== null) {
          resolve()

          return
        }

        child.once('exit', () => resolve())
      })

      if (cdp && !cdp.isClosed) {
        await cdp.send('Browser.close', {}, { timeoutMs: 3_000 }).catch(() => undefined)
      }

      const graceMs = this.deps.closeTimeoutMs ?? 5_000
      let done = false

      await Promise.race([
        exited.then(() => {
          done = true
        }),
        this.sleep(graceMs)
      ])

      if (!done) {
        this.log('[webmate] window: browser did not exit on Browser.close; killing it')
        child.kill()
        await Promise.race([exited, this.sleep(2_000)])
      }

      cdp?.dispose('window closed')

      if (this.child === child) {
        this.child = null
        this.cdp = null
      }

      // The exit handler may already have reported 'closed' (with the exit code).
      if (this.status.phase !== 'closed') {
        this.update({ ...CLOSED })
      }
    })().finally(() => {
      this.closing = null
    })

    return this.closing
  }

  /** Close and open again with the same options — how an update lands in this mode. */
  async relaunch(options: WindowLaunchOptions): Promise<WindowStatus> {
    await this.close()

    return this.open(options)
  }

  /**
   * Open a page as a new tab in the window (phase 4: Workmate's own sign-in,
   * so the Keycloak cookie lands in this profile and the extension here can
   * sign in silently). Only http(s); never navigates an existing tab.
   */
  async openUrl(url: string): Promise<{ ok: boolean; targetId: string | null; error: string | null }> {
    let parsed: URL

    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, targetId: null, error: 'not a URL' }
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, targetId: null, error: 'only http(s) pages can be opened' }
    }

    const cdp = this.cdp

    if (!this.status.open || !cdp || cdp.isClosed) {
      return { ok: false, targetId: null, error: 'window is not open' }
    }

    try {
      const created = await cdp.send<{ targetId?: string }>('Target.createTarget', { url: parsed.toString() })

      this.log(`[webmate] window: opened ${parsed.origin} as tab ${created.targetId ?? '?'}`)

      return { ok: true, targetId: created.targetId ?? null, error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      this.log(`[webmate] window: could not open ${parsed.origin} — ${message}`)

      return { ok: false, targetId: null, error: message }
    }
  }
}

/** Pick the browser the window runs: the remembered one, else the default, else the first Chromium-based one. */
export function chooseWindowBrowser(browsers: BrowserInfo[], preferredId: string | null): BrowserInfo | null {
  const candidates = browsers.filter(browser => browser.supported && browser.executable)

  return (
    candidates.find(browser => browser.id === preferredId) ??
    candidates.find(browser => browser.isDefault) ??
    candidates[0] ??
    null
  )
}
