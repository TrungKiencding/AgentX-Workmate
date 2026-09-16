import { describe, expect, it } from 'vitest'

import { codiconForFilename, isLikelyProseCodeBlock } from './markdown-code'

describe('isLikelyProseCodeBlock', () => {
  it('detects prose that Streamdown mislabels as an unknown language', () => {
    expect(
      isLikelyProseCodeBlock(
        'heads',
        [
          '- Pure white (`#ffffff`), roughness 0.55, no emissive',
          '- Black wireframe edges at 35% opacity',
          '',
          'Want the bunny gone, or want me to keep riffing on it?'
        ].join('\n')
      )
    ).toBe(true)
  })

  it('keeps real code blocks', () => {
    expect(isLikelyProseCodeBlock('ts', 'const value = { bunny: true };\nreturn value')).toBe(false)
  })
})

describe('codiconForFilename — deliverables', () => {
  it('gives documents, media and archives their own glyphs instead of the code one', () => {
    expect(codiconForFilename('/x/report.docx')).toBe('file-text')
    expect(codiconForFilename('/x/q3.xlsx')).toBe('table')
    expect(codiconForFilename('/x/data.csv')).toBe('table')
    expect(codiconForFilename('/x/deck.pptx')).toBe('window')
    expect(codiconForFilename('/x/a.pdf')).toBe('file-pdf')
    expect(codiconForFilename('/x/a.zip')).toBe('file-zip')
    expect(codiconForFilename('/x/chart.png')).toBe('file-media')
    expect(codiconForFilename('/x/voice.mp3')).toBe('music')
    expect(codiconForFilename('/x/clip.mp4')).toBe('device-camera-video')
    expect(codiconForFilename('/x/notes.txt')).toBe('note')
    expect(codiconForFilename('/x/cal.ics')).toBe('calendar')
  })

  it('keeps the language glyph for text formats that have one, and code for source', () => {
    expect(codiconForFilename('/x/README.md')).toBe('markdown')
    expect(codiconForFilename('/x/main.ts')).toBe('code')
    expect(codiconForFilename('/x/Dockerfile')).toBe('package')
  })
})
