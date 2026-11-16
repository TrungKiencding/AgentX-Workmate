import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { colorAlongSteps, DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'

import { type FastControl, ModelOptionsSection, resolveFastControl } from './model-options-section'

// Radix calls these on open; jsdom doesn't implement them.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderSection(
  opts: {
    defaultEffort?: string
    effort?: string
    fastControl?: FastControl
    onSelectModel?: (model: string) => void
    onSetOptions?: (patch: { effort?: string; fast?: boolean }) => void
    reasoning?: boolean
  } = {}
) {
  const onSetOptions = vi.fn(opts.onSetOptions)
  const onSelectModel = vi.fn(opts.onSelectModel)

  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <DropdownMenuItem>above</DropdownMenuItem>
        <ModelOptionsSection
          defaultEffort={opts.defaultEffort ?? 'medium'}
          effort={opts.effort ?? ''}
          fastControl={opts.fastControl ?? { kind: 'none' }}
          onSelectModel={onSelectModel}
          onSetOptions={onSetOptions}
          reasoning={opts.reasoning ?? true}
        />
        <DropdownMenuItem>below</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return { onSelectModel, onSetOptions }
}

const notch = (name: string) => screen.getByRole('menuitemradio', { name })

const checkedNotch = () => screen.getAllByRole('menuitemradio').find(el => el.getAttribute('aria-checked') === 'true')

// The element that has focus, read off the rendered tree (no bare `document`).
const focused = () => screen.getByRole('menu').ownerDocument.activeElement

const slider = () => screen.getByRole('menu').querySelector<HTMLElement>('[data-slot="dropdown-menu-step-slider"]')!

describe('the thinking slider', () => {
  it('shows the inherited default as the chosen level, names it, and says it is the default', () => {
    renderSection({ defaultEffort: 'high', effort: '' })

    expect(checkedNotch()?.getAttribute('aria-label')).toBe('High')
    expect(screen.getByText('High')).toBeTruthy()
    expect(screen.getByText(/For complex work, takes longer/).textContent).toContain('· Default')
  })

  it('drops the default mark once you leave the default', () => {
    renderSection({ defaultEffort: 'medium', effort: 'max' })

    expect(checkedNotch()?.getAttribute('aria-label')).toBe('Max')
    expect(screen.getByText(/Thinks as hard as it can/).textContent).not.toContain('Default')
  })

  it('treats off as the first notch of the same scale, not a separate switch', () => {
    renderSection({ effort: 'none' })

    expect(checkedNotch()?.getAttribute('aria-label')).toBe('Off')
    expect(screen.getAllByRole('menuitemradio')[0]).toBe(checkedNotch())
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('labels its two ends', () => {
    renderSection()

    expect(screen.getByText('Faster')).toBeTruthy()
    expect(screen.getByText('Deeper')).toBeTruthy()
  })

  it('reports a picked notch and stays open — a setting, not a command', () => {
    const { onSetOptions } = renderSection({ effort: 'medium' })

    fireEvent.click(notch('High'))

    expect(onSetOptions).toHaveBeenCalledWith({ effort: 'high' })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('does not re-report the level you are already on', () => {
    const { onSetOptions } = renderSection({ effort: 'medium' })

    fireEvent.click(notch('Medium'))

    expect(onSetOptions).not.toHaveBeenCalled()
  })

  it('shows an off-scale level the session really runs at', () => {
    renderSection({ effort: 'ultra' })

    expect(checkedNotch()?.getAttribute('aria-label')).toBe('Ultra')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(7)
  })

  it('pressing on the track picks the nearest notch, and dragging follows the pointer', () => {
    const { onSetOptions } = renderSection({ effort: 'medium' })
    const track = slider().firstElementChild as HTMLElement

    // A 500px track from x=100: six notches, one every 100px.
    track.getBoundingClientRect = () => ({ left: 100, right: 600, width: 500 }) as DOMRect

    fireEvent.pointerDown(slider(), { button: 0, clientX: 590, pointerId: 1 })
    expect(onSetOptions).toHaveBeenLastCalledWith({ effort: 'max' })

    fireEvent.pointerMove(slider(), { clientX: 140, pointerId: 1 })
    expect(onSetOptions).toHaveBeenLastCalledWith({ effort: 'none' })

    fireEvent.pointerUp(slider(), { pointerId: 1 })
    onSetOptions.mockClear()
    fireEvent.pointerMove(slider(), { clientX: 400, pointerId: 1 })

    // Released: moving the pointer no longer drags.
    expect(onSetOptions).not.toHaveBeenCalled()
  })

  it('←/→ step the value like a native slider', () => {
    const { onSetOptions } = renderSection({ effort: 'medium' })

    notch('Medium').focus()
    fireEvent.keyDown(notch('Medium'), { key: 'ArrowRight' })
    expect(onSetOptions).toHaveBeenLastCalledWith({ effort: 'high' })
    // Moving within the slider keeps focus where the arrow sent it (the
    // "land on the thumb" redirect is only for arriving from outside).
    expect(focused()).toBe(notch('High'))

    fireEvent.keyDown(notch('Medium'), { key: 'ArrowLeft' })
    expect(onSetOptions).toHaveBeenLastCalledWith({ effort: 'low' })
  })

  it('→ at the last notch goes nowhere', () => {
    const { onSetOptions } = renderSection({ effort: 'max' })

    fireEvent.keyDown(notch('Max'), { key: 'ArrowRight' })

    expect(onSetOptions).not.toHaveBeenCalled()
  })

  it('is one stop in the ↑/↓ order: arrows leave the slider instead of walking it', () => {
    renderSection({ effort: 'medium' })

    notch('Medium').focus()
    fireEvent.keyDown(notch('Medium'), { key: 'ArrowDown' })
    expect(focused()?.textContent).toBe('below')

    notch('Medium').focus()
    fireEvent.keyDown(notch('Medium'), { key: 'ArrowUp' })
    expect(focused()?.textContent).toBe('above')
  })

  it('arriving by keyboard lands on the thumb, not the first notch', () => {
    renderSection({ effort: 'high' })

    // Roving focus from the row above lands on the slider's first notch…
    screen.getByText('above').focus()
    notch('Off').focus()

    // …and is handed straight to the checked one.
    expect(focused()).toBe(notch('High'))
  })

  it('is absent when the model takes no reasoning effort', () => {
    renderSection({ fastControl: { kind: 'param', on: false }, reasoning: false })

    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(screen.getByRole('menuitemcheckbox', { name: /Priority speed/ })).toBeTruthy()
  })

  it('renders nothing when the model has no options at all', () => {
    renderSection({ reasoning: false })

    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull()
  })
})

describe('colorAlongSteps', () => {
  const colors = ['red', 'green', 'blue']

  it('lands exactly on a stop colour at the stops', () => {
    expect(colorAlongSteps(colors, 0)).toBe('color-mix(in oklab, red 100%, green)')
    expect(colorAlongSteps(colors, 0.5)).toBe('color-mix(in oklab, green 100%, blue)')
    expect(colorAlongSteps(colors, 1)).toBe('color-mix(in oklab, green 0%, blue)')
  })

  it('mixes between neighbours and clamps outside 0…1', () => {
    expect(colorAlongSteps(colors, 0.25)).toBe('color-mix(in oklab, red 50%, green)')
    expect(colorAlongSteps(colors, -1)).toBe(colorAlongSteps(colors, 0))
    expect(colorAlongSteps(colors, 2)).toBe(colorAlongSteps(colors, 1))
  })

  it('a single colour is just that colour', () => {
    expect(colorAlongSteps(['teal'], 0.7)).toBe('teal')
  })
})

// The section is PURE: it reports edits and never writes to a session, a
// preset store, or the gateway. That's the invariant that lets the same menu
// drive a live chat session AND a detached per-task override — if it ever
// writes directly, picking an effort for a kanban card would reach over and
// change the user's live chat.
describe('the priority-speed row', () => {
  const row = () => screen.getByRole('menuitemcheckbox', { name: /Priority speed/ })

  it('param fast: the whole row toggles, reported as an edit', () => {
    const { onSelectModel, onSetOptions } = renderSection({ fastControl: { kind: 'param', on: true } })

    expect(row().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(row())

    expect(onSetOptions).toHaveBeenCalledWith({ fast: false })
    expect(onSelectModel).not.toHaveBeenCalled()
  })

  it('says it costs more, on the row itself', () => {
    renderSection({ fastControl: { kind: 'param', on: false } })

    expect(row().textContent).toContain('Faster replies at a higher price')
  })

  it('variant fast: reports the choice and swaps to the -fast sibling', () => {
    const { onSelectModel, onSetOptions } = renderSection({
      fastControl: { baseId: 'm1', fastId: 'm1-fast', kind: 'variant', on: false }
    })

    fireEvent.click(row())

    expect(onSetOptions).toHaveBeenCalledWith({ fast: true })
    expect(onSelectModel).toHaveBeenCalledWith('m1-fast')
  })

  it('variant fast: off swaps back to the base id', () => {
    const { onSelectModel } = renderSection({
      fastControl: { baseId: 'm1', fastId: 'm1-fast', kind: 'variant', on: true }
    })

    fireEvent.click(row())

    expect(onSelectModel).toHaveBeenCalledWith('m1')
  })

  it('the switch only mirrors state — it is not a second focus stop', () => {
    renderSection({ fastControl: { kind: 'param', on: false } })

    const toggle = row().querySelector('[data-slot="switch"]')

    expect(toggle?.getAttribute('tabindex')).toBe('-1')
    expect(toggle?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('resolveFastControl', () => {
  it('prefers the speed param when the backend supports it', () => {
    expect(resolveFastControl('m1', ['m1', 'm1-fast'], true, false)).toEqual({ kind: 'param', on: false })
  })

  it('falls back to a -fast sibling, from either side of the pair', () => {
    expect(resolveFastControl('m1', ['m1', 'm1-fast'], false, false)).toEqual({
      baseId: 'm1',
      fastId: 'm1-fast',
      kind: 'variant',
      on: false
    })
    expect(resolveFastControl('m1-fast', ['m1', 'm1-fast'], false, false)).toEqual({
      baseId: 'm1',
      fastId: 'm1-fast',
      kind: 'variant',
      on: true
    })
  })

  it('a lone -fast model has no off state to offer', () => {
    expect(resolveFastControl('m1-fast', ['m1-fast'], false, false)).toEqual({ kind: 'none' })
  })

  it('keeps a stranded speed param switchable so it can be turned off', () => {
    expect(resolveFastControl('m2', ['m2'], false, true)).toEqual({ kind: 'param', on: true })
    expect(resolveFastControl('m2', ['m2'], false, false)).toEqual({ kind: 'none' })
  })
})
