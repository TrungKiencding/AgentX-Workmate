/**
 * A chat tab keeps receiving its turn across a WebSocket reconnect.
 *
 * When the renderer's socket drops, the backend parks every session bound to
 * it on a drop transport — whatever the session emits is discarded — until a
 * client re-attaches it. The main chat re-attaches through its route resume;
 * a tab used to get its cached runtime id handed straight back without the
 * backend ever hearing about it, so the rest of the reply streamed into the
 * void: the tab sat on "thinking" while the sidebar said the turn was done,
 * and only an app restart showed the answer.
 *
 * Real chain: Electron → agentx serve → mock provider. The mock holds the
 * tab's reply after its first token; every renderer socket is closed while it
 * is held; the app reconnects on its own; the reply is released and must land
 * in the tab.
 */

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { MOCK_REPLY } from './mock-server'
import { expect, type Page, test } from './test'

const MAIN_PROMPT = 'E2E_REBIND_MAIN_CHAT'
const HELD_PROMPT = 'E2E_REBIND_HELD_TURN'

/** Record every WebSocket the renderer opens so the test can drop them the
 *  way a network blip or sleep/wake does. Runs before any app code. */
function recordSockets(): void {
  const Native = window.WebSocket
  const sockets = new Set<WebSocket>()

  class RecordingWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      sockets.add(this)
      this.addEventListener('close', () => sockets.delete(this))
    }
  }

  window.WebSocket = RecordingWebSocket as typeof WebSocket

  const hooks = window as unknown as { __e2eDropSockets: () => number; __e2eOpenSockets: () => number }

  hooks.__e2eDropSockets = () => {
    const open = [...sockets].filter(socket => socket.readyState === Native.OPEN)
    open.forEach(socket => socket.close())

    return open.length
  }

  hooks.__e2eOpenSockets = () => [...sockets].filter(socket => socket.readyState === Native.OPEN).length
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]:visible').last()
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
  await composer.click()
  await composer.type(text, { delay: 5 })
  await page.keyboard.press('Enter')
}

/** The transcript on screen. With the tab in front, the main chat is stacked
 *  behind it, so this is the tab's transcript alone. */
const thread = (page: Page) => page.locator('[data-slot="aui_thread-viewport"]:visible')

const dropSockets = (page: Page) =>
  page.evaluate(() => (window as unknown as { __e2eDropSockets: () => number }).__e2eDropSockets())

const openSockets = (page: Page) =>
  page.evaluate(() => (window as unknown as { __e2eOpenSockets: () => number }).__e2eOpenSockets())

test.describe('chat tab across a websocket reconnect', () => {
  // Two boots (the recorder is installed by a reload) plus a held turn.
  test.describe.configure({ timeout: 240_000 })

  let fixture: MockBackendFixture | null = null

  test.beforeEach(async () => {
    fixture = await setupMockBackend({
      // No AgentX sign-in (the gate engages whenever Keycloak is configured,
      // which the defaults do), and no crawl of the host's home for projects.
      extraConfig: `dashboard:
  require_auth: false
desktop:
  repo_scan_enabled: false`,
      mockServer: { holdFirstStreamForPrompt: HELD_PROMPT }
    })
    await waitForAppReady(fixture, 120_000)

    await fixture.page.addInitScript(recordSockets)
    await fixture.page.reload()
    await waitForAppReady(fixture, 120_000)
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
    fixture = null
  })

  test('a tab re-attaches its runtime and shows the reply that finished after the reconnect', async () => {
    const { mock, page } = fixture!

    // A main chat, so the tab opens beside an existing conversation.
    await send(page, MAIN_PROMPT)
    await expect(thread(page)).toContainText(MOCK_REPLY, { timeout: 60_000 })

    // ⌘T: a new chat tab, stacked in front of the main chat. (The strip's "+"
    // only shows once the zone holds more than one pane.)
    await page.keyboard.press('ControlOrMeta+t')
    await expect(page.locator('[data-slot="aui_thread-viewport"]', { hasText: MAIN_PROMPT })).toBeHidden()
    await send(page, HELD_PROMPT)
    await mock.waitForHeldStream()

    await expect(thread(page)).toHaveCount(1)
    await expect(thread(page)).toContainText(HELD_PROMPT)
    await expect(thread(page)).not.toContainText(MOCK_REPLY)

    // The tab is mid-reply. Drop every socket the renderer holds.
    expect(await dropSockets(page)).toBeGreaterThan(0)

    // The app reconnects by itself, then re-attaches the tab.
    await expect
      .poll(() => openSockets(page), { message: 'the app should reconnect on its own', timeout: 30_000 })
      .toBeGreaterThan(0)

    mock.releaseHeldStream()

    // The rest of the reply, streamed after the reconnect, must reach the tab.
    await expect(thread(page)).toContainText(MOCK_REPLY, { timeout: 30_000 })
  })
})
