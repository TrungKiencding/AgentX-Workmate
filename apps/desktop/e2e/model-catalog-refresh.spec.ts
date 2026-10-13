import fs from 'node:fs'
import path from 'node:path'

import type { ElectronApplication } from '@playwright/test'

import { FAKE_SSO_CLIENT_ID, FAKE_SSO_REALM, startFakeSso } from './fake-sso'
import { buildAppEnv, createSandbox, launchDesktop } from './fixtures'
import { expect, test } from './test'

test('SSO model changes refresh on picker open, before send, and on app reopen', async () => {
  test.setTimeout(360_000)
  const sso = await startFakeSso()
  sso.setKeys('issue')
  const sandbox = createSandbox('model-refresh')
  let app: ElectronApplication | undefined

  try {
    fs.writeFileSync(
      path.join(sandbox.hermesHome, 'config.yaml'),
      [
        'dashboard:',
        '  oauth:',
        '    keycloak:',
        `      base_url: ${sso.url}`,
        `      realm: ${FAKE_SSO_REALM}`,
        `      client_id: ${FAKE_SSO_CLIENT_ID}`,
        'accounts:',
        '  second_brain:',
        `    base_url: ${sso.url}`,
        'display:',
        '  language: en',
        'security:',
        '  tirith_enabled: false',
        ''
      ].join('\n')
    )
    const env = buildAppEnv(sandbox, {
      AGENTX_DASHBOARD_KEYCLOAK_BASE_URL: sso.url,
      AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID: FAKE_SSO_CLIENT_ID,
      AGENTX_DASHBOARD_KEYCLOAK_REALM: FAKE_SSO_REALM
    })
    let launched = await launchDesktop(env)
    app = launched.app
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        await fetch(url, { redirect: 'follow' })
      }
    })
    let page = launched.page
    await page.getByRole('button', { name: /Đăng nhập bằng AgentX|Sign in with AgentX/ }).click({ timeout: 180_000 })
    await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 180_000 })
    const modelPill = () =>
      page.locator('[data-slot="composer-root"] button[aria-haspopup="menu"]').filter({ hasText: /mock/i }).first()
    await expect(modelPill()).toContainText(/mock model/i, { timeout: 60_000 })

    // The SSO administrator changes the grant while the app remains open.
    sso.setModels(['mock-new'])
    await modelPill().click()
    await expect(
      page
        .getByRole('menuitem')
        .filter({ hasText: /^mock new/i })
        .first()
    ).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('menuitem').filter({ hasText: /^mock model/i })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(modelPill()).toContainText(/mock new/i, { timeout: 60_000 })

    // A second change arrives after the picker closed: Enter must refresh and
    // choose a valid model before it creates/sends to the backend session.
    sso.setModels(['mock-before-send'])
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.fill('Reply using the current SSO model')
    await composer.press('Enter')
    await expect(page.getByText('SSO model replied: mock-before-send', { exact: true }).first()).toBeVisible({
      timeout: 90_000
    })
    expect(sso.completionModels()).not.toContain('mock-model')
    expect(sso.completionModels()).not.toContain('mock-new')

    // Existing conversations need the same repair, without discarding history.
    sso.setModels(['mock-next-turn'])
    await composer.fill('Continue this conversation with the new grant')
    await composer.press('Enter')
    await expect(page.getByText('SSO model replied: mock-next-turn', { exact: true }).first()).toBeVisible({
      timeout: 90_000
    })
    await expect(page.getByText('SSO model replied: mock-before-send', { exact: true }).first()).toBeVisible()

    await app.close()
    app = undefined
    sso.setModels(['mock-reopened'])
    launched = await launchDesktop(env)
    app = launched.app
    page = launched.page
    await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 180_000 })
    await expect(modelPill()).toContainText(/mock reopened/i, { timeout: 60_000 })
  } finally {
    await app?.close()
    await sso.close()
    sandbox.cleanup()
  }
})
