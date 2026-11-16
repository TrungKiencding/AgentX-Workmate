import { describe, expect, it } from 'vitest'

import type { SessionResource } from './model'
import { findMissing, isDiskFile } from './presence'

const file = (target: string): SessionResource => ({ id: `file:${target}`, kind: 'file', label: target, target })

describe('file presence', () => {
  it('only checks rows that point at a file on disk', () => {
    expect(isDiskFile(file('/a.pdf'))).toBe(true)
    expect(isDiskFile({ ...file('/a.png'), dataUrl: 'data:image/png;base64,AA' })).toBe(false)
    expect(isDiskFile({ id: 'url:x', kind: 'url', label: 'x', target: 'https://x' })).toBe(false)
  })

  it('calls a file gone only when a stat answered so', async () => {
    const answers: Record<string, unknown> = {
      '/gone.pdf': { exists: false },
      '/here.pdf': { exists: true },
      '/unknown.pdf': null
    }

    const missing = await findMissing(
      [file('/gone.pdf'), file('/here.pdf'), file('/unknown.pdf'), file('/throws.pdf')],
      async path => {
        if (path === '/throws.pdf') {
          throw new Error('offline')
        }

        return answers[path] as never
      }
    )

    expect([...missing]).toEqual(['file:/gone.pdf'])
  })
})
