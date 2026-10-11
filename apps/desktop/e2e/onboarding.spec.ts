/**
 * E2E onboarding tests — only AgentX AI Gateway may be connected.
 *
 * Launches the app with an empty config.yaml (no providers). The renderer
 * should detect the unconfigured state and show the DesktopOnboardingOverlay
 * with the gateway connection and Skip actions.
 *
 * Prerequisite: `npm run build` must have been run so dist/ exists.
 */

import { type NoProviderFixture, setupNoProvider, waitForOnboarding } from './fixtures'
import { expect, test } from './test'
import { expectVisualSnapshot } from './visual-snapshot'

let fixture: NoProviderFixture | null = null

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test.describe('onboarding with no provider configured', () => {
  test('onboarding overlay appears on first boot', async () => {
    fixture = await setupNoProvider()

    // The app should boot (agentx serve starts fine even without a provider),
    // but the renderer should show the onboarding overlay because no
    // provider is configured.
    await waitForOnboarding(fixture.page, 90_000)
  })

  test('onboarding offers only AgentX AI Gateway and skip', async () => {
    const page = fixture!.page
    await expect(page.getByRole('button', { name: /AgentX AI Gateway/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible()
    await expect(page.getByText('Other providers', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Fireworks AI', { exact: true })).toHaveCount(0)
    await expect(page.getByPlaceholder('Paste API key')).toHaveCount(0)
  })

  test('screenshot of onboarding overlay', async () => {
    if (!fixture) {
      test.skip(true, 'Previous test failed — no app running')

      return
    }

    await expectVisualSnapshot(fixture.page, { name: 'onboarding-overlay', app: fixture.app })
  })

  test('gateway failure can be skipped without choosing another provider', async () => {
    const page = fixture!.page
    await page.getByRole('button', { name: /AgentX AI Gateway/ }).click()
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Choose another provider', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(page.getByText('Let’s get you set up with AgentX Workmate', { exact: true })).toHaveCount(0)
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible()
    await page.reload()
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /AgentX AI Gateway/ })).toHaveCount(0)
  })
})
