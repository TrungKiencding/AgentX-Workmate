import { describe, expect, it } from 'vitest'

import { compareSemver } from './semver'

describe('compareSemver (the AgentX Skill Hub order)', () => {
  it('compares numbers as numbers, a prerelease below its release, and ignores build metadata', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareSemver('1.0.1', '1.0.0')).toBeGreaterThan(0)
    expect(compareSemver('2.0.0-rc.1', '2.0.0')).toBeLessThan(0)
    expect(compareSemver('1.0.0+build.9', '1.0.0')).toBe(0)
    expect(compareSemver('1.0.0-2', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareSemver('1.0.0-rc.10', '1.0.0-rc.9')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0-rc.1.1', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(['1.0.0', '1.0.0-rc.1', '0.9.9', '1.0.1'].sort(compareSemver)).toEqual([
      '0.9.9',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1'
    ])
  })
})
