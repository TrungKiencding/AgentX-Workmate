import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, test, type ElectronApplication, type Page } from './test'

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type Sandbox,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { startMockServer, type MockServer } from './mock-server'
import { RealSessionBuilder } from './real-session-builder'

const BOT_HANDLE = '@workmate_demo_bot'
const BOT_URL = 'https://t.me/workmate_demo_bot'
const SESSION_TITLE = 'Support request from Telegram'
const USER_MESSAGE = 'Please review the customer handoff from Telegram.'

interface MessagingFixture {
  app: ElectronApplication
  cleanup: () => Promise<void>
  mock: MockServer
  page: Page
  sandbox: Sandbox
}

async function setupMessagingDesktop(): Promise<MessagingFixture> {
  const mock = await startMockServer()
  const sandbox = createSandbox('messaging-read-only')

  writeMockProviderConfig(
    sandbox.hermesHome,
    mock.url,
    undefined,
    `dashboard:
  require_auth: false
platforms:
  telegram:
    enabled: true`
  )
  writeEnvFile(sandbox.hermesHome)
  fs.appendFileSync(path.join(sandbox.hermesHome, '.env'), 'TELEGRAM_BOT_TOKEN=e2e-fake-token\n', 'utf8')

  const builder = await RealSessionBuilder.start(sandbox.hermesHome)
  try {
    await builder.createSession({
      source: 'telegram',
      title: SESSION_TITLE,
      turns: [USER_MESSAGE]
    })
  } finally {
    await builder.close()
  }

  const now = new Date().toISOString()
  fs.writeFileSync(
    path.join(sandbox.hermesHome, 'gateway_state.json'),
    JSON.stringify(
      {
        gateway_state: 'running',
        platforms: {
          telegram: {
            public_destination: { kind: 'bot', label: BOT_HANDLE, url: BOT_URL },
            state: 'connected',
            updated_at: now
          }
        },
        updated_at: now
      },
      null,
      2
    ),
    'utf8'
  )

  const { app, page } = await launchDesktop(buildAppEnv(sandbox))

  return {
    app,
    mock,
    page,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      await mock.close()
      sandbox.cleanup()
    }
  }
}

test('connected Telegram channel and its transcript stay visible but read-only', async ({}, testInfo) => {
  const fixture = await setupMessagingDesktop()

  try {
    await waitForAppReady(fixture, 120_000)

    const messagingResponse = await fixture.page.evaluate(() => {
      const desktopWindow = window as unknown as {
        agentxDesktop: {
          api: (request: { path: string; profile?: string }) => Promise<unknown>
        }
      }

      return desktopWindow.agentxDesktop.api({ path: '/api/messaging/platforms', profile: 'default' })
    })
    expect(messagingResponse).toMatchObject({
      platforms: expect.arrayContaining([
        expect.objectContaining({
          destination: { kind: 'bot', label: BOT_HANDLE, url: BOT_URL },
          enabled: true,
          id: 'telegram',
          state: 'connected'
        })
      ])
    })

    const connectedSection = fixture.page.locator('[data-slot="connected-channels"]')
    await expect(connectedSection).toContainText('Telegram')
    await expect(connectedSection).toContainText(BOT_HANDLE)

    await connectedSection.getByRole('button', { name: /Telegram/ }).click()
    await expect(fixture.page).toHaveURL(/\/messaging\?platform=telegram$/)
    await expect(fixture.page.getByText(BOT_HANDLE).last()).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: /Open in app|Mở trong ứng dụng/i })).toBeVisible()

    const sidebarResponse = await fixture.page.evaluate(() => {
      const desktopWindow = window as unknown as {
        agentxDesktop: {
          api: (request: { path: string }) => Promise<unknown>
        }
      }

      return desktopWindow.agentxDesktop.api({
        path:
          '/api/profiles/sessions/sidebar?recents_profile=all&recents_limit=20' +
          '&cron_limit=50&messaging_limit=100&messaging_exclude=cron%2Cdesktop'
      })
    })
    expect(sidebarResponse).toMatchObject({
      messaging: {
        sessions: expect.arrayContaining([expect.objectContaining({ source: 'telegram' })])
      }
    })
    // The title can settle after the sidebar's first fetch, so match its
    // authored title or its first-message preview.
    const sessionRow = fixture.page
      .locator('[data-slot="row-button"]')
      .filter({ hasText: /Support request from Telegram|Please review the customer handoff from Telegram/ })
      .last()
    await expect(sessionRow).toBeVisible()
    await sessionRow.click()
    await fixture.page.waitForFunction(
      expected => (document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent ?? '').includes(expected),
      USER_MESSAGE,
      { timeout: 30_000 }
    )

    await expect(fixture.page.locator('[data-testid="messaging-read-only-bar"]')).toContainText('Telegram')
    await expect(fixture.page.locator('[data-testid="messaging-header-tag"]')).toBeVisible()
    await expect(fixture.page.locator('[data-testid="messaging-header-tag"]')).toContainText('Telegram')
    await expect(fixture.page.locator('[data-slot="composer-root"]')).toHaveCount(0)
    await expect(fixture.page.getByRole('button', { name: /Edit message/i })).toHaveCount(0)
    await fixture.page.screenshot({
      path: testInfo.outputPath('telegram-read-only-transcript.png'),
      fullPage: false
    })
  } finally {
    await fixture.cleanup()
  }
})
