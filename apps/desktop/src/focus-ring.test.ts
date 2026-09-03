import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MODALITY_ATTR } from './lib/input-modality'

/**
 * The one focus ring, app-wide (DESIGN.md § Affordances). It can only be
 * expressed in CSS, so this pulls the real rule out of `styles.css` and asks it
 * about real elements — the selector is the thing under test, not its wording.
 *
 * `:focus-visible` is dropped before matching: jsdom has no focus-visible
 * heuristic, and the whole point of the rule's root gate is that Chromium's
 * heuristic is NOT "keyboard focus". What remains — which elements, under which
 * root — is what decides whether a mouse user gets a ring.
 */
// Read off disk rather than `import … from './styles.css?raw'`: Vite's CSS
// pipeline claims the request and hands back an empty string. `import.meta.url`
// is no good either — Vite rewrites `new URL(…, import.meta.url)` into an asset
// URL. `import.meta.dirname` survives both.
const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '')

const ringRules = [...css.matchAll(/([^{}]*):focus-visible\s*\{\s*outline:\s*var\(--ui-focus-ring-width\)[^}]*\}/g)]
const selector = `${ringRules[0]?.[1].trim().replace(/\s+/g, ' ')}:focus-visible`

const ringApplies = (el: Element) => el.matches(selector.replace(':focus-visible', ''))

/** The selector with every `:where()` group removed, parens balanced. What is
 *  left is exactly what contributes specificity. */
const scoringPart = (input: string) => {
  let out = ''

  for (let i = 0; i < input.length; i++) {
    if (!input.startsWith(':where(', i)) {
      out += input[i]

      continue
    }

    let depth = 0

    for (i += ':where('.length - 1; i < input.length; i++) {
      if (input[i] === '(') {
        depth++
      }

      if (input[i] === ')' && --depth === 0) {
        break
      }
    }
  }

  return out.trim()
}

const el = (tag: string, attrs: Record<string, string> = {}) => {
  const node = document.createElement(tag)

  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, value)
  }

  document.body.append(node)

  return node
}

const withModality = (value: string | null) => {
  if (value === null) {
    document.documentElement.removeAttribute(MODALITY_ATTR)
  } else {
    document.documentElement.setAttribute(MODALITY_ATTR, value)
  }
}

afterEach(() => {
  document.body.replaceChildren()
  withModality('keyboard')
})

describe('the app-wide focus ring', () => {
  it('is declared exactly once', () => {
    expect(ringRules).toHaveLength(1)
  })

  it('costs no specificity, so a surface with its own chrome can still override it', () => {
    expect(scoringPart(selector)).toBe(':focus-visible')
  })

  it('rings a control while the last interaction was a key', () => {
    expect(ringApplies(el('button'))).toBe(true)
    expect(ringApplies(el('a', { href: '#x' }))).toBe(true)
    expect(ringApplies(el('div', { role: 'button' }))).toBe(true)
    expect(ringApplies(el('div', { tabindex: '0' }))).toBe(true)
  })

  it('does not ring anything while the last interaction was a pointer', () => {
    withModality('pointer')

    expect(ringApplies(el('button'))).toBe(false)
    expect(ringApplies(el('div', { role: 'button' }))).toBe(false)
  })

  it('still rings when the root is unstamped, so a11y never depends on the script', () => {
    withModality(null)

    expect(ringApplies(el('button'))).toBe(true)
  })

  it('leaves menu and option rows to their selected-row background', () => {
    // Radix roving focus makes the active row the tab stop, so these match the
    // `[tabindex]` arm of the selector and have to be excluded by role.
    for (const role of ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'option']) {
      expect(ringApplies(el('div', { role, tabindex: '0' }))).toBe(false)
    }
  })

  it('leaves text entry to the border it already draws', () => {
    expect(ringApplies(el('div', { contenteditable: 'true', tabindex: '0' }))).toBe(false)
    expect(ringApplies(el('button', { class: 'desktop-input-chrome' }))).toBe(false)
  })

  it('lets a one-off opt out', () => {
    expect(ringApplies(el('button', { 'data-focus-ring': 'none' }))).toBe(false)
  })
})
