import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REASONING_EFFORT,
  effectiveReasoningEffort,
  isReasoningEffort,
  REASONING_EFFORT_VALUES,
  REASONING_EFFORTS,
  reasoningEffortLabel,
  THINKING_STOPS,
  thinkingStops
} from './reasoning-effort'

describe('reasoning-effort', () => {
  it('keeps the scale ascending and `none` off it', () => {
    expect(REASONING_EFFORTS).not.toContain('none')
    expect(REASONING_EFFORT_VALUES[0]).toBe('none')
    expect(REASONING_EFFORT_VALUES).toHaveLength(REASONING_EFFORTS.length + 1)
  })

  it('labels every level it claims to support', () => {
    for (const effort of REASONING_EFFORT_VALUES) {
      expect(reasoningEffortLabel(effort)).not.toBe('')
    }

    expect(reasoningEffortLabel('')).toBe('')
    // Unknown values pass through rather than silently reading as a real level.
    expect(reasoningEffortLabel('bogus')).toBe('bogus')
  })

  it('recognizes only real scale levels', () => {
    expect(isReasoningEffort(DEFAULT_REASONING_EFFORT)).toBe(true)
    expect(isReasoningEffort('HIGH')).toBe(true)
    expect(isReasoningEffort('none')).toBe(false)
    expect(isReasoningEffort('bogus')).toBe(false)
  })

  it('resolves the level a surface really runs at: inherit, off, or clamp', () => {
    expect(effectiveReasoningEffort('high')).toBe('high')
    expect(effectiveReasoningEffort('HIGH ')).toBe('high')
    // Empty inherits the profile default rather than snapping to medium.
    expect(effectiveReasoningEffort('', 'ultra')).toBe('ultra')
    expect(effectiveReasoningEffort('', '')).toBe(DEFAULT_REASONING_EFFORT)

    // Every spelling the backend reads as "thinking off" is off here too.
    for (const off of ['none', 'false', 'disabled', 'off']) {
      expect(effectiveReasoningEffort(off)).toBe('none')
    }

    expect(effectiveReasoningEffort('', 'false')).toBe('none')
    // A garbage value never shows as a phantom level.
    expect(effectiveReasoningEffort('bogus')).toBe(DEFAULT_REASONING_EFFORT)
  })

  it('offers the wire-distinct stops, low to high, starting with off', () => {
    expect(THINKING_STOPS[0]).toBe('none')
    expect([...THINKING_STOPS]).toEqual(
      REASONING_EFFORT_VALUES.filter(value => THINKING_STOPS.includes(value as never))
    )
  })

  it('adds an off-dial level in ladder order only while it is the selection', () => {
    expect(thinkingStops('medium')).toEqual([...THINKING_STOPS])
    expect(thinkingStops('minimal')).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(thinkingStops('ultra')).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(thinkingStops('bogus')).toEqual([...THINKING_STOPS])
  })
})
