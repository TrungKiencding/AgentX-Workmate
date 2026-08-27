import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Static-analysis guard: no `<Button>` call site may carry a `translate-*`
// utility in its className.
//
// Every `translate-x/y-*` utility writes the SAME CSS property (`translate`),
// and the Button primitive owns one of its own: `active:translate-y-px` (the
// 1px press settle, `active:translate-y-0` on `icon-titlebar`). A positioning
// transform passed from a call site therefore doesn't compose with it — it is
// cancelled the instant the button is pressed. That shipped as a real bug: the
// overlay close X was centred with `-translate-y-1/2` and dropped half its
// height on every press before the overlay closed.
//
// The fix is always the same: wrap the Button in a positioned element and let
// the wrapper own the transform. Same category as `no-native-title` — a lint
// rule expressed as a vitest so it runs with the suite.

function collectTsxFiles(dir: string): string[] {
  const results: string[] = []

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') {
      continue
    }

    const fullPath = join(dir, entry)

    if (statSync(fullPath).isDirectory()) {
      results.push(...collectTsxFiles(fullPath))
    } else if (entry.endsWith('.tsx')) {
      results.push(fullPath)
    }
  }

  return results
}

describe('no positioning transform on the Button primitive', () => {
  it('keeps translate-* on a wrapper, never on <Button>', () => {
    const violations: string[] = []
    const srcDir = resolve(__dirname, '../../..')
    // `=>` stays inside the attribute span so an arrow-function prop doesn't
    // end the match early (the same blind spot that hid title= violations).
    const tagPattern = /<Button\b((?:=>|[^>])*?)>/gsu

    for (const filePath of collectTsxFiles(srcDir)) {
      const content = readFileSync(filePath, 'utf-8')
      const relativePath = filePath.replace(srcDir + '/', '')
      let match: RegExpExecArray | null

      while ((match = tagPattern.exec(content)) !== null) {
        if (/(?:^|[\s'"`:])-?translate-[xy]-/.test(match[1])) {
          const lineNum = content.slice(0, match.index).split('\n').length

          violations.push(`${relativePath}:${lineNum} <Button> carries translate-* — move it to a wrapper element`)
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })
})
