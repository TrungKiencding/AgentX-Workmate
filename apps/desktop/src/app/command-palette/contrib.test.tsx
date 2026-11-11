import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createPluginContext } from '@/contrib/plugin'

import { PALETTE_AREA, resolveContributedLabel, usePaletteContributions } from './contrib'

// Pilot 2026-11-10 ("language switching is not in sync"): the palette row an
// assistant plugin contributed stayed in the language the app booted in.
describe('contributed palette rows follow the app language', () => {
  it('reads a function label on every render', () => {
    const ctx = createPluginContext('palette-i18n')
    let language = 'vi'

    const dispose = ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'palette-i18n.open',
        label: () => (language === 'vi' ? 'Mở Trợ lý' : 'Open Assistants'),
        run: () => undefined
      }
    })

    const { result, rerender } = renderHook(() => usePaletteContributions())
    const label = () => result.current.find(row => row.id === 'palette-i18n.open')?.label

    expect(label()).toBe('Mở Trợ lý')

    language = 'en'
    rerender()
    expect(label()).toBe('Open Assistants')

    dispose()
  })

  it('still takes a plain string', () => {
    expect(resolveContributedLabel('Toggle status bar')).toBe('Toggle status bar')
    expect(resolveContributedLabel(undefined)).toBe('')
  })
})
