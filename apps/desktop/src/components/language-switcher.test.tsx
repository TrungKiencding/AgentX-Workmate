import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { HermesConfigRecord } from '@/hermes'
import { type I18nConfigClient, I18nProvider } from '@/i18n'

import { LanguageSwitcher } from './language-switcher'

// Radix Popover + cmdk reach for ResizeObserver / scrollIntoView / pointer
// capture, none of which jsdom implements.
class TestResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

function renderSwitcher() {
  return render(
    <I18nProvider configClient={null}>
      <LanguageSwitcher />
    </I18nProvider>
  )
}

describe('LanguageSwitcher', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens in Vietnamese, the shipped default', () => {
    renderSwitcher()

    expect(screen.getByRole('button', { name: 'Đổi ngôn ngữ' }).textContent).toContain('Tiếng Việt')
  })

  it('lists Vietnamese first and marks it as the current language', async () => {
    renderSwitcher()

    fireEvent.click(screen.getByRole('button', { name: 'Đổi ngôn ngữ' }))

    const options = await screen.findAllByRole('option')

    // Curated order, default first — cmdk's fuzzy sort is off precisely so this
    // order survives (see the comment in language-switcher.tsx).
    expect(options.map(option => option.getAttribute('data-value'))).toEqual(['vi', 'en', 'zh', 'zh-hant', 'ja', 'ar'])
    expect(options[0].textContent).toContain('Tiếng Việt')

    // The current row is the emphasized one, and it is the only one whose check
    // mark is not hidden.
    expect(options[0].className).toContain('font-medium')
    expect(options.slice(1).every(option => option.className.includes('text-muted-foreground'))).toBe(true)

    // `className` on an SVG element is an SVGAnimatedString, so read the attribute.
    const checks = options.map(option => option.querySelector('svg')?.getAttribute('class') ?? '')
    expect(checks[0]).not.toContain('invisible')
    expect(checks.slice(1).every(check => check.includes('invisible'))).toBe(true)
  })

  it('persists language changes through display.language config', async () => {
    const saveConfig = vi.fn().mockResolvedValue({ ok: true })
    const latestConfig: HermesConfigRecord = { display: { language: 'vi', skin: 'slate' } }

    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue(latestConfig),
      saveConfig
    }

    render(
      <I18nProvider configClient={configClient}>
        <LanguageSwitcher />
      </I18nProvider>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Đổi ngôn ngữ' }).hasAttribute('disabled')).toBe(false)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Đổi ngôn ngữ' }))
    fireEvent.click(screen.getByRole('option', { name: /日本語/i }))

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1))
    expect(saveConfig).toHaveBeenCalledWith({ display: { language: 'ja', skin: 'slate' } })
  })

  it('finds Vietnamese by endonym, English name, and locale code', async () => {
    renderSwitcher()

    fireEvent.click(screen.getByRole('button', { name: 'Đổi ngôn ngữ' }))

    const search = await screen.findByPlaceholderText('Tìm ngôn ngữ…')

    for (const query of ['tiếng', 'vietnamese', 'vi']) {
      fireEvent.change(search, { target: { value: query } })
      await waitFor(() => expect(screen.getAllByRole('option')[0].textContent).toContain('Tiếng Việt'))
    }
  })
})
