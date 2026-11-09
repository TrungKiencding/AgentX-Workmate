import { setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

test('channel guide keeps drafts, saves through the real backend, and replays after dismissal', async () => {
  const fixture = await setupMockBackend({ extraConfig: 'desktop:\n  repo_scan_enabled: false' })
  const { page } = fixture
  try {
    await waitForAppReady(fixture, 120_000)
    await page.evaluate(() => {
      window.location.hash = '/messaging?platform=telegram'
    })
    const guide = page.getByRole('region', { name: 'Connection guide' })
    await expect(guide).toBeVisible()
    await guide.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByLabel('Bot token', { exact: true })).toBeVisible()
    await page.getByLabel('Bot token', { exact: true }).fill('unsaved-private-draft')
    await guide.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByLabel('Who may message the bot', { exact: true }).fill('12345678')
    await guide.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(guide).not.toBeVisible()
    await expect(page.getByLabel('Bot token', { exact: true })).toHaveValue('unsaved-private-draft')
    // Only submit the allowlist. No live messaging credential is needed.
    await page.getByLabel('Bot token', { exact: true }).fill('')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    const saved = await page.evaluate(async () => {
      const desktopWindow = window as unknown as {
        agentxDesktop: { api: <T>(request: { path: string; profile?: string }) => Promise<T> }
      }
      const response = await desktopWindow.agentxDesktop.api<{
        platforms: { id: string; enabled: boolean; env_vars: { key: string; is_set: boolean }[] }[]
      }>({ path: '/api/messaging/platforms', profile: 'default' })
      const telegram = response.platforms.find(p => p.id === 'telegram')!
      return {
        enabled: telegram.enabled,
        users: telegram.env_vars.find(f => f.key === 'TELEGRAM_ALLOWED_USERS')?.is_set
      }
    })
    expect(saved).toEqual({ enabled: false, users: true })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Telegram', exact: true })).toBeVisible()
    await expect(guide).not.toBeVisible()
    await page.getByRole('button', { name: 'Show step-by-step guide' }).click()
    await expect(guide).toBeVisible()
    await guide.getByRole('button', { name: 'Continue', exact: true }).click()
    await guide.press('Escape')
    await expect(page.getByRole('button', { name: 'Show step-by-step guide' })).toBeFocused()
  } finally {
    await fixture.cleanup()
  }
})
