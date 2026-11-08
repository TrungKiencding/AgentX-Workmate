import { afterEach, describe, expect, it } from 'vitest'

import {
  attachmentData,
  formatBytes,
  GROUP_ATTACH_MAX_BYTES,
  isImageFile,
  readAttachments,
  releaseAttachment,
  resetAttachments,
  stageAttachments
} from './group-attachments'

afterEach(() => resetAttachments())

describe('readAttachments', () => {
  it('holds the bytes, tells pictures from files, and skips what is too large', async () => {
    const big = new File(['x'], 'video.mov', { type: 'video/quicktime' })
    Object.defineProperty(big, 'size', { value: GROUP_ATTACH_MAX_BYTES + 1 })

    const result = await readAttachments([
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }),
      big
    ])

    expect(result.added.map(item => [item.name, item.kind])).toEqual([
      ['notes.txt', 'file'],
      ['shot.png', 'image']
    ])
    expect(result.tooLarge).toEqual(['video.mov'])
    expect(attachmentData(result.added[0].id)).toMatch(/^data:text\/plain;base64,/)

    releaseAttachment(result.added[0].id)
    expect(attachmentData(result.added[0].id)).toBeNull()
  })

  it('stops at the room it was given', async () => {
    const files = ['a', 'b', 'c'].map(name => new File([name], `${name}.txt`))

    expect((await readAttachments(files, 2)).added).toHaveLength(2)
  })
})

describe('stageAttachments', () => {
  it('reports by name what could not be delivered instead of failing the turn', async () => {
    const { added } = await readAttachments([new File(['x'], 'ok.txt'), new File(['y'], 'bad.csv')])
    const gone = { id: 'gone', name: 'old.pdf', kind: 'file' as const, size: 1 }

    const staged = await stageAttachments(
      async <T>(method: string, params: Record<string, unknown>) => {
        if (params.name === 'bad.csv') {
          throw new Error('upload failed')
        }

        return { attached: true, ref_text: `@file:${String(params.name)}`, method } as T
      },
      'rt-1',
      [...added, gone]
    )

    expect(staged.files).toEqual([{ name: 'ok.txt', ref: '@file:ok.txt' }])
    expect(staged.missing).toEqual(['bad.csv', 'old.pdf'])
  })
})

describe('helpers', () => {
  it('knows image files and formats sizes', () => {
    expect(isImageFile('a.JPG')).toBe(true)
    expect(isImageFile('icon.svg', 'image/svg+xml')).toBe(false)
    expect(isImageFile('doc.pdf', 'application/pdf')).toBe(false)
    expect(formatBytes(830 * 1024)).toBe('830 KB')
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })
})
