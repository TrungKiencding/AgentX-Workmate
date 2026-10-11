/** Real Electron renderer and preload, with deterministic device-service answers.
 * The proxy/service/database leg is covered by test_device_proxy.py.
 */
import fs from 'node:fs'
import path from 'node:path'

import { buildAppEnv, launchDesktop, type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { allowErrorBanners, expect, test } from './test'

let fixture: MockBackendFixture

test.beforeAll(async () => {
  fixture = await setupMockBackend({ extraDisplayConfig: '  language: vi' })
  await waitForAppReady(fixture, 120_000)
  await fixture.app.evaluate(({ ipcMain }) => {
    const current = '11111111-1111-4111-8111-000000000001'

    const rows = [
      {
        id: current,
        name: 'Kianm1pro.local',
        platform: 'darwin',
        app_version: '1.0.10',
        client_name: 'AgentX Workmate',
        created_at: '2026-10-01T00:00:00Z',
        last_seen_at: new Date().toISOString(),
        current: true,
        revoked: false,
        revoked_at: null,
        display_name: ''
      },
      {
        id: '11111111-1111-4111-8111-000000000002',
        name: 'Kianm1pro.local',
        platform: 'darwin',
        app_version: '1.0.5',
        client_name: 'AgentX Workmate',
        created_at: '2026-09-01T00:00:00Z',
        last_seen_at: '2026-10-06T00:00:00Z',
        current: false,
        revoked: false,
        revoked_at: null,
        display_name: ''
      },
      {
        id: '11111111-1111-4111-8111-000000000003',
        name: 'Old installation',
        platform: 'darwin',
        app_version: '1.0.2',
        client_name: '',
        created_at: '2026-08-01T00:00:00Z',
        last_seen_at: '2026-09-01T00:00:00Z',
        current: false,
        revoked: true,
        revoked_at: '2026-09-02T00:00:00Z',
        display_name: ''
      }
    ]

    let attempts = 0

    for (const name of [
      'agentx:keycloak:status',
      'agentx:devices:list',
      'agentx:devices:revoke',
      'agentx:devices:rename'
    ])
      {ipcMain.removeHandler(name)}

    ipcMain.handle('agentx:keycloak:status', () => ({
      configured: true,
      signedIn: true,
      userId: 'device-test-account',
      email: 'devices@example.test',
      displayName: 'Device Test',
      issuer: 'test',
      clientId: 'test'
    }))
    ipcMain.handle('agentx:devices:list', () => ({ status: 'ok', current, devices: rows, can_rename: true }))
    ipcMain.handle('agentx:devices:rename', (_event, { id, name }) => {
      const row = rows.find(device => device.id === id)!
      row.display_name = name

      return { status: 'ok', device: row }
    })
    ipcMain.handle('agentx:devices:revoke', (_event, { id, rotateKey }) => {
      const row = rows.find(device => device.id === id)!
      attempts += 1
      row.revoked = true
      row.revoked_at ||= new Date().toISOString()
      const rotated = rotateKey && attempts > 1

      return { status: 'ok', device: row, key_rotated: rotated, key_rotation: rotated ? 'rotated' : 'failed' }
    })
  })
})

test.afterAll(async () => {
  await fixture?.cleanup()
})

test('device list is compact, identifiable, keyboard safe, and recovers partial revocation', async () => {
  allowErrorBanners()
  const { page } = fixture
  await page.evaluate(() => {
    window.location.hash = '/settings?tab=account'
  })
  const panel = page.getByRole('region', { name: /Your devices|Thiết bị của bạn/ })
  await expect(panel).toBeVisible()
  const current = panel.getByRole('article', { name: /000000000001$/ })
  const other = panel.getByRole('article', { name: /000000000002$/ })
  await expect(current.getByText(/This device|Thiết bị này/, { exact: true })).toBeVisible()
  await expect(current.getByRole('button', { name: /Revoke device|Thu hồi thiết bị/ })).toHaveCount(0)
  await expect(panel.getByRole('article', { name: /Old installation/ })).toBeHidden()
  await expect(other.getByText(/^(Install|Bản cài đặt) 00000002/)).toBeVisible()
  await other.locator('summary').click()
  await other.getByRole('button', { name: /Rename|Đổi tên/, exact: true }).click()
  await other.getByRole('textbox').fill('MacBook làm việc')
  await other.getByRole('button', { name: /Save|Lưu/, exact: true }).click()
  await expect(other.getByText('MacBook làm việc', { exact: true })).toBeVisible()
  await other.locator('summary').click()

  // Test the actual available panel width, independently of Electron's minimum window size.
  for (const width of [320, 375, 414, 768]) {
    await panel.evaluate((element, size) => {
      ;(element as HTMLElement).style.width = `${size}px`
    }, width)
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  }

  await panel.evaluate(element => {
    ;(element as HTMLElement).style.removeProperty('width')
  })
  await panel.screenshot({ path: 'test-results/device-settings-before.png' })

  await other.getByRole('button', { name: /Revoke device|Thu hồi thiết bị/, exact: true }).click()
  const dialog = page.getByRole('dialog')
  const checkbox = dialog.getByRole('checkbox')
  await checkbox.focus()
  await page.keyboard.press('Space')
  await expect(checkbox).not.toBeChecked()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: /Revoke device|Thu hồi thiết bị/, exact: true })).toBeEnabled()
  await checkbox.check()
  await dialog.getByRole('button', { name: /Revoke device|Thu hồi thiết bị/, exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(panel.getByRole('status')).toContainText(/issuing a new model key failed|cấp khóa model mới thất bại/)
  await expect(other).toBeHidden()
  await panel
    .getByRole('status')
    .getByRole('button', { name: /Issue a new model key|Cấp khóa model mới/ })
    .click()
  await dialog.getByRole('button', { name: /Issue a new model key|Cấp khóa model mới/ }).click()
  await expect(dialog).toBeHidden()
  await expect(panel.getByRole('status')).toContainText(/A new model key was issued|Đã cấp khóa model mới/)
  await panel.locator(':scope > div > details > summary').click()
  await expect(panel.getByRole('article', { name: /000000000002$/ })).toBeVisible()
  await panel.screenshot({ path: 'test-results/device-settings-after.png' })
})

test('a real restart repairs a damaged identity file without registering another install', async () => {
  const deviceFile = path.join(fixture.sandbox.userDataDir, 'device.json')
  const backupFile = `${deviceFile}.bak`
  const original = JSON.parse(fs.readFileSync(deviceFile, 'utf8'))
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'))

  expect(backup.id).toBe(original.id)
  await fixture.app.close()
  fs.writeFileSync(deviceFile, '{truncated', 'utf8')
  fs.writeFileSync(backupFile, JSON.stringify({ ...backup, id: backup.id.toUpperCase() }), 'utf8')
  const launched = await launchDesktop(buildAppEnv(fixture.sandbox))

  fixture.app = launched.app
  fixture.page = launched.page
  await waitForAppReady(fixture, 120_000)
  const recovered = JSON.parse(fs.readFileSync(deviceFile, 'utf8'))

  expect(recovered.id).toBe(original.id)
  expect(recovered.createdAt).toBe(original.createdAt)
  expect(JSON.parse(fs.readFileSync(backupFile, 'utf8')).id.toLowerCase()).toBe(original.id)
})
