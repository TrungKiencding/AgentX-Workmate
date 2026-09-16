import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renderDocxPreview = vi.fn()

vi.mock('@/lib/docx-preview', () => ({
  renderDocxPreview: (...args: unknown[]) => renderDocxPreview(...args)
}))

import type { PreviewTarget } from '@/store/preview'

import { DocumentPreview, documentRenderer } from './preview-document'

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function xlsxBytes(): Uint8Array {
  return zipSync({
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="Doanh thu" sheetId="1" r:id="rId1"/><sheet name="Ghi chú" sheetId="2" r:id="rId2"/></sheets></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>'
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Quý</t></is></c><c r="B1"><v>1250</v></c></row></sheetData></worksheet>`
    ),
    'xl/worksheets/sheet2.xml': strToU8(`<?xml version="1.0"?><worksheet ${NS}><sheetData/></worksheet>`)
  })
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return `data:${mime};base64,${btoa(binary)}`
}

function target(path: string): PreviewTarget {
  return {
    kind: 'file',
    label: path.split('/').pop() || path,
    path,
    previewKind: 'document',
    source: path,
    url: `file://${path}`
  }
}

describe('documentRenderer', () => {
  it('knows which office files render in place', () => {
    expect(documentRenderer('/x/a.docx')).toBe('docx')
    expect(documentRenderer('/x/a.xlsx')).toBe('xlsx')
    expect(documentRenderer('/x/a.xlsm')).toBe('xlsx')
    expect(documentRenderer('/x/a.pptx')).toBeNull()
    expect(documentRenderer('/x/a.odt')).toBeNull()
  })
})

describe('DocumentPreview', () => {
  let original: unknown
  const readFileDataUrl = vi.fn()

  beforeEach(() => {
    original = window.agentxDesktop
    Object.defineProperty(window, 'agentxDesktop', {
      configurable: true,
      value: { readFileDataUrl, quickLookPath: vi.fn(), saveFileCopy: vi.fn(), revealPath: vi.fn() }
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
    vi.clearAllMocks()
  })

  it('renders a workbook as a table with a sheet strip', async () => {
    readFileDataUrl.mockResolvedValue(dataUrl(xlsxBytes(), 'application/octet-stream'))

    await act(async () => {
      render(<DocumentPreview reloadKey={0} target={target('/tmp/q3.xlsx')} />)
    })

    expect(await screen.findByText('Quý')).toBeTruthy()
    expect(screen.getByText('1250')).toBeTruthy()

    const tabs = screen.getAllByRole('tab')

    expect(tabs.map(tab => tab.textContent)).toEqual(['Doanh thu', 'Ghi chú'])

    fireEvent.click(tabs[1])

    expect(screen.getByText('Empty sheet')).toBeTruthy()
  })

  it('renders a word document in a frame that can only paint', async () => {
    readFileDataUrl.mockResolvedValue(dataUrl(new Uint8Array([80, 75, 3, 4]), 'application/octet-stream'))
    renderDocxPreview.mockResolvedValue({ html: '<h1>Báo cáo</h1><p>Nội dung</p>', warnings: [] })

    await act(async () => {
      render(<DocumentPreview reloadKey={0} target={target('/tmp/bao-cao.docx')} />)
    })

    const frame = (await screen.findByTitle('bao-cao.docx')) as HTMLIFrameElement

    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.srcdoc).toContain('<h1>Báo cáo</h1>')
    expect(renderDocxPreview).toHaveBeenCalledTimes(1)
  })

  it('explains a read failure instead of hanging', async () => {
    readFileDataUrl.mockRejectedValue(new Error('too large'))

    await act(async () => {
      render(<DocumentPreview reloadKey={0} target={target('/tmp/bao-cao.docx')} />)
    })

    expect(await screen.findByText("Couldn't open this document")).toBeTruthy()
    expect(screen.getByText('Could not read its content: too large')).toBeTruthy()
  })

  it('offers the ways out for a format without a renderer', async () => {
    await act(async () => {
      render(<DocumentPreview reloadKey={0} target={target('/tmp/deck.pptx')} />)
    })

    expect(screen.getByText('No preview for this file type yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open with default app' })).toBeTruthy()
    expect(readFileDataUrl).not.toHaveBeenCalled()
  })
})
