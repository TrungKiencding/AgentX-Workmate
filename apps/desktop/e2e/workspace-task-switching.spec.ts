import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type MockBackendFixture,
  type Sandbox,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { MOCK_REPLY, type MockServer, startMockServer } from './mock-server'
import { RealSessionBuilder } from './real-session-builder'
import { expect, type Page, test } from './test'

const TASK_A = 'E2E Sidebar task A'
const TASK_B = 'E2E Sidebar task B'
const TEXT_A = 'Persisted content belonging only to task A'
const TEXT_B = 'Persisted content belonging only to task B'
const DRAFT_A = 'Unsent draft for task A'
const DRAFT_B = 'Unsent draft for task B'
const STREAM_PROMPT = 'E2E sidebar background stream must remain attached'

let fixture: MockBackendFixture
let sandbox: Sandbox
let mock: MockServer

test.beforeAll(async () => {
  mock = await startMockServer({ holdFirstStreamForPrompt: STREAM_PROMPT })
  sandbox = createSandbox('sidebar-tasks')
  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)
  const builder = await RealSessionBuilder.start(sandbox.hermesHome)

  try {
    await builder.createSession({ title: TASK_A, turns: [TEXT_A] })
    await builder.createSession({ title: TASK_B, turns: [TEXT_B] })
  } finally {
    await builder.close()
  }

  const { app, page } = await launchDesktop(buildAppEnv(sandbox))
  fixture = {
    app,
    page,
    mock,
    sandbox,
    mockUrl: mock.url,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      await mock.close()
      sandbox.cleanup()
    }
  }
  await waitForAppReady(fixture, 120_000)
  await page.getByRole('button', { name: 'Show AgentX-Workmate chats', exact: true }).click()
})

test.afterAll(async () => {
  if (fixture) {
    await fixture.cleanup()
  } else {
    await mock?.close()
    sandbox?.cleanup()
  }
})

const viewport = (page: Page) => page.locator('[data-slot="aui_thread-viewport"]').first()
const composer = (page: Page) => page.locator('[contenteditable="true"]').first()
const taskRow = (page: Page, title: string) =>
  page.locator('[data-sidebar-surface] button').filter({ hasText: title }).first()

async function openTask(page: Page, title: string, ownText: string, otherText: string) {
  await taskRow(page, title).click()
  await expect(viewport(page).getByText(ownText, { exact: true })).toHaveCount(1)
  await expect(viewport(page).getByText(otherText, { exact: true })).toHaveCount(0)
}

test('task drafts and histories survive repeated Work / Assistants navigation', async () => {
  const { page } = fixture
  const before = mock.receivedPrompts.length
  await openTask(page, TASK_A, TEXT_A, TEXT_B)
  await composer(page).fill(DRAFT_A)
  const routeA = new URL(page.url()).hash
  await openTask(page, TASK_B, TEXT_B, TEXT_A)
  await composer(page).fill(DRAFT_B)

  for (let index = 0; index < 5; index += 1) {
    await openTask(page, TASK_A, TEXT_A, TEXT_B)
    await expect(composer(page)).toHaveText(DRAFT_A)
    await page.getByRole('button', { name: 'Assistants', exact: true }).dblclick()
    await page.getByRole('button', { name: 'Work', exact: true }).dblclick()
    await expect.poll(() => new URL(page.url()).hash).toBe(routeA)
    await expect(viewport(page).getByText(TEXT_A, { exact: true })).toHaveCount(1)
    await expect(composer(page)).toHaveText(DRAFT_A)
    await openTask(page, TASK_B, TEXT_B, TEXT_A)
    await expect(composer(page)).toHaveText(DRAFT_B)
  }

  expect(mock.receivedPrompts.length).toBe(before)
})

test('rapid task clicks settle on the last task without duplicate messages', async () => {
  const { page } = fixture
  await openTask(page, TASK_A, TEXT_A, TEXT_B)
  await composer(page).fill(DRAFT_A)
  await openTask(page, TASK_B, TEXT_B, TEXT_A)
  await composer(page).fill(DRAFT_B)
  const before = mock.receivedPrompts.length
  await page
    .locator('[data-sidebar-surface]')
    .first()
    .evaluate(
      (sidebar, titles) => {
        const rows = Array.from(sidebar.querySelectorAll('button'))
        const a = rows.find(row => row.textContent?.includes(titles.a))
        const b = rows.find(row => row.textContent?.includes(titles.b))

        if (!a || !b) throw new Error('Both persisted task rows must be available')

        for (let index = 0; index < 20; index += 1) {
          a.click()
          b.click()
          b.click()
        }
      },
      { a: TASK_A, b: TASK_B }
    )

  await expect(viewport(page).getByText(TEXT_B, { exact: true })).toHaveCount(1)
  await expect(viewport(page).getByText(TEXT_A, { exact: true })).toHaveCount(0)
  await expect(composer(page)).toHaveText(DRAFT_B)
  expect(mock.receivedPrompts.length).toBe(before)
})

test('an in-flight response stays attached while navigating away and back', async () => {
  const { page } = fixture
  await openTask(page, TASK_A, TEXT_A, TEXT_B)
  await composer(page).fill(STREAM_PROMPT)
  await composer(page).press('Enter')
  await mock.waitForHeldStream()

  try {
    await page.getByRole('button', { name: 'Assistants', exact: true }).dblclick()
    await page.getByRole('button', { name: 'Work', exact: true }).dblclick()
    await expect(viewport(page).getByText(STREAM_PROMPT, { exact: true })).toHaveCount(1)
    await openTask(page, TASK_B, TEXT_B, TEXT_A)
    await expect(viewport(page).getByText(STREAM_PROMPT, { exact: true })).toHaveCount(0)
    await openTask(page, TASK_A, TEXT_A, TEXT_B)
    await expect(viewport(page).getByText(STREAM_PROMPT, { exact: true })).toHaveCount(1)
  } finally {
    mock.releaseHeldStream()
  }

  await expect(viewport(page).getByText(MOCK_REPLY, { exact: true })).toHaveCount(2, { timeout: 60_000 })
  await expect(viewport(page).getByText(STREAM_PROMPT, { exact: true })).toHaveCount(1)
})
