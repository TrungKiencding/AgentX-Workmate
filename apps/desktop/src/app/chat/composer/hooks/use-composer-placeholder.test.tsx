import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type I18nConfigClient, I18nProvider, TRANSLATIONS, useI18n } from '@/i18n'

import { useComposerPlaceholder } from './use-composer-placeholder'

interface Props {
  codingContext?: boolean
  sessionId: null | string
}

// Mounted the way src/main.tsx mounts it: no `initialLocale`, so the provider
// opens on DEFAULT_LOCALE (vi) and moves to `display.language` only once
// getConfig() resolves — after the composer has already picked its line.
function renderPlaceholder(initialProps: Props) {
  const configClient: I18nConfigClient = {
    getConfig: vi.fn().mockResolvedValue({ display: { language: 'en' } }),
    saveConfig: vi.fn().mockResolvedValue({ ok: true })
  }

  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider configClient={configClient}>{children}</I18nProvider>
  )

  return renderHook(
    ({ codingContext, sessionId }: Props) => ({
      i18n: useI18n(),
      placeholder: useComposerPlaceholder({ codingContext, disabled: false, reconnecting: false, sessionId })
    }),
    { initialProps, wrapper }
  )
}

describe('useComposerPlaceholder', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('re-picks the new-chat starter in display.language once the config loads', async () => {
    const { result } = renderPlaceholder({ sessionId: null })

    expect(result.current.placeholder).toBe('Bạn cần làm gì hôm nay?')

    await waitFor(() => expect(result.current.i18n.isLoadingConfig).toBe(false))

    expect(result.current.i18n.locale).toBe('en')
    expect(result.current.placeholder).toBe('What do you need today?')
  })

  it('re-picks a conversation follow-up in the language chosen in settings', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const { result } = renderPlaceholder({ sessionId: 'session-1' })

    await waitFor(() => expect(result.current.i18n.isLoadingConfig).toBe(false))
    expect(result.current.placeholder).toBe("What's next?")

    await act(() => result.current.i18n.setLocale('vi'))

    expect(result.current.placeholder).toBe('Tiếp theo là gì?')
  })

  it('keeps a fresh chat on its starter through the null→id persist, in any language', async () => {
    const { rerender, result } = renderPlaceholder({ sessionId: null })

    await waitFor(() => expect(result.current.i18n.isLoadingConfig).toBe(false))
    expect(result.current.placeholder).toBe('What do you need today?')

    rerender({ sessionId: 'session-1' })
    expect(result.current.placeholder).toBe('What do you need today?')

    await act(() => result.current.i18n.setLocale('vi'))
    expect(result.current.placeholder).toBe('Bạn cần làm gì hôm nay?')

    // Moving to a genuinely different conversation still re-rolls, to a follow-up.
    rerender({ sessionId: 'session-2' })
    expect(TRANSLATIONS.vi.composer.followUpPlaceholders).toContain(result.current.placeholder)
  })

  it('moves the starter to the coding voice when the folder probe lands', async () => {
    const { rerender, result } = renderPlaceholder({ codingContext: false, sessionId: null })

    await waitFor(() => expect(result.current.i18n.isLoadingConfig).toBe(false))
    expect(result.current.placeholder).toBe('What do you need today?')

    rerender({ codingContext: true, sessionId: null })
    expect(result.current.placeholder).toBe('Ask about the code or hand over a task…')
  })
})
