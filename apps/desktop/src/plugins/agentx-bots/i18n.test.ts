import { describe, expect, it } from 'vitest'

import { BOTS_LOCALES } from './i18n'

type Node = Record<string, unknown>

function shape(node: Node, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key

    if (typeof value === 'function') {
      return [`${path}()${value.length}`]
    }

    return value && typeof value === 'object' ? shape(value as Node, path) : [path]
  })
}

describe('Bot Mode locales', () => {
  it('vi and en cover the same keys with the same function arity', () => {
    expect(shape(BOTS_LOCALES.vi as Node).sort()).toEqual(shape(BOTS_LOCALES.en as Node).sort())
  })

  it('no string is empty', () => {
    for (const locale of ['vi', 'en'] as const) {
      const walk = (node: Node): void => {
        for (const value of Object.values(node)) {
          if (typeof value === 'string') {
            expect(value.trim()).not.toBe('')
          } else if (value && typeof value === 'object') {
            walk(value as Node)
          }
        }
      }

      walk(BOTS_LOCALES[locale] as Node)
    }
  })
})
