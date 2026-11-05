import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Contribution } from '@/contrib/types'

import { contributedNavItems } from './contributed-nav'

const nav = (id: string, data: unknown): Contribution => ({ area: 'sidebar.nav', data, id }) as Contribution

describe('contributedNavItems', () => {
  it('maps a plain contribution to a route row', () => {
    const [row] = contributedNavItems([nav('kanban', { codicon: 'project', label: 'Kanban', path: '/kanban' })], 'en')

    expect(row).toMatchObject({ id: 'kanban', label: 'Kanban', route: '/kanban' })
  })

  it('resolves a function label for the active locale', () => {
    const label = (locale: string) => (locale === 'vi' ? 'Trợ lý' : 'Assistants')
    const contributions = [nav('bots', { codicon: 'hubot', label, path: '/bots' })]

    expect(contributedNavItems(contributions, 'vi')[0].label).toBe('Trợ lý')
    expect(contributedNavItems(contributions, 'en')[0].label).toBe('Assistants')
  })

  it('drops rows without an absolute path or a label', () => {
    expect(
      contributedNavItems(
        [nav('a', { label: 'A', path: 'relative' }), nav('b', { label: '', path: '/b' }), nav('c', undefined)],
        'en'
      )
    ).toEqual([])
  })

  it('tints the glyph by name and keeps the neutral ink otherwise', () => {
    const [tinted, plain] = contributedNavItems(
      [nav('t', { codicon: 'hubot', label: 'T', path: '/t', tint: 'teal' }), nav('p', { label: 'P', path: '/p' })],
      'en'
    )

    const tintedIcon = render(<tinted.icon className="text-(--icon-default)" />).container.firstElementChild!
    const plainIcon = render(<plain.icon className="text-(--icon-default)" />).container.firstElementChild!

    expect(tintedIcon.className).toContain('text-(--tint-teal)')
    expect(tintedIcon.className).not.toContain('text-(--icon-default)')
    expect(tintedIcon.className).toContain('codicon-hubot')
    expect(plainIcon.className).toContain('text-(--icon-default)')
    expect(plainIcon.className).toContain('codicon-plug')
  })
})
