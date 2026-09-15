import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SearchField } from './search-field'

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: { ui: { search: { clear: 'Clear search' } } } })
}))

afterEach(cleanup)

const textbox = () => screen.getByRole('textbox', { name: 'Search' })
const focused = () => textbox().ownerDocument.activeElement

describe('SearchField', () => {
  it('inline: a borderless field that recedes while empty', () => {
    render(<SearchField onChange={vi.fn()} placeholder="Search" value="" />)

    expect(textbox().closest('label')).toBeNull()
    expect(textbox().parentElement?.className).toContain('opacity-30')
  })

  it('field: the whole well is a label in the shared input chrome, legible at rest', () => {
    render(<SearchField onChange={vi.fn()} placeholder="Search" value="" variant="field" />)

    const well = textbox().closest('label')

    expect(well?.className).toContain('desktop-input-chrome')
    expect(well?.className).not.toContain('opacity-30')
  })

  it.each(['inline', 'field'] as const)('%s: Escape clears a query and keeps the caret in the field', variant => {
    const onChange = vi.fn()

    render(<SearchField onChange={onChange} placeholder="Search" value="báo cáo" variant={variant} />)
    textbox().focus()
    fireEvent.keyDown(textbox(), { key: 'Escape' })

    expect(onChange).toHaveBeenCalledWith('')
    expect(focused()).toBe(textbox())
  })

  it('Escape on an empty field lets go of focus', () => {
    render(<SearchField onChange={vi.fn()} placeholder="Search" value="" variant="field" />)
    textbox().focus()
    fireEvent.keyDown(textbox(), { key: 'Escape' })

    expect(focused()).not.toBe(textbox())
  })

  it('leaves Escape to an IME that is still composing', () => {
    const onChange = vi.fn()

    render(<SearchField onChange={onChange} placeholder="Search" value="bao" variant="field" />)
    textbox().focus()
    fireEvent.keyDown(textbox(), { isComposing: true, key: 'Escape' })

    expect(onChange).not.toHaveBeenCalled()
    expect(focused()).toBe(textbox())
  })

  it('routes clearing through onClear when one is given', () => {
    const onChange = vi.fn()
    const onClear = vi.fn()

    render(<SearchField onChange={onChange} onClear={onClear} placeholder="Search" value="abc" />)
    fireEvent.keyDown(textbox(), { key: 'Escape' })

    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('hands focus back to the input after the clear button empties it', () => {
    const onChange = vi.fn()

    render(<SearchField onChange={onChange} placeholder="Search" value="abc" variant="field" />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(onChange).toHaveBeenCalledWith('')
    expect(focused()).toBe(textbox())
  })
})
