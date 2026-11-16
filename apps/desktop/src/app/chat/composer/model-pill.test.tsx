import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render as renderUi, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ChatBarState } from '@/app/chat/composer/types'
import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import {
  $activeSessionId,
  $currentModel,
  setCurrentFastMode,
  setCurrentModel,
  setCurrentModelSource,
  setCurrentReasoningEffort,
  setDefaultReasoningEffort
} from '@/store/session'

import { ModelPill } from './model-pill'

function render(element: ReactElement) {
  return renderUi(<QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>)
}

const modelState = (over: Partial<ChatBarState['model']> = {}): ChatBarState['model'] => ({
  canSwitch: true,
  model: 'gpt-6',
  provider: 'openai',
  ...over
})

afterEach(() => {
  cleanup()
  $activeSessionId.set(null)
  setCurrentModel('')
  setCurrentModelSource('')
  setCurrentReasoningEffort('')
  setCurrentFastMode(false)
  setDefaultReasoningEffort('')
})

// The level beside the name is its own quieter span; read the pill as a whole.
const pillText = () => screen.getByRole('button').textContent

// #62055: a manual composer pick is sticky and silently overrides the
// Settings → Model default for every NEW chat. The pill must say so.
describe('ModelPill pinned-override badge', () => {
  it('shows the pin dot on a draft running a manual pick', () => {
    setCurrentModel('deepseek/deepseek-v4-flash')
    setCurrentModelSource('manual')
    $activeSessionId.set(null)

    render(<ModelPill disabled={false} model={modelState({ model: 'deepseek/deepseek-v4-flash' })} />)

    expect(screen.getByTestId('model-pinned-dot')).toBeTruthy()
  })

  it('stays quiet when the composer reflects the profile default', () => {
    setCurrentModel('google/gemma-4-26b-a4b-it:free')
    setCurrentModelSource('default')
    $activeSessionId.set(null)

    render(<ModelPill disabled={false} model={modelState()} />)

    expect(screen.queryByTestId('model-pinned-dot')).toBeNull()
  })

  it('stays quiet on a live session (footer shows that session, not the pin)', () => {
    setCurrentModel('deepseek/deepseek-v4-flash')
    setCurrentModelSource('manual')
    $activeSessionId.set('live-1')

    render(<ModelPill disabled={false} model={modelState()} />)

    expect(screen.queryByTestId('model-pinned-dot')).toBeNull()
  })

  it('is exercised in both render paths', () => {
    setCurrentModel('deepseek/deepseek-v4-flash')
    setCurrentModelSource('manual')
    $activeSessionId.set(null)

    // Fallback (no live menu) path.
    const { unmount } = render(
      <ModelPill disabled={false} model={modelState({ model: 'deepseek/deepseek-v4-flash' })} />
    )

    expect(screen.getByTestId('model-pinned-dot')).toBeTruthy()
    unmount()

    // Live-menu (dropdown) path.
    render(
      <ModelPill
        disabled={false}
        model={modelState({ model: 'deepseek/deepseek-v4-flash', modelMenuContent: <div /> })}
      />
    )
    expect(screen.getByTestId('model-pinned-dot')).toBeTruthy()
    expect($currentModel.get()).toBe('deepseek/deepseek-v4-flash')
  })
})

describe('ModelPill per-surface model label', () => {
  it('shows the chat-bar model even when the primary global differs', () => {
    setCurrentModel('primary/model')
    $activeSessionId.set('primary-runtime')

    const tileView: SessionView = {
      kind: 'tile',
      $awaitingResponse: atom(false),
      $busy: atom(false),
      $cwd: atom(''),
      $fast: atom(false),
      $lastVisibleIsUser: atom(false),
      $messages: atom([]),
      $messagesEmpty: atom(true),
      $model: atom('tile/claude-sonnet'),
      $provider: atom('anthropic'),
      $reasoningEffort: atom('high'),
      $runtimeId: atom('tile-runtime'),
      $storedId: atom('stored-tile')
    }

    render(
      <SessionViewProvider value={tileView}>
        <ModelPill
          disabled={false}
          model={modelState({ model: 'tile/claude-sonnet', provider: 'anthropic', modelMenuContent: <div /> })}
        />
      </SessionViewProvider>
    )

    expect(pillText()).toBe('SonnetHigh')
    expect(screen.getByTestId('model-pill-level').textContent).toBe('High')
    expect(screen.queryByText(/primary/i)).toBeNull()
  })
})

// Like Claude's composer, the pill carries the thinking level beside the name.
// Outside a coding context (concise) the name is the short one and the level
// only shows once it differs from the default, so the everyday case reads as
// just the model.
describe('ModelPill label', () => {
  it('concise: the short name alone while on the default level', () => {
    render(<ModelPill concise disabled={false} model={modelState({ model: 'Qwen3.5 122B A10B FP8' })} />)

    expect(pillText()).toBe('Qwen3.5')
    expect(screen.queryByTestId('model-pill-level')).toBeNull()
  })

  it('concise: a level you changed is shown', () => {
    setCurrentReasoningEffort('high')

    render(<ModelPill concise disabled={false} model={modelState({ model: 'Qwen3.5 122B A10B FP8' })} />)

    expect(screen.getByTestId('model-pill-level').textContent).toBe('High')
  })

  it('concise: the default is the profile default, not the built-in medium', () => {
    setDefaultReasoningEffort('high')
    setCurrentReasoningEffort('high')

    render(<ModelPill concise disabled={false} model={modelState({ model: 'Qwen3.5 122B A10B FP8' })} />)

    expect(screen.queryByTestId('model-pill-level')).toBeNull()
  })

  it('says thinking is off in words, not a bare "Off"', () => {
    setCurrentReasoningEffort('none')

    render(<ModelPill concise disabled={false} model={modelState({ model: 'Qwen3.5 122B A10B FP8' })} />)

    expect(screen.getByTestId('model-pill-level').textContent).toBe('No thinking')
  })

  it('full: the full name with the level, default included', () => {
    render(<ModelPill disabled={false} model={modelState({ model: 'Qwen3.5 122B A10B FP8' })} />)

    expect(pillText()).toBe('Qwen3.5 122B A10B FP8Medium')
  })

  it('marks fast mode with a glyph, for the speed param and for a -fast variant alike', () => {
    setCurrentFastMode(true)

    const { unmount } = render(<ModelPill concise disabled={false} model={modelState({ model: 'openai/gpt-5.5' })} />)

    expect(screen.getByRole('img', { name: 'Priority speed' })).toBeTruthy()
    unmount()
    setCurrentFastMode(false)

    render(<ModelPill concise disabled={false} model={modelState({ model: 'anthropic/claude-opus-4.8-fast' })} />)

    expect(pillText()).toBe('Opus 4.8')
    expect(screen.getByRole('img', { name: 'Priority speed' })).toBeTruthy()
  })
})

// Docked, the pill is a line of text in the strip under the composer — name,
// then the level in a quieter ink, no chevron (Claude's context bar). Floating,
// it is the compact chevron in the control row and says nothing more.
describe('ModelPill placements', () => {
  it('under the composer: the name and the level, no chevron glyph', () => {
    setCurrentReasoningEffort('high')

    render(<ModelPill disabled={false} model={modelState({ model: 'MiniMax-M3', modelMenuContent: <div /> })} />)

    const trigger = screen.getByRole('button')

    expect(trigger.textContent).toBe('MiniMax M3High')
    expect(trigger.querySelector('svg')).toBeNull()
  })

  it('floating: just the chevron, with the model in its accessible name', () => {
    render(
      <ModelPill compact disabled={false} model={modelState({ model: 'MiniMax-M3', modelMenuContent: <div /> })} />
    )

    const trigger = screen.getByRole('button')

    expect(trigger.textContent).toBe('')
    expect(trigger.querySelector('svg')).not.toBeNull()
    expect(trigger.getAttribute('aria-label')).toContain('MiniMax-M3')
  })
})
