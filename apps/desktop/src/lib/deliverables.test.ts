import { describe, expect, it } from 'vitest'

import {
  deliverableHasInlinePreview,
  deliverableKind,
  fileExtension,
  fileMarkdownHref,
  fileName,
  filePathFromMarkdownHref,
  linkedFilePaths,
  linkifyDeliverablePaths
} from './deliverables'

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
    expect(deliverableKind('file:///tmp/notes.md?x=1')).toBe('text')
  })

  it('never treats source code as a deliverable', () => {
    for (const name of ['main.py', 'index.ts', 'app.tsx', 'lib.rs', 'Makefile', 'config.json', 'styles.css', 'x']) {
      expect(deliverableKind(`/x/${name}`)).toBeNull()
    }
  })

  it('knows which kinds the rail can show in place', () => {
    expect(deliverableHasInlinePreview('document')).toBe(true)
    expect(deliverableHasInlinePreview('pdf')).toBe(true)
    expect(deliverableHasInlinePreview('archive')).toBe(false)
    expect(deliverableHasInlinePreview('presentation')).toBe(false)
    expect(deliverableHasInlinePreview(null)).toBe(false)
  })

  it('reads names and extensions from posix, windows and file: forms', () => {
    expect(fileName('C:\\Users\\me\\deck.pptx')).toBe('deck.pptx')
    expect(fileName('/tmp/a b.pdf')).toBe('a b.pdf')
    expect(fileExtension('/tmp/archive.tar.gz')).toBe('gz')
    expect(fileExtension('/tmp/.hidden')).toBe('')
  })
})

describe('file markdown hrefs', () => {
  it('round-trips a path through the href', () => {
    const href = fileMarkdownHref('/tmp/báo cáo.docx')

    expect(href.startsWith('#file:')).toBe(true)
    expect(filePathFromMarkdownHref(href)).toBe('/tmp/báo cáo.docx')
  })

  it('rejects other hrefs and malformed encodings', () => {
    expect(filePathFromMarkdownHref('#media:%2Ftmp%2Fa.pdf')).toBeNull()
    expect(filePathFromMarkdownHref('https://x')).toBeNull()
    expect(filePathFromMarkdownHref('#file:%E0%A4%A')).toBeNull()
    expect(filePathFromMarkdownHref(undefined)).toBeNull()
  })
})

describe('linkifyDeliverablePaths', () => {
  it('links bare absolute, home and windows paths with a deliverable extension', () => {
    expect(linkifyDeliverablePaths('Saved to /tmp/out/report.docx.')).toBe(
      'Saved to [report.docx](#file:%2Ftmp%2Fout%2Freport.docx).'
    )
    expect(linkifyDeliverablePaths('See ~/Desktop/chart.png here')).toBe(
      'See [chart.png](#file:~%2FDesktop%2Fchart.png) here'
    )
    expect(linkifyDeliverablePaths('Also C:\\Users\\me\\deck.pptx')).toBe(
      'Also [deck.pptx](#file:C%3A%5CUsers%5Cme%5Cdeck.pptx)'
    )
  })

  it('leaves source paths, urls and existing links alone', () => {
    const untouched = [
      'Edited /Users/me/app/src/index.ts and /Users/me/app/README',
      'Docs at https://example.com/files/report.pdf',
      '[report](#media:%2Ftmp%2Freport.pdf) is attached',
      '[/tmp/report.pdf](https://example.com)',
      'Open (/tmp/report.pdf) later'
    ]

    for (const text of untouched) {
      expect(linkifyDeliverablePaths(text)).toBe(text)
    }
  })

  it('handles several paths and quoted paths in one sentence', () => {
    expect(linkifyDeliverablePaths('Files: "/tmp/a.pdf", `/tmp/b.xlsx` and /tmp/c.zip')).toBe(
      'Files: "[a.pdf](#file:%2Ftmp%2Fa.pdf)", `/tmp/b.xlsx` and [c.zip](#file:%2Ftmp%2Fc.zip)'
    )
  })

  it('does not recognise paths with brackets or parentheses in them', () => {
    expect(linkifyDeliverablePaths('/tmp/a[1].pdf')).toBe('/tmp/a[1].pdf')
    expect(linkifyDeliverablePaths('/tmp/we]ird.pdf')).toBe('/tmp/we]ird.pdf')
    expect(linkifyDeliverablePaths('/tmp/report (final).pdf')).toBe('/tmp/report (final).pdf')
  })

  it('is a no-op on text without a path', () => {
    expect(linkifyDeliverablePaths('nothing here')).toBe('nothing here')
    expect(linkifyDeliverablePaths('')).toBe('')
  })
})

describe('linkedFilePaths', () => {
  it('collects file and media link targets', () => {
    expect(
      linkedFilePaths('[a](#file:%2Ftmp%2Fa.pdf) and [File: b](#media:%2Ftmp%2Fb.docx) and [x](https://e.com)')
    ).toEqual(['/tmp/a.pdf', '/tmp/b.docx'])
  })
})
