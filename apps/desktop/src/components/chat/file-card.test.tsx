import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pickRevealLabel } from '@/app/right-sidebar/file-actions'
import type * as PreviewStore from '@/store/preview'
import { $connection } from '@/store/session'

const openPreview = vi.fn()
const statPath = vi.fn()
const saveFileCopy = vi.fn()
const revealPath = vi.fn()

vi.mock('@/store/preview', async () => ({
  ...(await vi.importActual<typeof PreviewStore>('@/store/preview')),
  openPreview: (...args: unknown[]) => openPreview(...args)
}))

import { FileCard } from './file-card'

function installBridge() {
  const original = window.agentxDesktop
  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    value: {
      normalizePreviewTarget: vi.fn(async (target: string) => ({
        kind: 'file',
        label: 'report.docx',
        path: target,
        previewKind: 'document',
        source: target,
        url: `file://${target}`
      })),
      revealPath,
      saveFileCopy,
      statPath
    }
  })

  return () => Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
}

const REVEAL_LABEL = pickRevealLabel('Reveal in Finder', 'Reveal in File Explorer', 'Open Containing Folder')

describe('FileCard', () => {
  let restore: () => void

  beforeEach(() => {
    restore = installBridge()
    statPath.mockResolvedValue({
      byteSize: 24_576,
      exists: true,
      isFile: true,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      modifiedMs: 1,
      path: '/tmp/report.docx'
    })
    saveFileCopy.mockResolvedValue({ ok: true, path: '/tmp/copy.docx' })
    revealPath.mockResolvedValue(true)
  })

  afterEach(() => {
    cleanup()
    restore()
    vi.clearAllMocks()
    $connection.set(null)
  })

  it('shows the file identity and opens the preview rail on click', async () => {
    await act(async () => {
      render(<FileCard file={{ name: 'report.docx', path: '/tmp/report.docx', sizeBytes: 100 }} />)
    })

    // The stat wins over the caller's size, and the kind reads as a word.
    expect(await screen.findByText('Document · 24 KB')).toBeTruthy()
    expect(screen.getByText('report.docx')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open: report.docx' }))
    await act(async () => {})

    expect(openPreview).toHaveBeenCalledTimes(1)
    expect(openPreview.mock.calls[0][0]).toMatchObject({
      kind: 'file',
      path: '/tmp/report.docx',
      previewKind: 'document'
    })
    // Opening from a card is a tool hand-over, so an HTML file would run, not show source.
    expect(openPreview.mock.calls[0][1]).toBe('tool-result')
  })

  it('offers download and reveal as real buttons under the panel', async () => {
    await act(async () => {
      render(<FileCard file={{ name: 'report.docx', path: '/tmp/report.docx' }} />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await act(async () => {})
    expect(saveFileCopy).toHaveBeenCalledWith('/tmp/report.docx')

    // The reveal label follows the host platform (Finder / Explorer / file manager).
    fireEvent.click(screen.getByRole('button', { name: REVEAL_LABEL }))
    await act(async () => {})
    expect(revealPath).toHaveBeenCalledWith('/tmp/report.docx')
  })

  it('says when the file is gone and disables opening it', async () => {
    statPath.mockResolvedValue({
      byteSize: 0,
      exists: false,
      isFile: false,
      mimeType: '',
      modifiedMs: 0,
      path: '/tmp/gone.pdf'
    })

    await act(async () => {
      render(<FileCard file={{ name: 'gone.pdf', path: '/tmp/gone.pdf' }} />)
    })

    expect(await screen.findByText('File not found')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Open: gone.pdf' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('hides local-only actions on a remote gateway', async () => {
    $connection.set({ mode: 'remote' } as never)

    await act(async () => {
      render(<FileCard file={{ name: 'report.docx', path: '/tmp/report.docx' }} />)
    })

    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: REVEAL_LABEL })).toBeNull()
  })

  it('shows the caption the agent gave', async () => {
    await act(async () => {
      render(<FileCard file={{ caption: 'Q3 summary, 4 pages', name: 'q3.pdf', path: '/tmp/q3.pdf' }} />)
    })

    expect(screen.getByText('Q3 summary, 4 pages')).toBeTruthy()
  })
})
