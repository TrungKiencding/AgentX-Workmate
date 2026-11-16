import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { PanelPill, PanelRowMenu } from './panel'

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.setPointerCapture ??= () => undefined
  HTMLElement.prototype.scrollIntoView ??= () => undefined
})

describe('PanelRowMenu', () => {
  afterEach(() => {
    cleanup()
  })

  it('opens its actions menu from the kebab without a tooltip', async () => {
    const onSelect = vi.fn()

    render(<PanelRowMenu items={[{ label: 'Rename', onSelect }]} />)

    const trigger = screen.getByRole('button', { name: 'Actions' })

    expect(trigger.closest('[data-slot="tooltip-trigger"]')).toBeNull()

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))

    expect(onSelect).toHaveBeenCalledOnce()
  })
})

describe('PanelPill', () => {
  afterEach(() => {
    cleanup()
  })

  // CSS `capitalize` title-cased every word: the Vietnamese schedule state
  // "đã xong" read "Đã Xong", "đã hẹn giờ" read "Đã Hẹn Giờ".
  it('starts a label with a capital and leaves the other words alone', () => {
    render(<PanelPill>đã hẹn giờ</PanelPill>)

    const pill = screen.getByText('Đã hẹn giờ')
    expect(pill.className).not.toMatch(/\bcapitalize\b/)
  })

  it('shows an identifier exactly as written', () => {
    render(<PanelPill verbatim>pull_request</PanelPill>)

    expect(screen.getByText('pull_request')).toBeTruthy()
  })
})
