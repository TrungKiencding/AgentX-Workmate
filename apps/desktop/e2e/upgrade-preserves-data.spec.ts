/**
 * Installing a newer build over an older one, for real, and checking nothing
 * the person owns went missing.
 *
 * The older packaged build installs its agent from scratch (the first-launch
 * bootstrap, nothing faked) and holds one real conversation against the mock
 * inference server. The newer build then starts on the same data: its install
 * stamp is ahead of the checkout, so it replaces the checkout with a fresh one
 * (stale-checkout.ts) before launching. The conversation, the config, the key
 * file and a file in memories/ must all come through, and the session must
 * still be listed.
 *
 * Opt-in, and slow (two full installs):
 *
 *   AGENTX_E2E_UPGRADE_FROM="<old app>/Contents/MacOS/AgentX Workmate" \
 *   AGENTX_E2E_UPGRADE_TO="<new app>/Contents/MacOS/AgentX Workmate" \
 *   npx playwright test e2e/upgrade-preserves-data.spec.ts --workers=1
 *
 * AGENTX_REPO_URL=<path of a local repository holding both builds' commits>
 * makes both installs copy the agent locally instead of over the network.
 * AGENTX_E2E_KEEP_SANDBOX=1 keeps the sandbox for inspection.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'

import {
  buildAppEnv,
  createSandbox,
  protectUserCommandLinks,
  type Sandbox,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { type MockServer, startMockServer } from './mock-server'
import { expect, installErrorBannerGuard, test } from './test'

interface BootstrapWindow extends Window {
  agentxDesktop: {
    getBootstrapState(): Promise<{
      active: boolean
      completedAt: number | null
      error: string | null
      setupChoice: unknown
      stages: Record<string, { state: string }>
    }>
    continueBootstrapLocal(): Promise<unknown>
    getVersion(): Promise<{ appVersion: string }>
  }
}

const FROM = process.env.AGENTX_E2E_UPGRADE_FROM || ''
const TO = process.env.AGENTX_E2E_UPGRADE_TO || ''

test.skip(!FROM || !TO, 'Set AGENTX_E2E_UPGRADE_FROM and AGENTX_E2E_UPGRADE_TO to two packaged executables.')

const BOOTSTRAP_BUDGET_MS = 1_500_000

function sqlite(db: string, sql: string): string {
  return execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim()
}

function listTree(root: string, depth = 2): string[] {
  const out: string[] = []

  const walk = (dir: string, level: number) => {
    let names: string[] = []

    try {
      names = fs.readdirSync(dir).sort()
    } catch {
      return
    }

    for (const name of names) {
      const full = path.join(dir, name)
      out.push(path.relative(root, full))

      if (
        level < depth &&
        name !== 'agentx-agent' &&
        !name.startsWith('agentx-agent.') &&
        fs.statSync(full).isDirectory()
      ) {
        walk(full, level + 1)
      }
    }
  }

  walk(root, 1)

  return out
}

async function waitForBootstrap(page: Page, label: string): Promise<void> {
  const deadline = Date.now() + BOOTSTRAP_BUDGET_MS
  let last = ''
  let sawStages = false

  while (Date.now() < deadline) {
    const state = await page.evaluate(() => (window as unknown as BootstrapWindow).agentxDesktop.getBootstrapState())
    const summary = JSON.stringify({ active: state.active, stages: state.stages, error: state.error })

    if (summary !== last) {
      console.log(`[${label}] ${summary}`)
      last = summary
    }

    if (state.error) {
      throw new Error(`[${label}] bootstrap failed: ${state.error}`)
    }

    if (state.setupChoice) {
      await page.evaluate(() => (window as unknown as BootstrapWindow).agentxDesktop.continueBootstrapLocal())
    }

    sawStages ||= Object.keys(state.stages).length > 0

    if (state.completedAt || (sawStages && !state.active)) {
      return
    }

    // A launch that needs no bootstrap never shows a stage: give it a moment
    // to decide, then move on.
    if (!sawStages && !state.active && Date.now() > deadline - BOOTSTRAP_BUDGET_MS + 45_000) {
      return
    }

    await page.waitForTimeout(2000)
  }

  throw new Error(`[${label}] bootstrap did not finish in time`)
}

async function waitForComposer(page: Page): Promise<void> {
  await page.waitForSelector('[contenteditable="true"]', { state: 'visible', timeout: 300_000 })
  await page.waitForFunction(
    () => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      let node: Element | null = el

      while (node) {
        const cs = window.getComputedStyle(node)

        if (cs.position === 'fixed') {
          const rect = node.getBoundingClientRect()

          if (rect.left <= 0 && rect.top <= 0 && rect.right >= window.innerWidth && rect.bottom >= window.innerHeight) {
            return false
          }
        }

        node = node.parentElement
      }

      return Boolean(el)
    },
    undefined,
    { timeout: 300_000 }
  )
}

async function launch(
  executablePath: string,
  env: Record<string, string>
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({ executablePath, args: ['--disable-gpu', '--no-sandbox'], env })
  const page = await app.firstWindow()
  installErrorBannerGuard(page)

  return { app, page }
}

function killSandboxProcesses(sandbox: Sandbox): void {
  const ps = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8' })

  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line)

    if (match && match[2].includes(sandbox.root) && Number(match[1]) !== process.pid) {
      try {
        process.kill(Number(match[1]), 'SIGKILL')
      } catch {
        // gone
      }
    }
  }
}

test('installing a newer build over an older one keeps conversations, settings and files', async () => {
  test.setTimeout(3_600_000)
  const testInfo = test.info()
  const sandbox = createSandbox('upgrade')
  // Both installs re-point ~/.local/bin/agentx at this sandbox.
  const restoreCommandLinks = protectUserCommandLinks()
  let mock: MockServer | undefined
  let app: ElectronApplication | undefined

  const home = sandbox.hermesHome
  const probe = `UPGRADE-PROBE-${Date.now()}`

  try {
    mock = await startMockServer()
    writeMockProviderConfig(home, mock.url)
    writeEnvFile(home)

    const env = buildAppEnv(sandbox)
    delete env.AGENTX_DESKTOP_AGENTX_ROOT
    delete env.AGENTX_DESKTOP_AGENTX
    delete env.AGENTX_DESKTOP_DEV_SERVER
    delete env.AGENTX_DESKTOP_BOOT_FAKE

    // ── The older build: first install, one real conversation ──────────
    ;({ app } = await launch(FROM, env))
    let page = await app.firstWindow()
    await waitForBootstrap(page, 'from')
    await waitForComposer(page)

    const fromVersion = (await page.evaluate(() => (window as unknown as BootstrapWindow).agentxDesktop.getVersion()))
      .appVersion

    const composer = page.locator('[contenteditable="true"]').first()
    await composer.click()
    await composer.type(probe, { delay: 10 })
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('boot chain is working'), undefined, {
      timeout: 120_000
    })
    // Let the turn settle on disk (title, final message rows).
    await page.waitForTimeout(5000)
    fs.writeFileSync(path.join(home, 'memories', 'upgrade-probe.md'), probe)
    await app.close()
    app = undefined
    killSandboxProcesses(sandbox)

    const db = path.join(home, 'state.db')

    const before = {
      sessions: Number(sqlite(db, 'SELECT COUNT(*) FROM sessions')),
      probeMessages: Number(sqlite(db, `SELECT COUNT(*) FROM messages WHERE content LIKE '%${probe}%'`)),
      title: sqlite(db, `SELECT COALESCE(title, '') FROM sessions ORDER BY started_at DESC LIMIT 1`),
      tree: listTree(home),
      config: fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'),
      env: fs.readFileSync(path.join(home, '.env'), 'utf8')
    }

    console.log(
      `[from ${fromVersion}] ${JSON.stringify({ ...before, tree: before.tree.length, config: undefined, env: undefined })}`
    )
    expect(before.probeMessages).toBeGreaterThan(0)

    // ── The newer build over the same data ─────────────────────────────
    ;({ app } = await launch(TO, env))
    page = await app.firstWindow()
    await waitForBootstrap(page, 'to')
    await waitForComposer(page)

    const toVersion = (await page.evaluate(() => (window as unknown as BootstrapWindow).agentxDesktop.getVersion()))
      .appVersion

    // The sidebar has had time to load the session list.
    await page.waitForTimeout(8000)
    const sidebarText = await page.evaluate(() => document.querySelector('[data-slot="sidebar"]')?.textContent ?? '')

    const after = {
      sessions: Number(sqlite(db, 'SELECT COUNT(*) FROM sessions')),
      probeMessages: Number(sqlite(db, `SELECT COUNT(*) FROM messages WHERE content LIKE '%${probe}%'`)),
      tree: listTree(home),
      config: fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'),
      env: fs.readFileSync(path.join(home, '.env'), 'utf8')
    }

    console.log(`[to ${toVersion}] ${JSON.stringify({ sessions: after.sessions, probeMessages: after.probeMessages })}`)
    console.log(
      `[to] missing after upgrade: ${JSON.stringify(before.tree.filter(entry => !after.tree.includes(entry)))}`
    )
    console.log(`[to] sidebar: ${sidebarText.slice(0, 400)}`)

    expect(toVersion).not.toBe(fromVersion)
    expect(after.sessions).toBe(before.sessions)
    expect(after.probeMessages).toBe(before.probeMessages)
    expect(fs.readFileSync(path.join(home, 'memories', 'upgrade-probe.md'), 'utf8')).toBe(probe)
    expect(after.env).toBe(before.env)
    expect(before.tree.filter(entry => !after.tree.includes(entry))).toEqual([])

    if (before.title) {
      expect(sidebarText).toContain(before.title.slice(0, 20))
    }
  } finally {
    await app?.close().catch(() => undefined)
    await mock?.close().catch(() => undefined)

    const logs = path.join(home, 'logs')

    if (fs.existsSync(logs)) {
      for (const file of fs.readdirSync(logs).filter(name => name.endsWith('.log'))) {
        await testInfo.attach(file, { body: fs.readFileSync(path.join(logs, file)), contentType: 'text/plain' })
      }
    }

    killSandboxProcesses(sandbox)

    if (process.env.AGENTX_E2E_KEEP_SANDBOX === '1') {
      console.log(`[sandbox kept] ${sandbox.root}`)
    } else {
      sandbox.cleanup()
    }

    restoreCommandLinks()
  }
})
