import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { _electron, type ElectronApplication } from '@playwright/test'

import { buildAppEnv, createSandbox, PACKAGED_BINARY_PATH } from './fixtures'
import { expect, installErrorBannerGuard, test } from './test'

interface ReleaseWindow extends Window {
  agentxDesktop: {
    getBootstrapState(): Promise<{
      active: boolean
      stages: Record<string, { state: string }>
      error: string | null
      setupChoice: unknown
      completedAt: number | null
    }>
    continueBootstrapLocal(): Promise<unknown>
    getVersion(): Promise<{ appVersion: string }>
  }
}

test.skip(process.env.AGENTX_E2E_RELEASE !== '1', 'Full release installation is opt-in.')

test('packaged release installs once and preserves its version and data across three restarts', async () => {
  const testInfo = test.info()
  test.setTimeout(1_200_000)
  const sandbox = createSandbox('release-install')
  const executablePath = process.env.AGENTX_E2E_EXECUTABLE || PACKAGED_BINARY_PATH
  const env = buildAppEnv(sandbox)
  delete env.AGENTX_DESKTOP_AGENTX_ROOT
  delete env.AGENTX_DESKTOP_AGENTX
  delete env.AGENTX_DESKTOP_DEV_SERVER
  delete env.AGENTX_DESKTOP_BOOT_FAKE
  const active = path.join(sandbox.hermesHome, 'agentx-agent')
  let app: ElectronApplication | undefined

  try {
    app = await _electron.launch({ executablePath, args: ['--disable-gpu', '--no-sandbox'], env })
    const page = await app.firstWindow()
    installErrorBannerGuard(page)
    const deadline = Date.now() + 1_080_000
    let completed = false
    let last = ''

    while (Date.now() < deadline) {
      const state = await page.evaluate(() => (window as unknown as ReleaseWindow).agentxDesktop.getBootstrapState())
      const summary = JSON.stringify({ active: state.active, stages: state.stages, error: state.error })

      if (summary !== last) {
        console.log(summary)
        last = summary
      }

      if (state.error) {
        throw new Error(state.error)
      }

      if (state.setupChoice) {
        await page.evaluate(() => (window as unknown as ReleaseWindow).agentxDesktop.continueBootstrapLocal())
      }

      if (state.completedAt) {
        expect(Object.values(state.stages).some(stage => stage.state === 'failed')).toBe(false)
        completed = true

        break
      }

      await page.waitForTimeout(2000)
    }

    expect(completed, 'Fresh installation must finish successfully').toBe(true)
    const version = await page.evaluate(() => (window as unknown as ReleaseWindow).agentxDesktop.getVersion())
    expect(version.appVersion).toBe(
      JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version
    )
    const head = execFileSync('git', ['-C', active, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const markerPath = path.join(active, '.agentx-bootstrap-complete')
    const marker = fs.readFileSync(markerPath, 'utf8')
    const retained = path.join(sandbox.hermesHome, 'release-data-must-survive.txt')
    fs.writeFileSync(retained, 'preserve user data')
    await app.close()
    app = undefined

    for (let launch = 0; launch < 3; launch++) {
      app = await _electron.launch({ executablePath, args: ['--disable-gpu', '--no-sandbox'], env })
      const reopened = await app.firstWindow()
      installErrorBannerGuard(reopened)
      // Give startup enough time to reach the runtime decision and backend boot.
      await reopened.waitForTimeout(10_000)
      const state = await reopened.evaluate(() => (window as unknown as ReleaseWindow).agentxDesktop.getBootstrapState())
      expect(state.error).toBeFalsy()
      expect(state.active).toBe(false)
      expect(Object.keys(state.stages)).toHaveLength(0)
      expect((await reopened.evaluate(() => (window as unknown as ReleaseWindow).agentxDesktop.getVersion())).appVersion).toBe(
        version.appVersion
      )
      expect(execFileSync('git', ['-C', active, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(head)
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(marker)
      expect(fs.readFileSync(retained, 'utf8')).toBe('preserve user data')
      await app.close()
      app = undefined
    }
  } finally {
    await app?.close().catch(() => undefined)
    const logs = path.join(sandbox.hermesHome, 'logs')

    if (fs.existsSync(logs)) {
      for (const file of fs.readdirSync(logs).filter(file => file.startsWith('bootstrap-') && file.endsWith('.log'))) {
        await testInfo.attach(file, { body: fs.readFileSync(path.join(logs, file)), contentType: 'text/plain' })
      }
    }

    sandbox.cleanup()
  }
})
