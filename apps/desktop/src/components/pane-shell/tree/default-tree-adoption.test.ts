import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'

import { allPaneIds, findGroupOfPane, group, split } from './model'
import {
  $dismissedPanes,
  $layoutTree,
  $userPlacedPanes,
  closeToolPane,
  declareDefaultTree,
  markActivePreset,
  revealTreePane,
  watchContributedPanes
} from './store'

// Ground truth for "the terminal shows up as a tab next to `sessions` in the
// left sidebar". Closing the terminal tab DISMISSES it (removed from the tree,
// remembered). On the next boot `declareDefaultTree` compared the persisted
// tree with the default, saw the terminal missing, found no sibling to stack it
// with (it sits alone in the default) and fell back to the FIRST group in the
// tree — the sessions column — ignoring the dismissal entirely.

const DEFAULT = split(
  'row',
  [
    group(['sessions'], { id: 'grp-sessions' }),
    group(['workspace'], { id: 'grp-main' }),
    split('column', [group(['files'], { id: 'grp-files' }), group(['terminal'], { id: 'grp-terminal' })], [1.6, 1])
  ],
  [1, 3.4, 1.25]
)

const disposers: (() => void)[] = []

beforeEach(() => {
  window.localStorage.clear()
  $dismissedPanes.set(new Set())
  $userPlacedPanes.set(new Set())
  markActivePreset('default')

  for (const [id, data] of [
    ['sessions', { placement: 'left' }],
    ['workspace', { placement: 'main', uncloseable: true }],
    ['files', { placement: 'right' }],
    ['terminal', { placement: 'bottom', dock: { pane: 'files', pos: 'bottom' } }]
  ] as const) {
    disposers.push(registry.register({ area: 'panes', data, id, render: () => null, title: id }))
  }
})

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
})

/** The persisted tree after the user closed the terminal tab. */
const treeWithoutTerminal = () =>
  split(
    'row',
    [
      group(['sessions'], { id: 'grp-sessions' }),
      group(['workspace'], { id: 'grp-main' }),
      group(['files'], { id: 'grp-files' })
    ],
    [1, 3.4, 1.25]
  )

describe('declaring the default tree over a persisted layout', () => {
  it('does not bring back a pane the user closed', () => {
    $layoutTree.set(DEFAULT)
    closeToolPane('terminal')

    expect($dismissedPanes.get().has('terminal')).toBe(true)

    // Next boot: same persisted tree, default declared again.
    declareDefaultTree(DEFAULT)
    watchContributedPanes()

    expect(allPaneIds($layoutTree.get()!)).not.toContain('terminal')
    expect(findGroupOfPane($layoutTree.get()!, 'sessions')?.panes).toEqual(['sessions'])
  })

  it('never stacks a sibling-less missing pane into the sessions column', () => {
    // Missing but NOT dismissed (e.g. a tree persisted before the pane existed).
    $layoutTree.set(treeWithoutTerminal())

    declareDefaultTree(DEFAULT)
    watchContributedPanes()

    const tree = $layoutTree.get()!

    expect(allPaneIds(tree)).toContain('terminal')
    expect(findGroupOfPane(tree, 'sessions')?.panes).toEqual(['sessions'])
    expect(findGroupOfPane(tree, 'terminal')?.panes).toEqual(['terminal'])
  })

  it('still stacks a missing pane with its default-tree sibling', () => {
    const withLogs = split('row', [group(['workspace'], { id: 'grp-main' }), group(['terminal', 'logs'], { id: 'g' })])
    $layoutTree.set(split('row', [group(['workspace'], { id: 'grp-main' }), group(['terminal'], { id: 'g2' })]))

    declareDefaultTree(withLogs)

    expect(findGroupOfPane($layoutTree.get()!, 'logs')?.panes).toEqual(['terminal', 'logs'])
  })

  it('re-docks the terminal under the files rail when it is reopened after Close', () => {
    $layoutTree.set(treeWithoutTerminal())
    $dismissedPanes.set(new Set(['terminal']))

    declareDefaultTree(DEFAULT)
    revealTreePane('terminal')

    const tree = $layoutTree.get()!

    expect(findGroupOfPane(tree, 'terminal')?.panes).toEqual(['terminal'])
    expect(findGroupOfPane(tree, 'sessions')?.panes).toEqual(['sessions'])
    expect(findGroupOfPane(tree, 'workspace')?.panes).toEqual(['workspace'])
  })
})

describe('healing a layout persisted by the old fallback', () => {
  const broken = () =>
    split(
      'row',
      [
        group(['sessions', 'terminal'], { active: 'sessions', headerHidden: false, id: 'grp-sessions' }),
        group(['workspace'], { id: 'grp-main' }),
        group(['files'], { id: 'grp-files' })
      ],
      [1, 3.4, 1.25]
    )

  it('drops a closed terminal stuck in the sessions column', () => {
    $layoutTree.set(broken())
    $dismissedPanes.set(new Set(['terminal']))

    declareDefaultTree(DEFAULT)

    const tree = $layoutTree.get()!

    expect(allPaneIds(tree)).not.toContain('terminal')
    expect(findGroupOfPane(tree, 'sessions')).toMatchObject({ panes: ['sessions'] })
    expect(findGroupOfPane(tree, 'sessions')?.headerHidden).not.toBe(false)
  })

  it('moves an open terminal out of the sessions column on the default layout', () => {
    $layoutTree.set(broken())

    declareDefaultTree(DEFAULT)

    const tree = $layoutTree.get()!

    expect(findGroupOfPane(tree, 'sessions')?.panes).toEqual(['sessions'])
    expect(findGroupOfPane(tree, 'terminal')?.panes).toEqual(['terminal'])
  })

  it('leaves a stack the user arranged on purpose', () => {
    $layoutTree.set(broken())
    $userPlacedPanes.set(new Set(['terminal']))

    declareDefaultTree(DEFAULT)

    expect(findGroupOfPane($layoutTree.get()!, 'sessions')?.panes).toEqual(['sessions', 'terminal'])
  })

  it('leaves a preset that stacks panes with sessions alone', () => {
    const quad = split('row', [
      group(['sessions', 'files'], { id: 'q1' }),
      group(['workspace', 'terminal'], { id: 'q2' })
    ])
    $layoutTree.set(quad)
    markActivePreset('quad')

    declareDefaultTree(DEFAULT)

    expect(findGroupOfPane($layoutTree.get()!, 'sessions')?.panes).toEqual(['sessions', 'files'])
  })
})
