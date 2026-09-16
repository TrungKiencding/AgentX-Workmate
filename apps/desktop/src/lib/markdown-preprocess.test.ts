import { describe, expect, it } from 'vitest'

import { preprocessMarkdown } from './markdown-preprocess'

describe('preprocessMarkdown — deliverable paths', () => {
  it('turns a bare document path in prose into a file link', () => {
    expect(preprocessMarkdown('Báo cáo đã lưu tại /Users/me/Documents/bao-cao.docx.')).toBe(
      'Báo cáo đã lưu tại [bao-cao.docx](#file:%2FUsers%2Fme%2FDocuments%2Fbao-cao.docx).'
    )
  })

  it('leaves paths inside inline and fenced code alone', () => {
    expect(preprocessMarkdown('Run `open /tmp/report.pdf` now')).toBe('Run `open /tmp/report.pdf` now')

    const fenced = '```bash\ncp /tmp/report.pdf ~/Desktop/report.pdf\n```'

    expect(preprocessMarkdown(fenced)).toBe(fenced)
  })

  it('does not touch source-code paths or url tails', () => {
    expect(preprocessMarkdown('Edited /Users/me/app/src/index.ts')).toBe('Edited /Users/me/app/src/index.ts')
    expect(preprocessMarkdown('See https://example.com/x/report.pdf')).toBe('See <https://example.com/x/report.pdf>')
  })

  it('keeps an already rendered MEDIA: link as it is', () => {
    const rendered = '[File: report.docx](#media:%2Ftmp%2Freport.docx)'

    expect(preprocessMarkdown(rendered)).toBe(rendered)
  })
})
