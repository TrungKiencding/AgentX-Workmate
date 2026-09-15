import { beforeEach, describe, expect, it } from 'vitest'

import { keepDarkForInstallsThatShippedDark, modePref, skinPref } from './context'
import { DEFAULT_SKIN_NAME } from './presets'

// Skin and mode share one per-profile contract, so assert it once over both.
interface Pref {
  resolve: (profile: string) => string
  assign: (profile: string, value: string) => void
}

const cases = [
  {
    name: 'skin',
    pref: skinPref as unknown as Pref,
    fallback: DEFAULT_SKIN_NAME,
    a: 'ember',
    b: 'midnight',
    junk: 'nope'
  },
  // Fallback is 'light': a fresh install opens on Night Owl Light.
  { name: 'mode', pref: modePref as unknown as Pref, fallback: 'light', a: 'dark', b: 'system', junk: 'dusk' }
]

describe.each(cases)('per-profile $name', ({ pref, fallback, a, b, junk }) => {
  beforeEach(() => window.localStorage.clear())

  it('falls back to the default when unassigned', () => {
    expect(pref.resolve('default')).toBe(fallback)
    expect(pref.resolve('work')).toBe(fallback)
  })

  it('keeps each profile on its own value', () => {
    pref.assign('work', a)
    pref.assign('default', b)
    expect(pref.resolve('work')).toBe(a)
    expect(pref.resolve('default')).toBe(b)
  })

  it('lets unassigned profiles inherit the default profile as the global fallback', () => {
    pref.assign('default', a)
    expect(pref.resolve('never-themed')).toBe(a)
  })

  it('normalizes an unknown stored value back to the default', () => {
    pref.assign('work', junk)
    expect(pref.resolve('work')).toBe(fallback)
  })
})

describe('the light default reaches fresh installs only', () => {
  beforeEach(() => window.localStorage.clear())

  it('keeps a fresh install light, launch after launch', () => {
    keepDarkForInstallsThatShippedDark()
    // The first launch paints, which caches a boot background…
    window.localStorage.setItem('agentx-boot-background', '#fbfbfb')
    // …and the next launch must not mistake that for an install that shipped dark.
    keepDarkForInstallsThatShippedDark()

    expect(modePref.resolve('default')).toBe('light')
  })

  it('keeps an install that already ran on the dark default dark', () => {
    window.localStorage.setItem('agentx-boot-background', '#011627')
    keepDarkForInstallsThatShippedDark()

    expect(modePref.resolve('default')).toBe('dark')
    expect(modePref.resolve('never-themed')).toBe('dark')
  })

  it('never touches a mode somebody picked', () => {
    window.localStorage.setItem('agentx-boot-background', '#011627')
    modePref.assign('default', 'system')
    keepDarkForInstallsThatShippedDark()

    expect(modePref.resolve('default')).toBe('system')
  })
})
