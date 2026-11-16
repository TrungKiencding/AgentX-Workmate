/**
 * A failed turn reads in plain words, end to end: the mock provider fails the
 * way OpenAI / LiteLLM do, the real backend classifies it and sends
 * `failure_code`, and the transcript shows the error block (lib/turn-error.ts)
 * — never the raw provider text up front.
 *
 * Prerequisite: `npm run build` must have been run so dist/ exists.
 */

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { allowErrorBanners, expect, test } from './test'

let fixture: MockBackendFixture | null = null

test.beforeAll(async () => {
  // One attempt per turn: the backend's retries would only slow the spec down.
  // A window over the backend's 64K minimum, so every new chat reaches the mock.
  fixture = await setupMockBackend({ extraConfig: 'agent:\n  api_max_retries: 1', modelContextLength: 131_072 })
  await waitForAppReady(fixture, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test.describe('failed turns', () => {
  // The error block is role="alert" by design.
  test.beforeEach(() => allowErrorBanners())

  async function send(text: string) {
    const page = fixture!.page
    await page
      .getByRole('button', { name: /New chat/ })
      .first()
      .click()
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    await composer.click()
    await composer.type(text, { delay: 10 })
    await page.keyboard.press('Enter')

    return page.locator('[data-slot="aui_turn-error"]').last()
  }

  test('a rate limit says so, with the wait the provider asked for, and Try again recovers', async () => {
    fixture!.mock.failCompletionsWith('rate_limited')
    const block = await send('Summarize the Q3 report')

    await expect(block).toBeVisible({ timeout: 60_000 })
    await expect(block).toHaveAttribute('data-error-code', 'rate_limited')
    await expect(block).toContainText('Too many requests right now')
    await expect(block).toContainText('Try again in about 20 seconds.')
    await expect(block).not.toContainText('HTTP 429')

    fixture!.mock.failCompletionsWith(null)
    await block.getByRole('button', { name: 'Try again' }).click()

    await expect(fixture!.page.getByText('boot chain is working')).toBeVisible({ timeout: 60_000 })
    await expect(fixture!.page.locator('[data-slot="aui_turn-error"]')).toHaveCount(0)
  })

  test('a missing model offers no retry, and keeps the raw text under Error details', async () => {
    fixture!.mock.failCompletionsWith('model_not_found')
    const block = await send('Draft the weekly update')

    await expect(block).toBeVisible({ timeout: 60_000 })
    await expect(block).toContainText("This model isn't available right now")
    await expect(block.getByRole('button', { name: 'Try again' })).toHaveCount(0)

    await block.getByRole('button', { name: 'Error details' }).click()
    await expect(block).toContainText('Error code: model_unavailable')
    await expect(block).toContainText('does not exist')
    fixture!.mock.failCompletionsWith(null)
  })
})
