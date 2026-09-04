import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'

import { bootPhaseLabel, KNOWN_BOOT_PHASES } from './boot-phase-label'

const en = TRANSLATIONS.en
const vi = TRANSLATIONS.vi

describe('bootPhaseLabel', () => {
  it('translates a main-process phase instead of echoing its English message', () => {
    expect(bootPhaseLabel(vi, { phase: 'backend.wait', message: 'Waiting for AgentX backend to become ready' })).toBe(
      vi.boot.phases.wait
    )
    expect(vi.boot.phases.wait).not.toBe('Waiting for AgentX backend to become ready')
  })

  it('appends the dynamic detail the main process attached', () => {
    expect(
      bootPhaseLabel(en, {
        detail: 'https://gateway.example.com/agentx',
        message: 'Connecting to remote AgentX backend at https://gateway.example.com/agentx',
        phase: 'backend.remote'
      })
    ).toBe(`${en.boot.phases.remote} · https://gateway.example.com/agentx`)
  })

  it('ignores a blank detail', () => {
    expect(bootPhaseLabel(en, { detail: '  ', message: 'x', phase: 'backend.spawn' })).toBe(en.boot.phases.spawn)
  })

  it('keeps the raw message for a phase it does not know', () => {
    // Renderer phases already carry a localized message; a phase from a newer
    // main process must still say something rather than nothing.
    expect(bootPhaseLabel(vi, { message: 'Đang khởi động AgentX Workmate Desktop…', phase: 'renderer.init' })).toBe(
      'Đang khởi động AgentX Workmate Desktop…'
    )
    expect(bootPhaseLabel(vi, { message: 'Doing something new', phase: 'backend.future' })).toBe('Doing something new')
  })

  it('has a translation for every phase it names, in every shipped locale', () => {
    for (const locale of Object.keys(TRANSLATIONS) as (keyof typeof TRANSLATIONS)[]) {
      for (const phase of KNOWN_BOOT_PHASES) {
        const label = bootPhaseLabel(TRANSLATIONS[locale], { message: '', phase })

        expect(label, `${locale}: ${phase}`).not.toBe('')
      }
    }
  })
})
