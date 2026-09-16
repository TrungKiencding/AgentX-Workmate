import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as PreviewStore from '@/store/preview'

const openPreview = vi.fn()

vi.mock('@/store/preview', async () => ({
  ...(await vi.importActual<typeof PreviewStore>('@/store/preview')),
  openPreview: (...args: unknown[]) => openPreview(...args)
}))

import { FileChip } from './file-chip'

describe('FileChip', () => {
  let original: unknown

  beforeEach(() => {
    original = window.agentxDesktop
    Object.defineProperty(window, 'agentxDesktop', {
      configurable: true,
      value: {
        normalizePreviewTarget: vi.fn(async (target: string) => ({
          kind: 'file',
          label: 'chart.png',
          path: target,
          previewKind: 'image',
          source: target,
          url: `file://${target}`
        }))
      }
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
    vi.clearAllMocks()
  })

  it('renders the file name inline and opens the preview on click', async () => {
    render(
      <p>
        Saved to <FileChip path="/tmp/out/chart.png" /> for you.
      </p>
    )

    const chip = screen.getByRole('button', { name: 'Open: chart.png' })

    expect(chip.textContent).toBe('chart.png')
    expect(chip.tagName).toBe('BUTTON')

    fireEvent.click(chip)
    await act(async () => {})

    expect(openPreview).toHaveBeenCalledTimes(1)
    expect(openPreview.mock.calls[0][0]).toMatchObject({ path: '/tmp/out/chart.png', previewKind: 'image' })
  })
})
