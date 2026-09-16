import { describe, expect, it } from 'vitest'

import { deliveredFileFromResult } from './delivered-file'

const RESULT = {
  success: true,
  delivered: true,
  path: '/tmp/out/report.docx',
  name: 'report.docx',
  size_bytes: 2048,
  mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  modified_at: 1_700_000_000,
  caption: 'Q3 summary'
}

describe('deliveredFileFromResult', () => {
  it('reads a live (parsed) result', () => {
    expect(deliveredFileFromResult(RESULT)).toEqual({
      caption: 'Q3 summary',
      mimeType: RESULT.mime_type,
      modifiedMs: 1_700_000_000_000,
      name: 'report.docx',
      path: '/tmp/out/report.docx',
      sizeBytes: 2048
    })
  })

  it('reads a stored (JSON string) result the same way', () => {
    expect(deliveredFileFromResult(JSON.stringify(RESULT))).toEqual(deliveredFileFromResult(RESULT))
  })

  it('derives the name from the path when the tool left it out', () => {
    expect(deliveredFileFromResult({ success: true, path: 'C:\\out\\deck.pptx' })?.name).toBe('deck.pptx')
  })

  it('is null for a failed call, a foreign shape or garbage', () => {
    expect(deliveredFileFromResult({ error: 'No file at /tmp/x.pdf' })).toBeNull()
    expect(deliveredFileFromResult({ success: true })).toBeNull()
    expect(deliveredFileFromResult('not json')).toBeNull()
    expect(deliveredFileFromResult(null)).toBeNull()
    expect(deliveredFileFromResult(undefined)).toBeNull()
  })
})
