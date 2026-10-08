import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'

import { useComposerPlaceholder } from './use-composer-placeholder'

describe('useComposerPlaceholder', () => {
  it('says the composer is read-only, not that AgentX is starting', () => {
    // "Starting AgentX..." would promise a wait that never ends.
    for (const reconnecting of [false, true]) {
      const { result } = renderHook(() =>
        useComposerPlaceholder({ disabled: true, readOnly: true, reconnecting, sessionId: 's1' })
      )

      expect(result.current).toBe(en.composer.placeholderReadOnly)
    }
  })

  it('keeps the transport placeholders when the license is not the reason', () => {
    const starting = renderHook(() => useComposerPlaceholder({ disabled: true, reconnecting: false, sessionId: 's1' }))

    const reconnecting = renderHook(() =>
      useComposerPlaceholder({ disabled: true, reconnecting: true, sessionId: 's1' })
    )

    expect(starting.result.current).toBe(en.composer.placeholderStarting)
    expect(reconnecting.result.current).toBe(en.composer.placeholderReconnecting)
  })

  it('rests on a starter or a follow-up when nothing is in the way', () => {
    const { result } = renderHook(() =>
      useComposerPlaceholder({ disabled: false, readOnly: false, reconnecting: false, sessionId: 's1' })
    )

    expect(en.composer.followUpPlaceholders).toContain(result.current)
  })
})
