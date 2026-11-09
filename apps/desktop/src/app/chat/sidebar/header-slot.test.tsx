import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'

import { SIDEBAR_HEADER_AREA } from '../../routes'

import { SidebarHeaderSlot } from './header-slot'

afterEach(cleanup)

describe('SidebarHeaderSlot', () => {
  it('reserves no space without controls, and removes them on plugin unload', () => {
    const view = render(<SidebarHeaderSlot />)
    expect(view.container.childElementCount).toBe(0)

    let dispose = () => {}

    act(() => {
      dispose = registry.register({
        id: 'header-test',
        area: SIDEBAR_HEADER_AREA,
        render: () => <button>Workspace navigation</button>
      })
    })

    expect(
      screen.getByRole('button', { name: 'Workspace navigation' }).closest('[data-sidebar="header"]')
    ).not.toBeNull()
    act(dispose)
    expect(view.container.childElementCount).toBe(0)
  })
})
