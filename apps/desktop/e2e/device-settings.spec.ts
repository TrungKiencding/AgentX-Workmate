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
  // One table row per machine; the current install never shares a row, so the
  // second install of the same hostname stays its own, revocable row.
  const table = panel.getByRole('table', { name: /Your devices|Thiết bị của bạn/ })
  const rows = table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Kianm1pro.local' }) })
  const currentLabel = /^(This device|Thiết bị này)$/
  const current = rows.filter({ has: page.getByText(currentLabel, { exact: true }) })
  const other = rows.filter({ hasNot: page.getByText(currentLabel, { exact: true }) })
  await expect(rows).toHaveCount(2)
  await expect(current.getByText(currentLabel, { exact: true })).toBeVisible()
  await expect(current.getByRole('button', { name: /Revoke device|Thu hồi thiết bị/ })).toHaveCount(0)
  // Revoked installs live in the collapsed revocation history, not the list.
  await expect(panel.getByText('Old installation', { exact: true })).toBeHidden()

  // Two rows with the same hostname are told apart in their details: the
  // install id and the version are right there.
  const details = page.getByRole('dialog')
  await other.getByRole('button', { name: 'Kianm1pro.local' }).click()
  await expect(details.getByText('11111111-1111-4111-8111-000000000002', { exact: true })).toBeVisible()
  await expect(details.getByText(/1\.0\.5/).first()).toBeVisible()
  await details.getByRole('button', { name: /^(Rename|Đổi tên)$/ }).click()
  await details.getByRole('textbox').fill('MacBook làm việc')
  await details.getByRole('button', { name: /^(Save|Lưu)$/ }).click()
  await expect(details.getByRole('heading', { name: 'MacBook làm việc' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  const renamed = table.getByRole('row').filter({ has: page.getByRole('button', { name: 'MacBook làm việc' }) })
  await expect(renamed).toHaveCount(1)
  await expect(rows).toHaveCount(1)

  // Test the actual available panel width, independently of Electron's minimum window size.
  for (const width of [320, 375, 414, 768]) {
    await panel.evaluate((element, size) => {
      ;(element as HTMLElement).style.width = `${size}px`
    }, width)
    // Soft, so a layout failure is reported without hiding whether the
    // revocation flow below still works.
    expect
      .soft(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), `no horizontal overflow at ${width}px`)
      .toBe(true)
  }

  await panel.evaluate(element => {
    ;(element as HTMLElement).style.removeProperty('width')
  })
  await panel.screenshot({ path: 'test-results/device-settings-before.png' })

  await renamed.getByRole('button', { name: /Revoke device|Thu hồi thiết bị/, exact: true }).click()
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
  await expect(renamed).toBeHidden()
  await panel
    .getByRole('status')
    .getByRole('button', { name: /Issue a new model key|Cấp khóa model mới/ })
    .click()
  await dialog.getByRole('button', { name: /Issue a new model key|Cấp khóa model mới/ }).click()
  await expect(dialog).toBeHidden()
  await expect(panel.getByRole('status')).toContainText(/A new model key was issued|Đã cấp khóa model mới/)
  await panel.locator(':scope > div > details > summary').click()
  const history = panel.getByRole('table', { name: /Revocation history|Lịch sử thu hồi/ })
  await expect(history.getByRole('button', { name: 'MacBook làm việc' })).toBeVisible()
  await expect(history.getByRole('button', { name: 'Old installation' })).toBeVisible()
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
