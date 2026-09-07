import { describe, expect, it } from 'vitest'

import { isDesktopToolsetVisible } from './desktop-toolsets'

describe('isDesktopToolsetVisible', () => {
  it('hides platform-coupled and internal toolsets', () => {
    for (const name of ['discord', 'discord_admin', 'yuanbao', 'context_engine', 'moa']) {
      expect(isDesktopToolsetVisible(name)).toBe(false)
    }
  })

  it('keeps ordinary user-facing toolsets', () => {
    for (const name of ['web', 'browser', 'terminal', 'file', 'memory', 'vision', 'image_gen']) {
      expect(isDesktopToolsetVisible(name)).toBe(true)
    }
  })

  it('keeps the skill-index toolset visible', () => {
    // `skills` is plumbing for the "Kỹ năng sẵn có" tab and switching it off has
    // consequences a tab away — but hiding a row never re-enables the setting
    // behind it, so hiding this one would strand whoever already switched it
    // off. It stays, on the machinery shelf, with copy that names the cost.
    expect(isDesktopToolsetVisible('skills')).toBe(true)
  })
})
