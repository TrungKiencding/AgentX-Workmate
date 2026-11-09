import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

let fixture: MockBackendFixture

const assistants = /^(Trợ lý|Assistants)$/
const schedules = /^(Lịch tự động|Schedules)$/

test.beforeAll(async () => {
  fixture = await setupMockBackend({
    extraDisplayConfig: '  language: vi',
    extraConfig: `custom_providers:
  - name: AgentX AI Gateway
    base_url: http://127.0.0.1:9/v1
    api_key: e2e-placeholder
    discover_models: false
    models: [mock-model]`
  })
  await waitForAppReady(fixture, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
})

test('sidebar header switches destinations without replacing the Work draft', async () => {
  const { page } = fixture
  await page.screenshot({ path: test.info().outputPath('workspace-navigation-light.png') })
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.fill('Keep this unfinished draft')
  const workRoute = new URL(page.url()).hash

  await page.getByRole('button', { name: assistants, exact: true }).click()
  await expect(page).toHaveURL(/#\/bots$/)
  await expect(page.getByRole('button', { name: assistants, exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.locator('[data-sidebar="header"]').getByRole('button', { name: assistants, exact: true })
  ).toHaveCount(1)
  await expect(page.getByRole('button', { name: assistants, exact: true })).toHaveCount(1)

  const work = page.getByRole('button', { name: 'Work', exact: true })
  await work.focus()
  await page.keyboard.press('Enter')
  await expect(work).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => new URL(page.url()).hash).toBe(workRoute)
  await expect(composer).toHaveText('Keep this unfinished draft')
})

test('rapid repeated clicks honour the last destination without losing the draft', async () => {
  const { page, mock } = fixture
  await page.locator('[contenteditable="true"]').first().fill('Keep this unfinished draft')
  const before = mock.receivedPrompts.length
  const navigation = page.locator('[data-sidebar="header"]').getByRole('group')
  const workRoute = new URL(page.url()).hash

  await navigation.evaluate(group => {
    const [work, assistants] = group.querySelectorAll('button')

    for (let index = 0; index < 30; index += 1) {
      assistants.click()
      assistants.click()
      work.click()
      work.click()
    }
  })

  await expect.poll(() => new URL(page.url()).hash).toBe(workRoute)
  await expect(page.getByRole('button', { name: 'Work', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[contenteditable="true"]').first()).toHaveText('Keep this unfinished draft')
  expect(mock.receivedPrompts.length).toBe(before)
})

test('Schedules remains accessible with the statusbar hidden and saves an explicit model pin', async () => {
  const { page } = fixture
  await expect(page.locator('[data-slot="statusbar"]')).toHaveCount(0)
  await page.locator('[data-sidebar-surface]').getByRole('button', { name: schedules, exact: true }).click()
  await expect(page).toHaveURL(/#\/cron$/)
  await expect(page.getByRole('heading', { name: /^(Lịch tự động|Scheduled jobs)$/i })).toBeVisible()
  await page.getByRole('button', { name: /^(Cron mới|New cron)$/i }).click()
  await expect(page.locator('#cron-model')).toBeVisible()
  await page.locator('#cron-name').fill('Healthy routine')
  await page.locator('#cron-prompt').fill('Remind me to take a break')
  await page.locator('#cron-model').click()
  await page.getByRole('option', { name: 'mock-model', exact: true }).click()
  await page.getByRole('button', { name: /^(Tạo cron|Create cron)$/i, exact: true }).click()
  await expect(page.locator('#cron-model')).not.toBeVisible()

  // Exercise the real UI → gateway → isolated job store path. A named model
  // and provider are what release the scheduler's inference-drift guard.
  const savedPin = async () => {
    const data = JSON.parse(await readFile(join(fixture.sandbox.hermesHome, 'cron', 'jobs.json'), 'utf8'))
    const job = data.jobs.find((row: { name: string }) => row.name === 'Healthy routine')
    return job ? { model: job.model, provider: job.provider } : null
  }

  await expect.poll(savedPin).toEqual({ model: 'mock-model', provider: 'custom:agentx-ai-gateway' })
  await page.getByRole('button', { name: /^(Quản lý|Manage)$/ }).click()
  await page.getByRole('menuitem', { name: /^(Sửa cron|Edit cron)$/i }).click()
  await expect(page.locator('#cron-model')).toContainText('mock-model')
  await page.getByRole('button', { name: /^(Lưu thay đổi|Save changes)$/i }).click()
  await expect(page.locator('#cron-model')).not.toBeVisible()
  await expect.poll(savedPin).toEqual({ model: 'mock-model', provider: 'custom:agentx-ai-gateway' })

  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Work', exact: true })).toBeVisible()
})

test('labelled controls remain clickable in a narrow window and reduced motion', async () => {
  const { page, app } = fixture
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(900, 700)
  })
  const work = page.getByRole('button', { name: 'Work', exact: true })
  const assistant = page.getByRole('button', { name: assistants, exact: true })
  await expect(work).toBeInViewport()
  await expect(assistant).toBeInViewport()
  const header = page.locator('[data-sidebar="header"]')
  const sidebar = page.locator('[data-sidebar-surface]').first()
  const headerRect = await header.boundingBox()
  const sidebarRect = await sidebar.boundingBox()
  expect(headerRect!.x).toBeGreaterThanOrEqual(sidebarRect!.x)
  expect(headerRect!.x + headerRect!.width).toBeLessThanOrEqual(sidebarRect!.x + sidebarRect!.width)
  await assistant.click()
  await expect(assistant).toHaveAttribute('aria-pressed', 'true')
  await work.click()
  await expect(work).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: test.info().outputPath('workspace-navigation.png') })
})

test('collapsing and reopening the sidebar preserves the selected destination', async () => {
  const { page } = fixture
  await page.locator('[contenteditable="true"]').first().fill('Keep this unfinished draft')
  await page.getByRole('button', { name: assistants, exact: true }).click()
  const shortcut = process.platform === 'darwin' ? 'Meta+Backslash' : 'Control+Backslash'
  await page.keyboard.press(shortcut)
  await expect(page.locator('[data-sidebar="header"]')).not.toBeVisible()
  await page.keyboard.press(shortcut)
  await expect(page.locator('[data-sidebar="header"]')).toBeVisible()
  await expect(page.getByRole('button', { name: assistants, exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await expect(page.locator('[contenteditable="true"]').first()).toHaveText('Keep this unfinished draft')
})

test('an overlay opened from Assistants does not replace the remembered Work task', async () => {
  const { page } = fixture
  await page.locator('[contenteditable="true"]').first().fill('Keep this unfinished draft')
  const route = new URL(page.url()).hash
  await page.getByRole('button', { name: assistants, exact: true }).click()
  await page.locator('[data-sidebar-surface]').getByRole('button', { name: schedules, exact: true }).click()
  await expect(page).toHaveURL(/#\/cron$/)
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/#\/bots$/)
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await expect.poll(() => new URL(page.url()).hash).toBe(route)
  await expect(page.locator('[contenteditable="true"]').first()).toHaveText('Keep this unfinished draft')
})

test('long contributed context stays between navigation and system controls', async () => {
  const { page, sandbox, app } = fixture
  const folder = join(sandbox.hermesHome, 'desktop-plugins', 'titlebar-context-test')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'plugin.js'),
    `
    import { createElement } from 'react';
    export default {
      id: 'titlebar-context-test',
      register(ctx) {
        ctx.register({
          id: 'context', area: 'titleBar.center',
          render: () => createElement('button', {
            'aria-label': 'Test titlebar context',
            style: { width: '22rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
          }, 'A long assistant or board name that must not overlap navigation')
        });
      }
    };
  `
  )
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await page.getByRole('combobox').fill('Reload desktop plugins')
  await expect(page.getByRole('option', { name: 'Reload desktop plugins', exact: true })).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const context = page.getByRole('button', { name: 'Test titlebar context' })
  await expect(context).toBeVisible()
  const navigation = page.getByRole('group', { name: /Work (and assistants|và Trợ lý)/ })
  const navRect = await navigation.boundingBox()
  const contextRect = await context.boundingBox()
  expect(contextRect!.x).toBeGreaterThanOrEqual(navRect!.x + navRect!.width)
  const system = page.getByRole('button', { name: /^(Open settings|Mở cài đặt)$/ })
  const systemRect = await system.boundingBox()
  expect(contextRect!.x + contextRect!.width).toBeLessThanOrEqual(systemRect!.x)
  await context.click()
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'dark'
  })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.screenshot({ path: test.info().outputPath('workspace-navigation-dark.png') })
})
