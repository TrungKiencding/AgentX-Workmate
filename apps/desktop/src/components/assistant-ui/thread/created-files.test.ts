import { describe, expect, it } from 'vitest'

import { createdFilesFromPayload, deriveCreatedFiles, pathsShownInParts } from './created-files'

const FILES = [
  { name: 'report.docx', path: '/tmp/report.docx', sizeBytes: 10 },
  { name: 'chart.png', path: '/tmp/chart.png', sizeBytes: 20 },
  { name: 'data.csv', path: '/tmp/data.csv', sizeBytes: 30 }
]

describe('createdFilesFromPayload', () => {
  it('maps the gateway records and tolerates junk entries', () => {
    expect(
      createdFilesFromPayload([
        { path: '/tmp/a.pdf', name: 'a.pdf', size_bytes: 5, mime_type: 'application/pdf', modified_at: 1.5 },
        { path: '/tmp/b.zip' },
        { nope: true },
        'x',
        null
      ])
    ).toEqual([
      { mimeType: 'application/pdf', modifiedMs: 1500, name: 'a.pdf', path: '/tmp/a.pdf', sizeBytes: 5 },
      { mimeType: undefined, modifiedMs: undefined, name: 'b.zip', path: '/tmp/b.zip', sizeBytes: undefined }
    ])
  })

  it('is empty for a missing or malformed payload', () => {
    expect(createdFilesFromPayload(undefined)).toEqual([])
    expect(createdFilesFromPayload({ path: '/tmp/a.pdf' })).toEqual([])
  })
})

describe('pathsShownInParts', () => {
  it('collects deliver_file results and file/media links in text', () => {
    const shown = pathsShownInParts([
      { type: 'tool-call', toolName: 'deliver_file', result: { success: true, path: '/tmp/report.docx' } },
      {
        type: 'tool-call',
        toolName: 'deliver_file',
        result: JSON.stringify({ success: true, path: '/tmp/stored.pdf' })
      },
      { type: 'tool-call', toolName: 'terminal', result: { path: '/tmp/not-a-card.csv' } },
      { type: 'text', text: 'See [chart.png](#file:%2Ftmp%2Fchart.png) and [File: x](#media:%2Ftmp%2Fx.zip).' }
    ])

    expect([...shown].sort()).toEqual(['/tmp/chart.png', '/tmp/report.docx', '/tmp/stored.pdf', '/tmp/x.zip'])
  })
})

describe('deriveCreatedFiles', () => {
  it('keeps the gateway order and drops files already on screen as a card or chip', () => {
    const rows = deriveCreatedFiles(FILES, [
      { type: 'tool-call', toolName: 'deliver_file', result: { success: true, path: '/tmp/report.docx' } },
      { type: 'text', text: 'Chart: [chart.png](#file:%2Ftmp%2Fchart.png)' }
    ])

    expect(rows.map(file => file.name)).toEqual(['data.csv'])
  })

  it('dedupes repeated paths and is empty without input', () => {
    expect(deriveCreatedFiles([FILES[0], FILES[0]], []).map(file => file.path)).toEqual(['/tmp/report.docx'])
    expect(deriveCreatedFiles([], [{ type: 'text', text: 'x' }])).toEqual([])
  })
})
