import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { strToU8, zipSync } from 'fflate'

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { startMockServer } from './mock-server'
import { expect, test, type Page } from './test'

/** Verify actual layout: both in-flow transcript and absolute dock share a center. */
async function expectChatColumnAligned(page: Page): Promise<void> {
  const workspace = page.locator('[data-chat-surface]:visible .session-workspace').last()
  await expect
    .poll(
      async () =>
        workspace.evaluate(element => {
          const bounds = element.querySelector('[data-slot="composer-bounds"]')!.getBoundingClientRect()
          const dock = element
            .querySelector('[data-slot="composer-dock"]:not([data-popped-out])')!
            .getBoundingClientRect()
          const content = element.querySelector('[data-slot="aui_thread-content"]')?.getBoundingClientRect()
          const center = (rect: DOMRect) => (rect.left + rect.right) / 2
          return Math.max(
            Math.abs(center(bounds) - center(dock)),
            content ? Math.abs(center(content) - center(dock)) : 0
          )
        }),
      { message: 'The transcript and composer must remain centered in the same column' }
    )
    .toBeLessThan(1.5)
}

/** The floating card may sit over the transcript only while it is asked for. */
async function expectTranscriptUncovered(page: Page): Promise<void> {
  const covered = await page
    .locator('[data-chat-surface]:visible .session-workspace')
    .last()
    .evaluate(element => {
      const card = element.querySelector('[data-testid="session-resources"]')?.getBoundingClientRect()
      const transcript = element.querySelector('[data-slot="aui_thread-content"]')?.getBoundingClientRect()
      return Boolean(card && transcript && card.left < transcript.right && card.right > transcript.left)
    })
  expect(covered, 'Nothing may cover the transcript unasked').toBe(false)
}

interface SettingsTestWindow extends Window {
  agentxDesktop: {
    settings: { setDefaultProjectDir: (dir: string) => Promise<unknown> }
  }
}

test('new chat clears the previous sidebar while preserving its folder and old session', async ({}, testInfo) => {
  const sandbox = createSandbox('new-chat-resources')
  const repo = path.join(sandbox.root, 'previous-project')
  fs.mkdirSync(repo)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'README.md'), 'Before\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=AgentX E2E', '-c', 'user.email=e2e@example.com', 'commit', '-m', 'initial'], {
    cwd: repo
  })
  fs.writeFileSync(path.join(repo, 'README.md'), 'Changed by the previous session\n')
  const output = path.join(repo, 'previous-output.txt')
  fs.writeFileSync(output, 'The previous conversation output\n')
  const mock = await startMockServer({
    scriptedTurns: [
      { text: 'Sharing the previous output.', toolCalls: [{ name: 'deliver_file', args: { path: output } }] },
      { text: 'Old session resources. [Previous source](https://example.com/previous-source)' }
    ]
  })
  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)
  const launched = await launchDesktop(buildAppEnv(sandbox))
  const fixture = { ...launched, sandbox, mock, mockUrl: mock.url, cleanup: async () => {} }
  const { app, page } = launched
  try {
    await waitForAppReady(fixture)
    await page.evaluate(async dir => {
      await (window as unknown as SettingsTestWindow).agentxDesktop.settings.setDefaultProjectDir(dir)
    }, repo)
    await page.reload()
    await waitForAppReady(fixture)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1720, 1000))
    await expect(page.getByTestId('session-resources')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Session resources', exact: true })).toHaveCount(0)
    await expectChatColumnAligned(page)
    const composer = page.locator('[data-composer-target]:visible [contenteditable="true"]').last()
    await composer.fill('Share the prepared file for this project.')
    await composer.press('Enter')
    const card = page.locator('[data-chat-surface]:visible').last().getByTestId('session-resources')
    await expect(card.getByRole('button', { name: 'Changes', exact: false })).toBeVisible({ timeout: 60_000 })
    await expect(card.getByText('previous-output.txt')).toBeVisible({ timeout: 60_000 })
    await expect(card.getByText('Previous source', { exact: true })).toBeVisible({ timeout: 60_000 })
    const oldHash = await page.evaluate(() => window.location.hash)
    await page.locator('[data-slot="sidebar"] button').filter({ hasText: 'New chat' }).first().click()
    await expect(page.locator('[data-slot="home-surface"]')).toBeVisible()
    await expect(card).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Session resources', exact: true })).toHaveCount(0)
    await expectChatColumnAligned(page)
    // The workspace is still deliberately selected, and its real uncommitted
    // changes still exist; only the new conversation's sidebar is empty.
    await expect(page.locator('.coding-status-bar:visible')).toContainText('main')
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('Changed by the previous session\n')
    await page.screenshot({ path: testInfo.outputPath('new-chat-without-sidebar.png') })
    await page.evaluate(hash => {
      window.location.hash = hash
    }, oldHash)
    await expect(card.getByText('previous-output.txt')).toBeVisible({ timeout: 30_000 })
    await expect(card.getByText('Previous source', { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: /Changes/ })).toBeVisible()
  } finally {
    await app.close().catch(() => undefined)
    await mock.close()
    sandbox.cleanup()
  }
})

test('lists delivered document, spreadsheet, image and archive files and renders supported viewers', async ({}, testInfo) => {
  const sandbox = createSandbox('resource-formats')
  const document = path.join(sandbox.root, 'Report.docx')
  const spreadsheet = path.join(sandbox.root, 'Revenue.xlsx')
  const image = path.join(sandbox.root, 'Drawing.svg')
  const archive = path.join(sandbox.root, 'Bundle.zip')
  fs.writeFileSync(
    document,
    zipSync({
      '[Content_Types].xml': strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      ),
      '_rels/.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      ),
      'word/document.xml': strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly report content</w:t></w:r></w:p></w:body></w:document>'
      )
    })
  )
  fs.writeFileSync(
    spreadsheet,
    zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/></sheets></workbook>'
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Revenue</t></is></c><c r="B1"><v>1250</v></c></row></sheetData></worksheet>'
      )
    })
  )
  fs.writeFileSync(
    image,
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="blue"/></svg>'
  )
  fs.writeFileSync(archive, zipSync({ 'README.txt': strToU8('Archive output') }))
  const files = [document, spreadsheet, image, archive]
  const mock = await startMockServer({
    scriptedTurns: [
      {
        text: 'Sharing the prepared files.',
        toolCalls: files.map(file => ({ name: 'deliver_file', args: { path: file } }))
      },
      { text: 'All four files are ready.' }
    ]
  })
  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)
  const launched = await launchDesktop(buildAppEnv(sandbox))
  const fixture = { ...launched, sandbox, mock, mockUrl: mock.url, cleanup: async () => {} }
  const { app, page } = launched
  try {
    await waitForAppReady(fixture)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1720, 1000))
    const composer = page.locator('[data-composer-target]:visible [contenteditable="true"]').last()
    await expect(page.getByTestId('session-resources')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Session resources', exact: true })).toHaveCount(0)
    await expectChatColumnAligned(page)
    const toggle = page.getByRole('button', { name: 'Session resources', exact: true })
    await composer.fill('Share the prepared document, spreadsheet, drawing and archive.')
    await composer.press('Enter')
    const dock = page.getByTestId('session-resources').filter({ visible: true })
    for (const file of files)
      await expect(dock.getByRole('button', { name: new RegExp(path.basename(file)) })).toBeVisible({ timeout: 60_000 })
    await expectChatColumnAligned(page)
    await toggle.click()
    await expect(dock).toHaveCount(0)
    await expectChatColumnAligned(page)
    await toggle.click()
    await expect(dock).toBeVisible()
    await expectChatColumnAligned(page)
    // Type tags are the extension itself, the same in every language.
    await expect
      .poll(async () => (await dock.locator('.session-resource-type').allTextContents()).sort())
      .toEqual(['DOCX', 'SVG', 'XLSX', 'ZIP'])
    await dock.getByRole('button', { name: /Report.docx/ }).click()
    await expect(page.frameLocator('iframe[title="Report.docx"]').getByText('Quarterly report content')).toBeVisible({
      timeout: 20_000
    })
    // The viewer took the card's column: it steps aside instead of covering
    // the reply, and comes back over the transcript only when asked for.
    await expect(dock).toHaveCount(0)
    await expectTranscriptUncovered(page)
    await expectChatColumnAligned(page)
    await toggle.click()
    await expect(dock).toBeVisible()
    // Opening one file after another keeps the list in reach.
    await page
      .getByTestId('session-resources')
      .getByRole('button', { name: /Revenue.xlsx/ })
      .click()
    await expect(page.getByRole('cell', { name: '1250' })).toBeVisible({ timeout: 20_000 })
    await page
      .getByTestId('session-resources')
      .getByRole('button', { name: /Drawing.svg/ })
      .click()
    await expect(page.locator('img[alt="Drawing.svg"]')).toBeVisible({ timeout: 20_000 })
    await expect(dock).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('resource-formats.png') })
    // Going back to the conversation puts the floating card away.
    await page
      .locator('[data-chat-surface]:visible [data-slot="aui_thread-content"]')
      .last()
      .click({ position: { x: 8, y: 8 } })
    await expect(dock).toHaveCount(0)
  } finally {
    await app.close().catch(() => undefined)
    await mock.close()
    sandbox.cleanup()
  }
})

test('collects real tool outputs, opens the large viewer, and adapts without overlap', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const sandbox = createSandbox('session-resources')
  const output = path.join(sandbox.root, 'Báo cáo kết quả.html')
  const archive = path.join(sandbox.root, 'dataset.custom')
  const source = path.join(sandbox.root, 'Source notes.md')
  fs.writeFileSync(source, 'Source notes for the resource-sidebar integration test.')
  const sourceUrl = 'https://example.com/research'
  const html =
    '<!doctype html><html><head><title>Resource viewer</title></head><body><h1>Session output preview</h1><p>Generated through the real agent tool loop.</p></body></html>'
  const mock = await startMockServer({
    scriptedTurns: [
      { text: 'Reading the input.', toolCalls: [{ name: 'read_file', args: { path: source } }] },
      { text: 'Creating the report.', toolCalls: [{ name: 'write_file', args: { path: output, content: html } }] },
      {
        text: 'Creating the data export.',
        toolCalls: [{ name: 'write_file', args: { path: archive, content: 'custom output format' } }]
      },
      { text: `Finished. [Report](<${output}>) [Research](${sourceUrl})` }
    ]
  })
  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)
  const launched = await launchDesktop(buildAppEnv(sandbox))
  const fixture = { ...launched, sandbox, mock, mockUrl: mock.url, cleanup: async () => {} }
  const { app, page } = launched
  try {
    await waitForAppReady(fixture)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1720, 1000))
    const composer = page.locator('[data-composer-target]:visible [contenteditable="true"]').last()
    await composer.fill(`Create a report from @file:\`${source}\` and ${sourceUrl}`)
    await composer.press('Enter')
    const dock = page.getByTestId('session-resources').filter({ visible: true })
    await expect(dock).toBeVisible({ timeout: 60_000 })
    await expect(dock.getByRole('button', { name: /Báo cáo kết quả.html/ })).toBeVisible({ timeout: 60_000 })
    await expect(dock.getByRole('button', { name: /dataset.custom/ })).toBeVisible({ timeout: 60_000 })
    await expect(
      dock.getByRole('region', { name: 'Sources', exact: true }).getByRole('button', { name: /Source notes.md/ })
    ).toBeVisible()
    expect(fs.readFileSync(output, 'utf8')).toBe(html)
    await expectChatColumnAligned(page)
    const layoutToggle = page.getByRole('button', { name: 'Session resources', exact: true })
    // Cross the resource-gutter breakpoint in both directions. Measure after
    // the native content resize arrives, with the card both shown and hidden.
    for (const width of [1280, 1530, 1720]) {
      const contentWidth = await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setSize(size, 1000)
        return window.getContentBounds().width
      }, width)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(contentWidth)
      const workspace = page.locator('[data-chat-surface]:visible .session-workspace').last()
      const docked = (await workspace.evaluate(element => element.clientWidth)) >= 1040
      await expect(workspace).toHaveAttribute('data-layout', docked ? 'docked' : 'floating')
      await expectChatColumnAligned(page)
      if (docked) {
        // Docked: shown by the remembered choice, beside the transcript.
        await expect(dock).toBeVisible()
        await expectTranscriptUncovered(page)
        await layoutToggle.click()
        await expect(dock).toHaveCount(0)
        await expectChatColumnAligned(page)
        await layoutToggle.click()
        await expect(dock).toBeVisible()
      } else {
        // Floating: closed until asked for, and closed again afterwards.
        await expect(dock).toHaveCount(0)
        await layoutToggle.click()
        await expect(dock).toBeVisible()
        await expectChatColumnAligned(page)
        await layoutToggle.click()
        await expect(dock).toHaveCount(0)
      }
      await expectChatColumnAligned(page)
    }
    await expect(dock).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('resources-wide.png') })
    const paint = await dock.evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, shadow: style.boxShadow, border: style.borderLeftWidth }
    })
    expect(paint.shadow).not.toBe('none')
    // The floating surface's shadow token supplies its one-pixel ring.
    expect(paint.border).toBe('0px')
    expect(paint.background).not.toBe('rgba(0, 0, 0, 0)')
    await dock.screenshot({ path: testInfo.outputPath('resources-card.png') })
    const layout = await dock.evaluate(element => {
      const panel = element.getBoundingClientRect()
      const chat = element
        .closest('.session-workspace')!
        .querySelector('[data-slot="composer-bounds"]')!
        .getBoundingClientRect()
      return { panelLeft: panel.left, chatRight: chat.right, panelRight: panel.right, width: window.innerWidth }
    })
    expect(layout.panelLeft).toBeGreaterThanOrEqual(layout.chatRight)
    expect(layout.panelRight).toBeLessThanOrEqual(layout.width)
    // Fixed descendants (the popped-out composer) must still use the viewport.
    const fixedOrigin = await page
      .locator('.session-conversation')
      .last()
      .evaluate(element => {
        const probe = document.createElement('div')
        probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;pointer-events:none'
        element.appendChild(probe)
        const { x, y } = probe.getBoundingClientRect()
        probe.remove()
        return { x, y }
      })
    expect(fixedOrigin).toEqual({ x: 0, y: 0 })
    await dock.getByRole('button', { name: /Báo cáo kết quả.html/ }).click()
    await expect(page.getByRole('tab', { name: /Báo cáo kết quả.html/ })).toBeVisible()
    const toggle = page.getByRole('button', { name: 'Session resources', exact: true })
    await expect(toggle).toBeVisible()
    // Beside the large viewer the chat is narrow: the card is put away and
    // the reply stays readable.
    await expect(dock).toHaveCount(0)
    await expectTranscriptUncovered(page)
    await expectChatColumnAligned(page)
    await page.screenshot({ path: testInfo.outputPath('resources-viewer.png') })
    await toggle.click()
    await expect(dock).toBeVisible()
    await expect(dock.getByRole('button', { name: /dataset.custom/ })).toBeVisible()
    await expectChatColumnAligned(page)
    await toggle.click()
    await expect(dock).toHaveCount(0)
    await expectChatColumnAligned(page)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 760))
    await expect(dock).toHaveCount(0)
    await toggle.click()
    await expect(dock).toBeVisible()
    await expectChatColumnAligned(page)
    const bounds = await dock.boundingBox()
    const windowWidth = await page.evaluate(() => window.innerWidth)
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(windowWidth)
    await page.screenshot({ path: testInfo.outputPath('resources-compact.png') })
    await page.reload()
    await waitForAppReady(fixture)
    await expect(toggle).toBeVisible({ timeout: 30_000 })
    await expect(dock).toHaveCount(0)
    await toggle.click()
    await expect(dock.getByRole('button', { name: /dataset.custom/ })).toBeVisible({ timeout: 30_000 })
  } finally {
    await app.close().catch(() => undefined)
    await mock.close()
    sandbox.cleanup()
  }
})
