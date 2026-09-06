import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatBarState } from '@/app/chat/composer/types'
import { I18nProvider } from '@/i18n'
import { applyWakeStartResult, applyWakeStatus, resetWakeWordState } from '@/store/wake-word'

import { ComposerControls } from './controls'

// The pill is rendered for real elsewhere; here it only has to report what
// the controls hand it.
const modelPillSpy = vi.hoisted(() => vi.fn((_props: Record<string, unknown>) => null))

vi.mock('./model-pill', () => ({ ModelPill: (props: Record<string, unknown>) => modelPillSpy(props) }))

const state: ChatBarState = {
  model: { canSwitch: false, model: '', provider: '' },
  tools: { enabled: false, label: '' },
  voice: { active: false, enabled: false }
}

/** The app's resting composer: voice enabled, nothing recording. */
const voiceState: ChatBarState = { ...state, voice: { active: false, enabled: true } }

function renderControls(overrides: Partial<React.ComponentProps<typeof ComposerControls>> = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <ComposerControls
        autoSpeak={false}
        busy={false}
        busyAction="stop"
        canSubmit={true}
        conversation={{
          active: false,
          level: 0,
          muted: false,
          onEnd: vi.fn(),
          onStart: vi.fn(),
          onStopTurn: vi.fn(),
          onToggleMute: vi.fn(),
          status: 'idle'
        }}
        disabled={false}
        hasComposerPayload={true}
        onDictate={vi.fn()}
        onQueue={vi.fn()}
        onToggleAutoSpeak={vi.fn()}
        state={state}
        voiceStatus="idle"
        {...overrides}
      />
    </I18nProvider>
  )
}

async function expectShortcutTooltip(label: string, shortcut: string) {
  fireEvent.pointerMove(screen.getByLabelText(label), { pointerType: 'mouse' })

  const tooltip = await screen.findByRole('tooltip')

  expect(tooltip.textContent).toContain(label)
  expect(tooltip.textContent).toContain(shortcut)
}

/** Radix's dropdown trigger opens on pointerdown, so fire what a real click does. */
async function openVoiceMenu() {
  const trigger = screen.getByRole('button', { name: 'Voice' })

  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.click(trigger)

  return screen.findByRole('menu')
}

afterEach(() => {
  cleanup()
})

describe('ComposerControls shortcut tooltips', () => {
  it('shows Enter for Send', async () => {
    renderControls()

    await expectShortcutTooltip('Send', '↵')
  })

  it('shows Enter for Steer', async () => {
    renderControls({ busy: true, busyAction: 'steer' })

    await expectShortcutTooltip('Steer the current run', '↵')
  })

  it('shows Ctrl+Enter for Queue', async () => {
    renderControls({ busy: true, busyAction: 'queue' })

    await expectShortcutTooltip('Queue message', 'Ctrl+↵')
  })
})

describe('ComposerControls primary slot', () => {
  it('offers the microphone when the box is empty and the arrow once there is something to send', () => {
    renderControls({ hasComposerPayload: false })
    expect(screen.getByLabelText('Start voice conversation')).toBeTruthy()
    expect(screen.queryByLabelText('Send')).toBeNull()

    cleanup()
    renderControls({ hasComposerPayload: true })
    expect(screen.getByLabelText('Send')).toBeTruthy()
    expect(screen.queryByLabelText('Start voice conversation')).toBeNull()
  })
})

// The voice toggles (dictation · read replies aloud · the wake word) live
// behind ONE ⋯ menu while voice is enabled — the resting row is never a strip
// of crossed-out icons — and the menu is where the wake word stays reachable:
// a refused start puts its reason on the item instead of hiding the control.
describe('voice menu', () => {
  afterEach(() => {
    resetWakeWordState()
  })

  it('is not offered while voice is disabled in the composer state', () => {
    renderControls()

    expect(screen.queryByRole('button', { name: 'Voice' })).toBeNull()
  })

  it('stays mounted during a busy agent turn and lists the wake word as listening', async () => {
    applyWakeStatus({ available: true, enabled: true, listening: true, phrase: 'hey agentx' })
    renderControls({ busy: true, busyAction: 'stop', state: voiceState })

    await openVoiceMenu()

    expect(screen.getByRole('menuitemcheckbox', { name: /Wake word: "hey agentx" — listening/ })).toBeTruthy()
  })

  it('keeps the wake word reachable when a start was refused', async () => {
    applyWakeStatus({ available: true, enabled: true, listening: false, phrase: 'hey agentx' })
    // Transient refusal marks available false but the item stays.
    applyWakeStartResult({ hint: 'mic busy', reason: 'unavailable', started: false })
    renderControls({ state: voiceState })

    await openVoiceMenu()

    expect(screen.getByRole('menuitemcheckbox', { name: /Wake word: "hey agentx" — off/ })).toBeTruthy()
  })

  it('keeps the wake word reachable even when unavailable and not enabled', async () => {
    applyWakeStatus({ available: false, enabled: false, listening: false, phrase: 'hey agentx' })
    renderControls({ state: voiceState })

    await openVoiceMenu()

    // Always offered, so the user can click to enable; a failed start surfaces
    // its reason on the item rather than hiding the control.
    expect(screen.getByRole('menuitemcheckbox', { name: /Wake word: "hey agentx" — off/ })).toBeTruthy()
  })

  it('surfaces the backend refusal reason on the wake-word item', async () => {
    applyWakeStatus({ available: false, enabled: false, listening: false, phrase: 'hey agentx' })
    applyWakeStartResult({ hint: 'run `agentx tools` (Voice section)', reason: 'unavailable', started: false })
    renderControls({ state: voiceState })

    const menu = await openVoiceMenu()

    expect(menu.textContent).toContain('agentx tools')
  })

  it('lists dictation and read-aloud beside the wake word', async () => {
    renderControls({ state: voiceState })

    await openVoiceMenu()

    expect(screen.getByRole('menuitem', { name: 'Voice dictation' })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Read replies aloud' })).toBeTruthy()
  })

  it('swaps the menu for the stop control while a dictation is recording', () => {
    renderControls({ state: voiceState, voiceStatus: 'recording' })

    expect(screen.queryByRole('button', { name: 'Voice' })).toBeNull()
    expect(screen.getByLabelText('Stop dictation')).toBeTruthy()
  })

  it('shows a disabled paused ear inside the voice-conversation pill', () => {
    applyWakeStatus({ available: true, enabled: true, listening: true, phrase: 'hey agentx' })
    renderControls({
      conversation: {
        active: true,
        level: 0,
        muted: false,
        onEnd: vi.fn(),
        onStart: vi.fn(),
        onStopTurn: vi.fn(),
        onToggleMute: vi.fn(),
        status: 'listening'
      }
    })

    const ear = screen.getByLabelText('Wake word: "hey agentx" — paused during voice chat')
    expect((ear as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ComposerControls model pill', () => {
  it('hands the pill its concise voice outside a coding context', () => {
    renderControls({ conciseModelPill: true })

    expect(modelPillSpy).toHaveBeenLastCalledWith(expect.objectContaining({ compact: false, concise: true }))
  })

  it('keeps the full label inside a repo', () => {
    renderControls()

    expect(modelPillSpy).toHaveBeenLastCalledWith(expect.objectContaining({ concise: false }))
  })
})
