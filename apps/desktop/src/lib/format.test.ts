import { describe, expect, it } from 'vitest'

import { compactNumber, formatByteSize } from './format'

describe('formatByteSize', () => {
  it('uses binary units with one decimal under ten', () => {
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(1536)).toBe('1.5 KB')
    expect(formatByteSize(10 * 1024 * 1024)).toBe('10 MB')
    expect(formatByteSize(2.5 * 1024 ** 3)).toBe('2.5 GB')
  })

  it('reads a missing size as the caller’s label', () => {
    expect(formatByteSize(0)).toBe('')
    expect(formatByteSize(undefined, 'unknown size')).toBe('unknown size')
    expect(formatByteSize(Number.NaN, '?')).toBe('?')
  })
})

describe('compactNumber', () => {
  it('still promotes at the unit boundary', () => {
    expect(compactNumber(999_950)).toBe('1M')
    expect(compactNumber(1230)).toBe('1.2k')
  })
})
