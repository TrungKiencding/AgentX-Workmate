/**
 * Regression coverage for a chat deleted while its title is being generated.
 *
 * The auto-titler runs after the first reply and lands a few seconds later:
 * it bills its call and writes the title. Deleting the chat in that window
 * used to end with both writes recreating the row — no messages, a title —
 * and the relaunch reopening that ghost as the remembered session: the
 * sidebar showed the chat, the intro offered to continue it, and opening it
 * showed nothing.
 *
 * The mock holds the title request until the chat is deleted, so the race is
 * deterministic.
 */

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type Sandbox,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { MOCK_REPLY, startMockServer } from './mock-server'
import { type ElectronApplication, expect, type Page, test } from './test'

const PROMPT = 'E2E delete me before my title lands'
// The opening of the auto-titler's system prompt (agent/title_generator.py).
const TITLE_REQUEST = 'Generate a short, descriptive title (3-7 words) for a conversation'
const REMEMBERED_SESSION_KEY = 'agentx.desktop.lastSessionId'
// The titler's writes land within milliseconds of its response; this is the
// window in which a ghost would have appeared.
const TITLER_SETTLE_MS = 3_000

interface Fixture {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

async function launch(sandbox: Sandbox): Promise<Fixture> {
  const { app, page } = await launchDesktop(buildAppEnv(sandbox))
  const fixture = { app, page, sandbox, cleanup: () => app.close().catch(() => undefined) }
  await waitForAppReady(fixture, 120_000)

  return fixture
}

function chatRow(page: Page) {
  return page.locator('[data-slot="row-button"]').filter({ hasText: PROMPT })
}

async function rememberedSessionId(page: Page): Promise<null | string> {
  return page.evaluate(key => localStorage.getItem(key), REMEMBERED_SESSION_KEY)
}

/** Status of GET /api/sessions/{id}, read through the app's own API bridge. */
async function sessionStatus(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async id => {
    const desktopWindow = window as unknown as {
      agentxDesktop: { api: (request: { path: string }) => Promise<unknown> }
    }

    try {
      await desktopWindow.agentxDesktop.api({ path: `/api/sessions/${encodeURIComponent(id)}` })

      return 'found'
    } catch (error) {
      return String(error instanceof Error ? error.message : error)
    }
  }, sessionId)
}

test('a chat deleted while its title is generating stays deleted after a relaunch', async () => {
  // Two cold boots (backend included) and a turn.
  test.setTimeout(360_000)
  const mock = await startMockServer({ holdFirstCompletionContaining: TITLE_REQUEST })
  const sandbox = createSandbox('deleted-session')
  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)
  let fixture: Fixture | null = null

  try {
    fixture = await launch(sandbox)
    const { page } = fixture

    const composer = page.locator('[contenteditable="true"]').first()
    await composer.click()
    await composer.type(PROMPT, { delay: 10 })
    await page.keyboard.press('Enter')
    await page.waitForFunction(reply => (document.body?.textContent ?? '').includes(reply), MOCK_REPLY, {
      timeout: 60_000
    })

    // The reply is in and the titler is waiting on the model.
    await mock.waitForHeldCompletion()
    const deletedId = await rememberedSessionId(page)
    expect(deletedId, 'the open chat should be the remembered session').toBeTruthy()

    const row = chatRow(page)
    await row
      .locator('..')
      .getByRole('button', { name: /Chat actions/i })
      .click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await expect(row).toHaveCount(0)

    mock.releaseHeldStream()
    await page.waitForTimeout(TITLER_SETTLE_MS)

    expect(await sessionStatus(page, deletedId!)).toContain('404')
    expect(await rememberedSessionId(page)).toBeNull()

    await fixture.cleanup()
    fixture = await launch(sandbox)

    // The relaunch lands on a new chat instead of reopening the deleted one.
    await expect(chatRow(fixture.page)).toHaveCount(0)
    await expect(fixture.page.locator('[data-slot="row-button"]')).toHaveCount(0)
    expect(fixture.page.url()).not.toContain(deletedId!)
    expect(await sessionStatus(fixture.page, deletedId!)).toContain('404')
  } finally {
    await fixture?.cleanup()
    await mock.close()
    sandbox.cleanup()
  }
})
