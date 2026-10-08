import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { GenerateButton } from './generate-button'

describe('GenerateButton', () => {
  it('generates on click', () => {
    const onGenerate = vi.fn()

    render(<GenerateButton generating={false} label="Generate idea" onGenerate={onGenerate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Generate idea' }))

    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('blocked, it stays visibly off, does nothing, and can still be hovered for the reason', () => {
    const onGenerate = vi.fn()

    render(
      <GenerateButton
        blockedReason="Workmate is in read-only mode."
        generating={false}
        label="Generate idea"
        onGenerate={onGenerate}
      />
    )

    const button = screen.getByRole('button', { name: 'Generate idea' })

    expect(button.getAttribute('aria-disabled')).toBe('true')
    // Not the `disabled` attribute: that would swallow the hover the tooltip needs.
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(onGenerate).not.toHaveBeenCalled()
  })

  it('a generation already running can still be cancelled', () => {
    const onCancel = vi.fn()

    render(
      <GenerateButton
        blockedReason="Workmate is in read-only mode."
        generating
        generatingLabel="Stop"
        label="Generate idea"
        onCancel={onCancel}
        onGenerate={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
