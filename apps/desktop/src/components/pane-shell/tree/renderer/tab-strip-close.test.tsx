import { useStore } from '@nanostores/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActionsContextMenu, renderActionItem } from '@/components/ui/actions-menu'
import { registry } from '@/contrib/registry'

import { findGroup, group, type GroupNode, type LayoutNode, split } from '../model'
import { $layoutTree, registerPaneCloser, setPaneCloserIdle } from '../store'

import { TreeGroup } from './tree-group'

// Ground truth for three user reports against the zone renderer: "Close" in a
// side zone's tab menu collapsed the zone to a rail instead of closing the
// tab, tabs had no close button, and the main chat lost its tab bar once a
// second chat zone sat beside it.

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('CSS', { ...globalThis.CSS, escape: (value: string) => value })
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => undefined
  Element.prototype.releasePointerCapture ??= () => undefined
  HTMLElement.prototype.scrollIntoView ??= () => undefined
})

const disposers: (() => void)[] = []
const menuClose = vi.fn()

/** The session tab's real shape: the tab wrapped in its own context menu, the
 *  wrapper swallowing contextmenu so the zone strip's menu stays shut. */
const tabWrap = (tab: ReactElement) => (
  <span className="contents" onContextMenu={event => event.stopPropagation()}>
    <ActionsContextMenu items={kit => renderActionItem(kit, { label: 'Close this chat', onSelect: menuClose })}>
      {tab}
    </ActionsContextMenu>
  </span>
)

// The drag machinery remembers the last tap (module state) to spot a double
// tap; a fresh second per test keeps one test's tap from pairing with the next.
let clock = Date.UTC(2026, 9, 15)

beforeEach(() => {
  clock += 1000
  vi.useFakeTimers({ now: clock, toFake: ['Date'] })
  window.localStorage.clear()
  menuClose.mockReset()

  for (const [id, data] of [
    ['workspace', { placement: 'main', uncloseable: true }],
    ['session-tile:a', { placement: 'main', tabWrap }],
    ['session-tile:b', { placement: 'main', tabWrap }]
  ] as const) {
    disposers.push(registry.register({ area: 'panes', data, id, render: () => null, title: id }))
  }
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  setPaneCloserIdle('workspace', false)
})

/** Renders a zone the way the real renderer does: re-read from the live tree,
 *  so a minimize really swaps the strip for the rail (and unmounts its menus). */
function LiveZone({ groupId, parentAxis }: { groupId: string; parentAxis: 'column' | 'row' }) {
  const tree = useStore($layoutTree)
  const node = tree ? findGroup(tree, groupId) : null

  return node ? <TreeGroup node={node} parentAxis={parentAxis} /> : null
}

const zone = (groupId: string): GroupNode | null => {
  const tree = $layoutTree.get()

  return tree ? findGroup(tree, groupId) : null
}

const tabEl = (paneId: string) => window.document.querySelector<HTMLElement>(`[data-tree-tab="${paneId}"]`)
const closeButtonOf = (paneId: string) => tabEl(paneId)?.querySelector<HTMLElement>('[data-pane-tab-close]') ?? null

function openContextMenu(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 2, pointerType: 'mouse' })
  fireEvent.contextMenu(target, { button: 2 })
}

/** A real mouse click: press, release (the drag machinery listens on window),
 *  then the click Radix selects on. */
function press(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(target, { button: 0, pointerType: 'mouse' })
  fireEvent.click(target)
}

const sideBySide = (): LayoutNode =>
  split('row', [
    group(['workspace'], { active: 'workspace', id: 'grp-main' }),
    group(['session-tile:a', 'session-tile:b'], { active: 'session-tile:a', id: 'grp-side' })
  ])

describe("a session tab's context menu", () => {
  it('runs the picked item without collapsing the side zone to a rail', async () => {
    $layoutTree.set(sideBySide())
    render(<LiveZone groupId="grp-side" parentAxis="row" />)

    openContextMenu(tabEl('session-tile:a')!)
    press(await screen.findByRole('menuitem', { name: 'Close this chat' }))

    expect(menuClose).toHaveBeenCalledTimes(1)
    expect(zone('grp-side')?.minimized).toBeFalsy()
    expect(tabEl('session-tile:a')).toBeTruthy()
  })

  it('still collapses the zone when the strip itself is tapped', () => {
    $layoutTree.set(sideBySide())
    render(<LiveZone groupId="grp-side" parentAxis="row" />)

    press(window.document.querySelector<HTMLElement>('[data-zone-tabstrip="grp-side"]')!)

    expect(zone('grp-side')?.minimized).toBe(true)
  })
})

describe('the tab close button', () => {
  it('closes the tab it sits on — without fronting it or touching the zone', () => {
    const closeB = vi.fn()
    registerPaneCloser('session-tile:b', closeB)
    $layoutTree.set(sideBySide())
    render(<LiveZone groupId="grp-side" parentAxis="row" />)

    const button = closeButtonOf('session-tile:b')
    expect(button?.getAttribute('aria-label')).toBe('Close session-tile:b')

    press(button!)

    expect(closeB).toHaveBeenCalledTimes(1)
    expect(zone('grp-side')?.active).toBe('session-tile:a')
    expect(zone('grp-side')?.minimized).toBeFalsy()
    registerPaneCloser('session-tile:b')
  })

  it('hides on the main tab while its closer has nothing to close', () => {
    registerPaneCloser('workspace', () => undefined)
    $layoutTree.set(group(['workspace'], { active: 'workspace', headerHidden: false, id: 'grp-main' }))
    render(<LiveZone groupId="grp-main" parentAxis="row" />)

    expect(closeButtonOf('workspace')).toBeTruthy()

    setPaneCloserIdle('workspace', true)
    cleanup()
    render(<LiveZone groupId="grp-main" parentAxis="row" />)

    expect(tabEl('workspace')).toBeTruthy()
    expect(closeButtonOf('workspace')).toBeNull()
    registerPaneCloser('workspace')
  })

  it('stays off a collapsed rail, which is too narrow for a second target', () => {
    registerPaneCloser('session-tile:a', () => undefined)
    $layoutTree.set(
      split('row', [
        group(['workspace'], { active: 'workspace', id: 'grp-main' }),
        group(['session-tile:a'], { active: 'session-tile:a', id: 'grp-side', minimized: true })
      ])
    )
    render(<LiveZone groupId="grp-side" parentAxis="row" />)

    expect(tabEl('session-tile:a')).toBeTruthy()
    expect(closeButtonOf('session-tile:a')).toBeNull()
    registerPaneCloser('session-tile:a')
  })
})

describe('the main zone tab bar beside another chat zone', () => {
  const stacked = (mainHeaderHidden?: boolean): LayoutNode =>
    split('column', [
      group(['session-tile:a'], { active: 'session-tile:a', id: 'grp-top' }),
      group(['workspace'], { active: 'workspace', headerHidden: mainHeaderHidden, id: 'grp-main' })
    ])

  it('auto-hides while main is the only chat zone', () => {
    $layoutTree.set(group(['workspace'], { active: 'workspace', id: 'grp-main' }))
    render(<LiveZone groupId="grp-main" parentAxis="row" />)

    expect(tabEl('workspace')).toBeNull()
  })

  it('shows once a session tile zone sits beside it', () => {
    $layoutTree.set(stacked())
    render(<LiveZone groupId="grp-main" parentAxis="column" />)

    expect(tabEl('workspace')).toBeTruthy()
  })

  it('outranks an earlier explicit hide, and offers no Hide toggle meanwhile', async () => {
    $layoutTree.set(stacked(true))
    render(<LiveZone groupId="grp-main" parentAxis="column" />)

    const tab = tabEl('workspace')
    expect(tab).toBeTruthy()

    openContextMenu(tab!)
    await screen.findByRole('menuitem', { name: /reload/i })

    expect(screen.queryByRole('menuitem', { name: /hide header/i })).toBeNull()
  })
})
