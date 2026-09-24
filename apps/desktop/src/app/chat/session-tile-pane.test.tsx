import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'
import { setGatewayState } from '@/store/session'
import { $sessionTiles } from '@/store/session-states'

import { SessionTilePane } from './session-tile'

// The tile's chat surface never mounts on the error card; stubbing ChatView
// keeps this file off the whole thread/composer module graph.
vi.mock('./index', () => ({ ChatView: () => null }))

const STORED = 'stored-1'

beforeEach(() => {
  // Not open: an open gateway clears a latched error and retries the bind.
  setGatewayState('idle')
  $sessionTiles.set([{ error: 'backend unavailable', storedSessionId: STORED }])
})

afterEach(() => {
  cleanup()
  $sessionTiles.set([])
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

describe('a tile that could not bind its session', () => {
  it('explains itself in the app language, with the copy the main chat uses', () => {
    setRuntimeI18nLocale('vi')

    render(<SessionTilePane storedSessionId={STORED} />)

    expect(screen.getByText('Không tải được cuộc trò chuyện này')).toBeTruthy()
    expect(screen.getByText('backend unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy()
  })

  it('retry clears the error so the binding runs again', () => {
    render(<SessionTilePane storedSessionId={STORED} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect($sessionTiles.get().find(t => t.storedSessionId === STORED)?.error).toBeUndefined()
  })
})
