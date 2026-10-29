import { describe, expect, it } from 'vitest'

import { isImeComposing, shouldSubmitOnEnter } from './ime'

describe('shouldSubmitOnEnter', () => {
  it('submits a normal Enter keypress', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', nativeEvent: {} })).toBe(true)
  })

  it('does not submit while IME composition is active', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false)
  })

  it('does not submit Chromium composition-boundary keyCode 229', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', nativeEvent: { keyCode: 229 } })).toBe(false)
  })

  it('does not submit non-Enter keys', () => {
    expect(shouldSubmitOnEnter({ key: 'Escape', nativeEvent: {} })).toBe(false)
  })
})

describe('isImeComposing', () => {
  it('reads both the standard flag and the 229 boundary code', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true)
    expect(isImeComposing({ nativeEvent: { keyCode: 229 } })).toBe(true)
    expect(isImeComposing({ nativeEvent: { keyCode: 13 } })).toBe(false)
  })
})
