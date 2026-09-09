#!/usr/bin/env node
/**
 * Capture the screenshots the "Kết nối trình duyệt" step shows beside its
 * three steps: the real extensions page of Chrome / Edge / Brave with
 * Developer mode switched on, in Vietnamese and English.
 *
 * Runs each browser found on this machine in a THROWAWAY profile (a temp
 * user-data-dir), so the person's own browser and profiles are never touched.
 * Output: src/assets/webmate/<browser>-<lang>.png (1280×720 @2x), which
 * `npm run webmate:shots:pack` (or the Python one-liner in the plan) turns
 * into the ~800 px WebP files the panel bundles.
 *
 *   node scripts/webmate-guide-shots.mjs            # every browser found
 *   node scripts/webmate-guide-shots.mjs chrome vi  # one browser, one language
 *
 * The browser is spawned directly (not through Playwright's launcher) so the
 * launch can carry `-AppleLanguages (vi)`: on macOS Chromium's UI language
 * follows the app's preferred languages, and that per-launch Cocoa argument
 * overrides them without writing any preference. `--lang` covers Windows and
 * Linux. Playwright then attaches over CDP to drive the page.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(here, '..', 'src', 'assets', 'webmate')
const [onlyBrowser, onlyLang] = process.argv.slice(2)

const BROWSERS = {
  chrome: {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    linux: '/usr/bin/google-chrome',
    url: 'chrome://extensions'
  },
  edge: {
    darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    win32: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    linux: '/usr/bin/microsoft-edge',
    url: 'edge://extensions'
  },
  brave: {
    darwin: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    win32: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    linux: '/usr/bin/brave-browser',
    url: 'brave://extensions'
  }
}

const LANGS = { vi: 'vi', en: 'en-US' }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()

    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()

      probe.close(() => resolve(port))
    })
  })
}

async function waitForCdp(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)

      if (response.ok) {
        return
      }
    } catch {
      /* not up yet */
    }

    await sleep(200)
  }

  throw new Error(`CDP on port ${port} did not come up`)
}

async function shoot(browserId, lang) {
  const spec = BROWSERS[browserId]
  const executablePath = spec[process.platform]

  if (!executablePath || !existsSync(executablePath)) {
    console.log(`- ${browserId}: not installed, skipped`)

    return
  }

  const userDataDir = mkdtempSync(path.join(tmpdir(), `webmate-shots-${browserId}-`))
  const port = await freePort()

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--lang=${LANGS[lang]}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--window-size=1280,800',
    '--window-position=0,0',
    'about:blank'
  ]

  if (process.platform === 'darwin') {
    args.unshift('-AppleLanguages', `(${LANGS[lang]})`)
  }

  const child = spawn(executablePath, args, { stdio: 'ignore' })
  let browser = null

  try {
    await waitForCdp(port)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const context = browser.contexts()[0] ?? (await browser.newContext())
    const page = context.pages()[0] ?? (await context.newPage())

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(spec.url, { waitUntil: 'load' })
    await sleep(800)

    // The dev-mode toggle lives a few shadow roots deep; Playwright's CSS
    // engine pierces open shadow DOM, so plain selectors reach it. Chrome and
    // Brave: cr-toggle#devMode (aria-pressed). Edge: fluent-switch#dev-switch.
    const toggle = page.locator('#devMode, #dev-switch').first()

    await toggle.waitFor({ timeout: 15_000 })

    const isOn = async () =>
      (await toggle.getAttribute('aria-pressed')) === 'true' ||
      (await toggle.getAttribute('aria-checked')) === 'true' ||
      (await toggle.evaluate(el => Boolean(el.checked)))

    if (!(await isOn())) {
      await toggle.click()
      await sleep(600)
    }

    await page.mouse.move(5, 5)
    await sleep(400)

    const heading = await page.evaluate(() => document.title)
    const uiLang = await page.evaluate(() => document.documentElement.lang || navigator.language)
    const file = path.join(OUT_DIR, `${browserId}-${lang}.png`)

    mkdirSync(OUT_DIR, { recursive: true })
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1280, height: 720 } })
    console.log(`- ${browserId}/${lang}: ${file} (title "${heading}", ui lang ${uiLang})`)
  } catch (error) {
    console.log(`- ${browserId}/${lang}: failed — ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await browser?.close().catch(() => undefined)
    child.kill()
    await sleep(500)
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

for (const browserId of Object.keys(BROWSERS)) {
  if (onlyBrowser && browserId !== onlyBrowser) {
    continue
  }

  for (const lang of Object.keys(LANGS)) {
    if (onlyLang && lang !== onlyLang) {
      continue
    }

    await shoot(browserId, lang)
  }
}
