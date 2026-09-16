import { describe, expect, it } from 'vitest'

import { DELIVERABLE_KINDS, deliverableKind, DOCUMENT_MIME_TYPES, previewKindForFile } from './deliverables'

describe('deliverableKind', () => {
  it('classifies documents, media, archives and data by extension, case-insensitively', () => {
    expect(deliverableKind('/x/report.docx')).toBe('document')
    expect(deliverableKind('/x/Q3.XLSX')).toBe('spreadsheet')
    expect(deliverableKind('/x/deck.pptx')).toBe('presentation')
    expect(deliverableKind('/x/a.pdf')).toBe('pdf')
    expect(deliverableKind('/x/a.zip')).toBe('archive')
    expect(deliverableKind('/x/chart.png')).toBe('image')
    expect(deliverableKind('/x/voice.mp3')).toBe('audio')
    expect(deliverableKind('/x/clip.mp4')).toBe('video')
    expect(deliverableKind('/x/data.csv')).toBe('data')
    expect(deliverableKind('/x/notes.md')).toBe('text')
  })

  it('never treats source code as a deliverable', () => {
    for (const name of ['main.py', 'index.ts', 'app.tsx', 'lib.rs', 'Makefile', 'config.json', 'styles.css', 'x']) {
      expect(deliverableKind(`/x/${name}`)).toBeNull()
    }
  })

  it('has a MIME type for every document, archive and data extension', () => {
    for (const kind of ['document', 'spreadsheet', 'presentation', 'pdf', 'archive', 'data', 'text'] as const) {
      for (const ext of DELIVERABLE_KINDS[kind]) {
        // Apple's proprietary bundles and parquet have no registered type worth inventing.
        if (['.pages', '.numbers', '.key', '.parquet'].includes(ext)) {
          continue
        }

        expect(DOCUMENT_MIME_TYPES[ext], ext).toBeTruthy()
      }
    }
  })
})

describe('previewKindForFile', () => {
  it('routes each family to its viewer', () => {
    expect(previewKindForFile({ ext: '.html', mimeType: 'text/html' })).toBe('html')
    expect(previewKindForFile({ ext: '.png', mimeType: 'image/png' })).toBe('image')
    expect(previewKindForFile({ ext: '.pdf', mimeType: 'application/pdf', binary: true })).toBe('pdf')
    expect(previewKindForFile({ ext: '.docx', mimeType: DOCUMENT_MIME_TYPES['.docx'], binary: true })).toBe('document')
    expect(previewKindForFile({ ext: '.xlsx', binary: true })).toBe('document')
    expect(previewKindForFile({ ext: '.pptx', binary: true })).toBe('document')
    expect(previewKindForFile({ ext: '.mp4', mimeType: 'video/mp4', binary: true })).toBe('media')
    expect(previewKindForFile({ ext: '.mp3', mimeType: 'audio/mpeg', binary: true })).toBe('media')
  })

  it('falls back to text or binary by the byte sniff', () => {
    expect(previewKindForFile({ ext: '.log', mimeType: 'application/octet-stream', binary: false })).toBe('text')
    expect(previewKindForFile({ ext: '.zip', mimeType: 'application/zip', binary: true })).toBe('binary')
    expect(previewKindForFile({ ext: '', binary: true })).toBe('binary')
  })
})
