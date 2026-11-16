import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Tip } from './tooltip'

afterEach(cleanup)

// A Radix trigger lets props from outside win over its own, so a `Tip` around
// `DropdownMenuTrigger asChild` used to hand the button the TOOLTIP's
// `data-state` — `closed` while its menu was open — and every
// `data-[state=open]:` style on a tooltip-wrapped trigger silently never
// applied (the composer's ⋯ menu, the titlebar's ⋯, the model picker…).
describe('a Tip-wrapped trigger keeps its own open state', () => {
  it('a dropdown trigger reads open while its menu is open', () => {
    render(
      <DropdownMenu open>
        <Tip label="More">
          <DropdownMenuTrigger asChild>
            <button type="button">More</button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    // An open modal menu marks the rest of the page aria-hidden.
    const trigger = screen.getByRole('button', { hidden: true, name: 'More' })

    expect(trigger.getAttribute('data-state')).toBe('open')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('…and closed once it closes', () => {
    render(
      <DropdownMenu open={false}>
        <Tip label="More">
          <DropdownMenuTrigger asChild>
            <button type="button">More</button>
          </DropdownMenuTrigger>
        </Tip>
      </DropdownMenu>
    )

    expect(screen.getByRole('button', { name: 'More' }).getAttribute('data-state')).toBe('closed')
  })

  it('a popover trigger too', () => {
    render(
      <Popover open>
        <Tip label="Folder">
          <PopoverTrigger asChild>
            <button type="button">Folder</button>
          </PopoverTrigger>
        </Tip>
        <PopoverContent>Body</PopoverContent>
      </Popover>
    )

    expect(screen.getByRole('button', { name: 'Folder' }).getAttribute('data-state')).toBe('open')
  })
})

describe('the Tip seam stays transparent', () => {
  it('passes the ref, the tooltip-trigger slot and the click handler through', () => {
    const ref = createRef<HTMLButtonElement>()
    const onClick = vi.fn()

    render(
      <Tip label="Send">
        <button onClick={onClick} ref={ref} type="button">
          Send
        </button>
      </Tip>
    )

    const button = screen.getByRole('button', { name: 'Send' })

    expect(ref.current).toBe(button)
    expect(button.getAttribute('data-slot')).toBe('tooltip-trigger')
    // A plain button carries no tooltip state for styles to mistake for its own.
    expect(button.hasAttribute('data-state')).toBe(false)

    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('a child that sets its own data-state keeps it', () => {
    render(
      <Tip label="Jump">
        <button data-state="in" type="button">
          Jump
        </button>
      </Tip>
    )

    expect(screen.getByRole('button', { name: 'Jump' }).getAttribute('data-state')).toBe('in')
  })
})
