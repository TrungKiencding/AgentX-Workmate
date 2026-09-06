import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PillTabs } from './pill-tabs'

// A pill tab row is one tablist, one active tab, one sliding indicator that
// is the list's FIRST child (so the tabs paint over it in DOM order) and never
// React state — switching tabs is a click that reports the id.

afterEach(() => {
  cleanup()
})

const TABS = [
  { id: 'skills', label: 'Kỹ năng', meta: 84 },
  { id: 'toolsets', label: 'Công cụ', meta: 24 },
  { id: 'hub', label: 'Cài thêm' }
]

describe('PillTabs', () => {
  it('renders a tablist with one active tab and a count beside each labelled one', () => {
    render(<PillTabs onChange={vi.fn()} tabs={TABS} value="toolsets" />)

    const tabs = screen.getAllByRole('tab')

    expect(tabs).toHaveLength(3)
    expect(tabs.map(tab => tab.getAttribute('data-active'))).toEqual(['false', 'true', 'false'])
    expect(screen.getByRole('tab', { name: /Kỹ năng/ }).textContent).toContain('84')
    expect(screen.getByRole('tab', { name: /Cài thêm/ }).textContent).toBe('Cài thêm')
  })

  it('keeps the sliding indicator as the first child of the list', () => {
    render(<PillTabs onChange={vi.fn()} tabs={TABS} value="skills" />)

    const list = screen.getByRole('tablist')

    expect(list.firstElementChild?.getAttribute('data-slot')).toBe('pill-tabs-indicator')
    expect(list.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
  })

  it('reports the clicked tab and nothing else', () => {
    const onChange = vi.fn()

    render(<PillTabs onChange={onChange} tabs={TABS} value="skills" />)
    fireEvent.click(screen.getByRole('tab', { name: /Công cụ/ }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('toolsets')
  })
})
