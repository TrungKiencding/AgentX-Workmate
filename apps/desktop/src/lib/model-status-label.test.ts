import { describe, expect, it } from 'vitest'

import { conciseModelName, currentPickerSelection, displayModelName, modelDisplayParts } from './model-status-label'
import { reasoningEffortLabel } from './reasoning-effort'

describe('model-status-label', () => {
  it('formats display names consistently', () => {
    expect(displayModelName('anthropic/claude-opus-4.8-fast')).toBe('Opus 4.8')
    expect(displayModelName('openai/gpt-5.5-fast')).toBe('GPT-5.5')
    expect(displayModelName('deepseek/deepseek-v4-pro-thinking')).toBe('Deepseek V4 Pro')
    expect(displayModelName('openai/gpt-5.5')).toBe('GPT-5.5')
  })

  it('strips trailing date-pin snapshots from the display name', () => {
    expect(displayModelName('claude-opus-4-5-20251101')).toBe('Opus 4 5')
    expect(displayModelName('anthropic/claude-haiku-4-5-20251001')).toBe('Haiku 4 5')
  })

  it('maps reasoning effort to compact labels', () => {
    expect(reasoningEffortLabel('high')).toBe('High')
    expect(reasoningEffortLabel('xhigh')).toBe('XHigh')
    expect(reasoningEffortLabel('max')).toBe('Max')
    expect(reasoningEffortLabel('ultra')).toBe('Ultra')
    expect(reasoningEffortLabel('')).toBe('')
  })

  it('title-cases Gemini names and keeps the variant as a separate tag', () => {
    expect(displayModelName('google/gemini-3-pro')).toBe('Gemini 3 Pro')
    expect(modelDisplayParts('google/gemini-3-pro-preview')).toEqual({ name: 'Gemini 3 Pro', tag: 'Preview' })
  })

  describe('currentPickerSelection', () => {
    const store = { model: 'opus', provider: 'anthropic' }
    const options = { model: 'hermes-4', provider: 'nous' }

    it('prefers the sticky composer pick over the profile default pre-session', () => {
      expect(currentPickerSelection(store, options)).toEqual(store)
    })

    it('keeps the SessionView selection when a stale options response disagrees', () => {
      expect(currentPickerSelection(store, options)).toEqual(store)
    })

    it('falls back to options when the store is empty', () => {
      expect(currentPickerSelection({ model: '', provider: '' }, options)).toEqual(options)
    })

    it('uses the complete options pair instead of mixing a partial store selection', () => {
      expect(currentPickerSelection({ model: 'opus', provider: '' }, options)).toEqual(options)
    })

    it('falls back to the store while options are still loading', () => {
      expect(currentPickerSelection(store, undefined)).toEqual(store)
    })
  })
})

describe('conciseModelName', () => {
  it('keeps the family and version, drops the build', () => {
    expect(conciseModelName('Qwen3.5 122B A10B FP8')).toBe('Qwen3.5')
    expect(conciseModelName('meta/llama-3.3-70b-instruct')).toBe('Llama 3.3')
    expect(conciseModelName('qwen2.5-coder-32b-instruct-q4_k_m')).toBe('Qwen2.5 Coder')
    expect(conciseModelName('google/gemma-4-26b-a4b-it:free')).toBe('Gemma 4')
    expect(conciseModelName('mistral-small-3.1-24b-instruct-2503')).toBe('Mistral Small 3.1 2503')
  })

  it('leaves names that carry no build words alone', () => {
    expect(conciseModelName('anthropic/claude-opus-4.8')).toBe('Opus 4.8')
    expect(conciseModelName('openai/gpt-5.5')).toBe('GPT-5.5')
    expect(conciseModelName('deepseek/deepseek-v4-pro-thinking')).toBe('Deepseek V4 Pro')
  })

  it('never carries session state', () => {
    // No " · Med" / " · Fast" suffix — the pill renders the level itself.
    expect(conciseModelName('openai/gpt-5.5')).not.toContain('·')
  })

  it('falls back to the full name when only build words remain', () => {
    expect(conciseModelName('7b-instruct')).toBe('7b Instruct')
    expect(conciseModelName('')).toBe('No model')
  })
})
