import { describe, expect, it } from 'vitest'

import { localPreviewTarget, previewKindForExtension } from './local-preview'

describe('previewKindForExtension', () => {
  it('routes documents, pdfs and media to their viewers', () => {
    expect(previewKindForExtension('.pdf')).toBe('pdf')
    expect(previewKindForExtension('.docx')).toBe('document')
    expect(previewKindForExtension('.xlsx')).toBe('document')
    expect(previewKindForExtension('.pptx')).toBe('document')
    expect(previewKindForExtension('.mp4')).toBe('media')
    expect(previewKindForExtension('.mp3')).toBe('media')
    expect(previewKindForExtension('.html')).toBe('html')
    expect(previewKindForExtension('.png')).toBe('image')
    expect(previewKindForExtension('.md')).toBe('text')
    expect(previewKindForExtension('.zip')).toBe('text')
  })
})

describe('localPreviewTarget', () => {
  it('classifies native file names containing literal hash and question marks', () => {
    expect(localPreviewTarget('/work/Report #1 (final)?.pdf')?.previewKind).toBe('pdf')
    expect(localPreviewTarget('/work/Sheet #1.xlsx')?.previewKind).toBe('document')
  })
  it('does not prepend a POSIX cwd to Windows absolute and UNC paths', () => {
    expect(localPreviewTarget('C:\\Reports\\a.pdf', '/work')?.path).toBe('C:\\Reports\\a.pdf')
    expect(localPreviewTarget('\\\\server\\share\\a.pdf', '/work')?.path).toBe('\\\\server\\share\\a.pdf')
  })

  it('preserves home-relative paths and canonical Windows/UNC file URLs', () => {
    expect(localPreviewTarget('~/Downloads/report.pdf', '/work')?.path).toBe('~/Downloads/report.pdf')
    expect(localPreviewTarget('C:\\Reports\\a b.pdf')?.url).toBe('file:///C:/Reports/a%20b.pdf')
    expect(localPreviewTarget('file:///C:/Reports/a%20b.pdf')?.path).toBe('C:/Reports/a b.pdf')
    expect(localPreviewTarget('\\\\server\\share\\a.pdf')?.url).toBe('file://server/share/a.pdf')
    expect(localPreviewTarget('file://server/share/a.pdf')?.path).toBe('//server/share/a.pdf')
  })
  it('classifies a document path without touching the disk', () => {
    const target = localPreviewTarget('/tmp/out/report.docx')

    expect(target).toMatchObject({
      kind: 'file',
      label: 'report.docx',
      path: '/tmp/out/report.docx',
      previewKind: 'document',
      url: 'file:///tmp/out/report.docx'
    })
  })

  it('resolves a relative path against the cwd and decodes file urls', () => {
    expect(localPreviewTarget('out/a.pdf', '/work')?.path).toBe('/work/out/a.pdf')
    expect(localPreviewTarget('file:///tmp/b%20c.pdf')?.path).toBe('/tmp/b c.pdf')
  })
})
