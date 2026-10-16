/**
 * E2E coverage for session compression, which rotates a live backend session.
 */

import { expect, test, type Page } from '@playwright/test'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { MOCK_REPLY, receivedUserTexts, restartMockServer } from './mock-server'

async function send(page: Page, text: string, delay = 15): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.click()
  await composer.type(text, { delay })
  await composer.press('Enter')
}

async function pasteAndSend(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.fill(text)
  await expect(composer).toHaveText(text)
  // The prior reply's text may already be present while its turn is still
  // ending. Cross the compression threshold with a new send, not a queued
  // draft, and send to the editor that actually received the text.
  await expect(page.locator('[data-slot="composer-root"] button[type="submit"]')).toHaveAttribute('aria-label', 'Send')
  await page.locator('[data-slot="composer-root"] button[type="submit"]').click()
}

async function waitForTranscript(page: Page, text: string, timeout = 90_000): Promise<void> {
  await page.waitForFunction(
    expected => document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent?.includes(expected) ?? false,
    text,
    { timeout }
  )
}

test.describe('session compression', () => {
  test.describe.configure({ mode: 'serial' })

  let fixture: MockBackendFixture

  test.beforeAll(async () => {
    restartMockServer()
    fixture = await setupMockBackend()
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('compresses an existing session and accepts a follow-up turn on its continuation', async () => {
    const { page } = fixture
    const reply = 'Hello from the mock inference server! The full boot chain is working.'

    // Three completed exchanges leave a compressible middle after the
    // compressor's protected head/tail boundaries.
    await send(page, 'E2E_COMPRESSION_FIRST')
    await waitForTranscript(page, reply)
    await send(page, 'E2E_COMPRESSION_SECOND')
    await expect.poll(() => receivedUserTexts().filter(text => text === 'E2E_COMPRESSION_SECOND').length).toBe(1)
    await send(page, 'E2E_COMPRESSION_THIRD')
    await expect.poll(() => receivedUserTexts().filter(text => text === 'E2E_COMPRESSION_THIRD').length).toBe(1)

    // This test covers compression and continuation, not slash completion.
    // Insert the complete command atomically and click Send so an async
    // completion response cannot consume Enter as a picker acceptance.
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.click()
    await page.keyboard.insertText('/compress preserve the three test turns')
    await expect.poll(() => composer.textContent()).toContain('preserve the three test turns')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect
      .poll(() => page.locator('[data-slot="aui_thread-viewport"]').textContent(), { timeout: 90_000 })
      .toMatch(/Compressed|No changes from compression/)

    // Compression rotates the agent's live session id. A post-compression
    // ordinary turn proves the desktop's runtime binding followed that child.
    await send(page, 'E2E_COMPRESSION_FOLLOW_UP')
    await expect.poll(() => receivedUserTexts().filter(text => text === 'E2E_COMPRESSION_FOLLOW_UP').length).toBe(1)
    await waitForTranscript(page, reply)
    await page.screenshot({ path: 'test-results/session-compression-continuation.png' })
  })
})

test.describe('session compression in progress', () => {
  let fixture: MockBackendFixture

  test.beforeAll(async () => {
    fixture = await setupMockBackend({
      modelContextLength: 64_000,
      extraConfig: `compression:
  threshold_tokens: 22000
  protect_first_n: 0
  protect_last_n: 1
auxiliary:
  compression:
    provider: custom
    model: mock-model`,
      mockServer: {
        holdFirstCompletionContaining: 'You are a summarization agent creating a context checkpoint.'
      }
    })
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    if (test.info().status !== test.info().expectedStatus) {
      console.log('Compression mock diagnostics:', {
        held: fixture.mock.heldCompletionCount(),
        prompts: fixture.mock.receivedPrompts.map(text => ({ characters: text.length, prefix: text.slice(0, 64) })),
      })
    }
    await fixture?.cleanup()
  })

  test('queues an Enter-submitted draft instead of steering while compaction is active', async ({}, testInfo) => {
    const { page } = fixture
    const queued = 'E2E_QUEUED_DURING_COMPACTION'

    // A normal message crosses the tiny configured context budget. The mock
    // blocks only the resulting summary request, so these assertions run
    // during automatic compaction rather than a slash-command path.
    // Cross threshold_tokens (22k) with the payload alone, even with the
    // conservative four-characters-per-token fallback. The old 1500 repeats
    // contributed only ~12k tokens and depended on the ambient system prompt.
    await pasteAndSend(page, 'E2E_COMPACTION_HISTORY_ONE '.repeat(5))
    await waitForTranscript(page, MOCK_REPLY)
    await pasteAndSend(page, 'E2E_COMPACTION_HISTORY_TWO '.repeat(5))
    await waitForTranscript(page, MOCK_REPLY)
    await pasteAndSend(page, 'E2E_TRIGGER_AUTOMATIC_COMPACTION '.repeat(3000))
    await fixture.mock.waitForHeldCompletion()
    await expect(page.getByRole('status', { name: 'Summarizing thread' }).last()).toBeVisible()

    const primary = page.locator('[data-slot="composer-root"] button[type="submit"]')
    await expect(primary).toHaveAttribute('aria-label', 'Queue message')

    await send(page, queued)
    await expect(page.getByText('1 Queued')).toBeVisible()
    expect(fixture.mock.heldCompletionCount()).toBe(1)
    expect(receivedUserTexts()).not.toContain(queued)
    await page.screenshot({ path: testInfo.outputPath('queued-during-compaction.png') })

    fixture.mock.releaseHeldStream()
    await expect.poll(() => receivedUserTexts().filter(text => text === queued).length).toBe(1)
    expect(fixture.mock.heldCompletionCount()).toBe(1)
  })
})
