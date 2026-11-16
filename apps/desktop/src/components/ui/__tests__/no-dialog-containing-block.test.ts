import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { containingBlockUtilities } from './containing-block-utilities'

// Static-analysis guard: no `<DialogContent>` call site may carry a utility
// that turns the dialog into the containing block of `position: fixed`
// descendants (transform / translate / scale / rotate / filter /
// backdrop-filter / perspective / contain / will-change).
//
// Select, Popover and DropdownMenu opened inside a dialog portal INTO the
// dialog's content node and position themselves `fixed`. Once the dialog is a
// containing block, a dropdown that runs past the dialog's edge is clipped by
// the dialog's overflow, widens its scrollable area, and Radix's
// scrollIntoView of the selected item scrolls the whole dialog sideways (the
// cron dialog slid left when its Model picker opened, 16/11/2026). The
// primitive itself is guarded in dialog.test.tsx; this covers the classNames
// call sites pass in.

function collectTsxFiles(dir: string): string[] {
  const results: string[] = []

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') {
      continue
    }

    const fullPath = join(dir, entry)

    if (statSync(fullPath).isDirectory()) {
      results.push(...collectTsxFiles(fullPath))
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      results.push(fullPath)
    }
  }

  return results
}

describe('containingBlockUtilities', () => {
  it('finds the utilities that capture fixed descendants, through variants', () => {
    expect(
      containingBlockUtilities(
        'fixed -translate-x-1/2 sm:scale-95 data-[state=open]:backdrop-blur-sm !rotate-3 contain-paint will-change-transform'
      )
    ).toEqual([
      '-translate-x-1/2',
      'sm:scale-95',
      'data-[state=open]:backdrop-blur-sm',
      '!rotate-3',
      'contain-paint',
      'will-change-transform'
    ])
  })

  it('ignores animation, layout and look utilities', () => {
    expect(
      containingBlockUtilities(
        'fixed inset-0 m-auto h-fit container contain-none shadow-md data-[state=open]:animate-in data-[state=open]:zoom-in-98 slide-in-from-top-1 [&>*]:min-w-0 will-change-opacity'
      )
    ).toEqual([])
  })
})

describe('no containing block on DialogContent', () => {
  it('keeps transform/filter/contain utilities off every <DialogContent>', () => {
    const violations: string[] = []
    const srcDir = resolve(__dirname, '../../..')
    // `=>` stays inside the attribute span so an arrow-function prop doesn't
    // end the match early.
    const tagPattern = /<DialogContent\b((?:=>|[^>])*?)>/gsu
    let scanned = 0

    for (const filePath of collectTsxFiles(srcDir)) {
      const content = readFileSync(filePath, 'utf-8')
      const relativePath = filePath.replace(srcDir + '/', '')
      let match: RegExpExecArray | null

      while ((match = tagPattern.exec(content)) !== null) {
        scanned += 1
        // Every quoted string in the tag — className literals, cn() arguments,
        // ternary branches — is checked; a non-class string simply finds none.
        const strings = match[1].match(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/gsu) ?? []
        const found = strings.flatMap(literal => containingBlockUtilities(literal.slice(1, -1)))

        if (found.length > 0) {
          const lineNum = content.slice(0, match.index).split('\n').length

          violations.push(`${relativePath}:${lineNum} <DialogContent> carries ${found.join(', ')}`)
        }
      }
    }

    // The scan must actually see the call sites, or it passes vacuously.
    expect(scanned).toBeGreaterThan(20)
    expect(violations, violations.join('\n')).toEqual([])
  })
})
